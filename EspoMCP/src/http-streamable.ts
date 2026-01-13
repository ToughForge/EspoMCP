/**
 * MCP Streamable HTTP Transport Implementation
 *
 * Implements the MCP Streamable HTTP transport specification:
 * - POST /mcp - Client-to-server JSON-RPC messages (with SSE response option)
 * - GET /mcp - Server-to-client SSE stream for server-initiated messages
 * - DELETE /mcp - Session termination
 *
 * API Key is passed via x-api-key header and stored per-session.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { EspoCRMClient } from "./espocrm/client.js";
import { MetadataService } from "./metadata/service.js";
import { DynamicToolGenerator } from "./tools/generator.js";
import { DynamicToolHandler } from "./tools/handler.js";
import { MCPToolDefinition } from "./metadata/types.js";
import { loadConfig, validateConfiguration } from "./config/index.js";
import logger from "./utils/logger.js";

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// Session management - now includes API key and per-session tools
interface Session {
  id: string;
  apiKey: string;
  createdAt: Date;
  lastActivity: Date;
  initialized: boolean;
  client: EspoCRMClient;
  metadataService: MetadataService;
  toolHandler: DynamicToolHandler;
  tools: MCPToolDefinition[];
}

const sessions = new Map<string, Session>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// SSE connections for GET streams
interface SSEConnection {
  res: Response;
  sessionId: string;
  eventId: number;
}

const sseConnections = new Map<string, SSEConnection[]>();

// Base URL from config (loaded once at startup)
let espoBaseUrl: string = '';

// Utility tools that don't require dynamic generation
const UTILITY_TOOLS: MCPToolDefinition[] = [
  {
    name: "health_check",
    description: "Check EspoCRM connection and API status",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "link_entities",
    description: "Create relationships between any two entities",
    inputSchema: {
      type: "object",
      properties: {
        entityType: { type: "string", description: "The main entity type" },
        entityId: { type: "string", description: "ID of the main entity" },
        relationshipName: { type: "string", description: "Name of the relationship" },
        relatedEntityIds: { type: "array", items: { type: "string" }, description: "Array of related entity IDs" },
      },
      required: ["entityType", "entityId", "relationshipName", "relatedEntityIds"],
    },
  },
  {
    name: "unlink_entities",
    description: "Remove relationships between entities",
    inputSchema: {
      type: "object",
      properties: {
        entityType: { type: "string", description: "The main entity type" },
        entityId: { type: "string", description: "ID of the main entity" },
        relationshipName: { type: "string", description: "Name of the relationship" },
        relatedEntityIds: { type: "array", items: { type: "string" }, description: "Array of related entity IDs" },
      },
      required: ["entityType", "entityId", "relationshipName", "relatedEntityIds"],
    },
  },
  {
    name: "get_entity_relationships",
    description: "Get all related entities for a specific entity and relationship",
    inputSchema: {
      type: "object",
      properties: {
        entityType: { type: "string", description: "The main entity type" },
        entityId: { type: "string", description: "ID of the main entity" },
        relationshipName: { type: "string", description: "Name of the relationship" },
        limit: { type: "integer", description: "Maximum results", default: 50 },
        offset: { type: "integer", description: "Records to skip", default: 0 },
        select: { type: "array", items: { type: "string" }, description: "Fields to include" },
      },
      required: ["entityType", "entityId", "relationshipName"],
    },
  },
];

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return randomUUID();
}

/**
 * Generate a unique event ID for SSE
 */
function generateEventId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      sessions.delete(sessionId);
      const connections = sseConnections.get(sessionId);
      if (connections) {
        connections.forEach(conn => {
          try { conn.res.end(); } catch { /* already closed */ }
        });
        sseConnections.delete(sessionId);
      }
      logger.debug('Session expired and cleaned up', { sessionId });
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

/**
 * Create a new session with the provided API key.
 * Initializes the EspoCRM client, fetches metadata, and generates tools.
 */
async function createSession(apiKey: string): Promise<Session> {
  const sessionId = generateSessionId();

  // Create client with the provided API key
  const client = new EspoCRMClient({
    baseUrl: espoBaseUrl,
    apiKey: apiKey,
    authMethod: 'apikey',
  });

  // Test connection
  const connectionTest = await client.testConnection();
  if (!connectionTest.success) {
    throw new Error("Failed to connect to EspoCRM. Check your API key.");
  }

  // Initialize metadata service and generate tools
  const metadataService = new MetadataService(client);
  await metadataService.initialize();

  const toolGenerator = new DynamicToolGenerator(metadataService);
  const dynamicTools = toolGenerator.generateAllTools();
  const allTools = [...dynamicTools, ...UTILITY_TOOLS];

  const toolHandler = new DynamicToolHandler(client, metadataService);

  const session: Session = {
    id: sessionId,
    apiKey,
    createdAt: new Date(),
    lastActivity: new Date(),
    initialized: false,
    client,
    metadataService,
    toolHandler,
    tools: allTools,
  };

  sessions.set(sessionId, session);
  logger.info('New session created', { sessionId, toolCount: allTools.length });

  return session;
}

/**
 * Check if the message is a notification (no id field)
 */
function isNotification(msg: JsonRpcRequest | JsonRpcNotification): msg is JsonRpcNotification {
  return !('id' in msg) || msg.id === undefined;
}

/**
 * Check if the request is an initialization request
 */
function isInitializeRequest(req: JsonRpcRequest): boolean {
  return req.method === 'initialize';
}

/**
 * Handle a single JSON-RPC request
 */
async function handleSingleRequest(
  req: JsonRpcRequest,
  session: Session | null
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // Notifications don't get responses
  if (id === undefined) {
    if (method === 'notifications/initialized' && session) {
      session.initialized = true;
      logger.debug('Session initialized', { sessionId: session.id });
    }
    return null;
  }

  try {
    let result: unknown;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "EspoCRM Integration Server", version: "1.0.0" }
        };
        break;

      case 'tools/list':
        if (!session) {
          throw new Error("Session not initialized");
        }
        result = { tools: session.tools };
        break;

      case 'tools/call':
        if (!session) {
          throw new Error("Session not initialized");
        }
        result = await handleToolCall(session, params || {});
        break;

      case 'ping':
        result = {};
        break;

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }

    return { jsonrpc: "2.0", id, result };

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error("JSON-RPC handler error", { method, error: errorMessage });
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: errorMessage }
    };
  }
}

/**
 * Handle tool call using session's handler
 */
async function handleToolCall(
  session: Session,
  params: Record<string, unknown>
): Promise<unknown> {
  const name = params.name as string;
  const args = (params.arguments || {}) as Record<string, unknown>;

  // Check if it's a dynamic tool
  if (session.toolHandler.isDynamicTool(name)) {
    return await session.toolHandler.handleTool(name, args);
  }

  // Handle utility tools
  switch (name) {
    case "health_check": {
      const test = await session.client.testConnection();
      return {
        content: [{
          type: "text",
          text: `EspoCRM connection healthy\nServer version: ${test.version || 'Unknown'}\nUser: ${test.user?.userName || 'Unknown'}`
        }]
      };
    }

    case "link_entities": {
      await session.client.linkRecords(
        args.entityType as string,
        args.entityId as string,
        args.relationshipName as string,
        args.relatedEntityIds as string[]
      );
      return {
        content: [{ type: "text", text: `Successfully linked entities` }]
      };
    }

    case "unlink_entities": {
      await session.client.unlinkRecords(
        args.entityType as string,
        args.entityId as string,
        args.relationshipName as string,
        args.relatedEntityIds as string[]
      );
      return {
        content: [{ type: "text", text: `Successfully unlinked entities` }]
      };
    }

    case "get_entity_relationships": {
      const related = await session.client.getRelated(
        args.entityType as string,
        args.entityId as string,
        args.relationshipName as string,
        {
          maxSize: (args.limit as number) || 50,
          offset: (args.offset as number) || 0,
          select: args.select as string[] | undefined,
        }
      );
      return {
        content: [{
          type: "text",
          text: `Found ${related?.list?.length || 0} related entities`
        }]
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

/**
 * Send SSE event
 */
function sendSSEEvent(res: Response, eventId: string, data: unknown): void {
  res.write(`id: ${eventId}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Creates an Express app with Streamable HTTP MCP endpoints.
 */
export function createStreamableHttpApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'espocrm-mcp-server',
      transport: 'streamable-http',
      activeSessions: sessions.size
    });
  });

  // MCP Streamable HTTP endpoint - POST (client-to-server messages)
  app.post('/mcp', async (req: Request, res: Response) => {
    const acceptHeader = req.headers.accept || '';
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const apiKey = req.headers['x-api-key'] as string | undefined;

    // Validate Accept header
    if (!acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream')) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Accept header must include application/json and/or text/event-stream" }
      });
      return;
    }

    const body = req.body;
    const messages: JsonRpcRequest[] = Array.isArray(body) ? body : [body];
    const hasInitialize = messages.some(msg => isInitializeRequest(msg));

    let session: Session | null = null;

    if (hasInitialize) {
      // Create new session - API key required
      if (!apiKey) {
        res.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Missing x-api-key header for initialization" }
        });
        return;
      }

      try {
        session = await createSession(apiKey);
      } catch (error: any) {
        res.status(401).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: `Failed to initialize: ${error.message}` }
        });
        return;
      }
    } else if (sessionId) {
      session = sessions.get(sessionId) || null;
      if (!session) {
        res.status(404).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Session not found or expired" }
        });
        return;
      }
      session.lastActivity = new Date();
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Missing Mcp-Session-Id header" }
      });
      return;
    }

    // Process messages
    const responses: JsonRpcResponse[] = [];
    let hasRequests = false;

    for (const msg of messages) {
      if (!isNotification(msg)) {
        hasRequests = true;
      }
      const response = await handleSingleRequest(msg, session);
      if (response) {
        responses.push(response);
      }
    }

    // If only notifications, return 202 Accepted
    if (!hasRequests) {
      res.status(202);
      if (session && hasInitialize) {
        res.setHeader('Mcp-Session-Id', session.id);
      }
      res.end();
      return;
    }

    // Determine response format
    const preferSSE = acceptHeader.includes('text/event-stream');

    if (preferSSE && responses.length > 0) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (session && hasInitialize) {
        res.setHeader('Mcp-Session-Id', session.id);
      }
      for (const response of responses) {
        sendSSEEvent(res, generateEventId(), response);
      }
      res.end();
    } else {
      res.setHeader('Content-Type', 'application/json');
      if (session && hasInitialize) {
        res.setHeader('Mcp-Session-Id', session.id);
      }
      res.json(responses.length === 1 ? responses[0] : responses);
    }
  });

  // MCP Streamable HTTP endpoint - GET (server-to-client SSE stream)
  app.get('/mcp', (req: Request, res: Response) => {
    const acceptHeader = req.headers.accept || '';
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!acceptHeader.includes('text/event-stream')) {
      res.status(400).json({ error: "Accept header must include text/event-stream" });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ error: "Missing Mcp-Session-Id header" });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }

    session.lastActivity = new Date();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const connection: SSEConnection = { res, sessionId, eventId: 0 };
    if (!sseConnections.has(sessionId)) {
      sseConnections.set(sessionId, []);
    }
    sseConnections.get(sessionId)!.push(connection);

    res.write(': connected\n\n');

    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const connections = sseConnections.get(sessionId);
      if (connections) {
        const index = connections.indexOf(connection);
        if (index > -1) connections.splice(index, 1);
        if (connections.length === 0) sseConnections.delete(sessionId);
      }
    });
  });

  // MCP Streamable HTTP endpoint - DELETE (session termination)
  app.delete('/mcp', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: "Missing Mcp-Session-Id header" });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }

    const connections = sseConnections.get(sessionId);
    if (connections) {
      connections.forEach(conn => { try { conn.res.end(); } catch { /* */ } });
      sseConnections.delete(sessionId);
    }

    sessions.delete(sessionId);
    logger.info('Session terminated', { sessionId });
    res.status(202).end();
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Express error", { error: err.message });
    res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error" }
    });
  });

  return app;
}

/**
 * Starts the Streamable HTTP server.
 */
export async function startStreamableHttpServer(port: number = 3000): Promise<void> {
  // Validate configuration (API key no longer required)
  const configErrors = validateConfiguration();
  // Filter out API key errors since it's now passed per-request
  const relevantErrors = configErrors.filter(e => !e.includes('API key'));

  if (relevantErrors.length > 0) {
    logger.error('Configuration validation failed', { errors: relevantErrors });
    console.error('Configuration errors:');
    relevantErrors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  // Load configuration to get base URL
  const config = loadConfig();
  espoBaseUrl = config.espocrm.baseUrl;

  logger.info('Configuration loaded', { espoUrl: espoBaseUrl });

  // Create and start HTTP server
  const app = createStreamableHttpApp();

  app.listen(port, () => {
    logger.info(`EspoMCP Streamable HTTP server listening on port ${port}`);
    console.log(`EspoCRM MCP Server (Streamable HTTP) running at http://localhost:${port}/mcp`);
    console.log(`API Key must be provided via x-api-key header on initialization`);
  });
}
