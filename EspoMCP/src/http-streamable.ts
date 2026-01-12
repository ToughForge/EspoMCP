/**
 * MCP Streamable HTTP Transport Implementation
 *
 * Implements the MCP Streamable HTTP transport specification:
 * - POST /mcp - Client-to-server JSON-RPC messages (with SSE response option)
 * - GET /mcp - Server-to-client SSE stream for server-initiated messages
 * - DELETE /mcp - Session termination
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfiguration } from "./config/index.js";
import { setupEspoCRMTools } from "./tools/index.js";
import logger from "./utils/logger.js";
import { Config } from "./types.js";

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

// Session management
interface Session {
  id: string;
  createdAt: Date;
  lastActivity: Date;
  initialized: boolean;
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

// Request handlers stored after server setup
type RequestHandler = (request: { params: Record<string, unknown> }) => Promise<unknown>;
let toolsListHandler: RequestHandler | null = null;
let toolCallHandler: RequestHandler | null = null;

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
      // Close any SSE connections for this session
      const connections = sseConnections.get(sessionId);
      if (connections) {
        connections.forEach(conn => {
          try {
            conn.res.end();
          } catch {
            // Connection already closed
          }
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
 * Creates and configures the MCP server with tools.
 */
export async function createMCPServer(config: Config): Promise<Server> {
  const server = new Server(
    { name: "EspoCRM Integration Server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Capture request handlers for HTTP routing
  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  server.setRequestHandler = ((schema: unknown, handler: unknown) => {
    if (schema === ListToolsRequestSchema) {
      toolsListHandler = handler as RequestHandler;
    } else if (schema === CallToolRequestSchema) {
      toolCallHandler = handler as RequestHandler;
    }
    return originalSetRequestHandler(schema as Parameters<typeof originalSetRequestHandler>[0], handler as Parameters<typeof originalSetRequestHandler>[1]);
  }) as typeof server.setRequestHandler;

  await setupEspoCRMTools(server, config);

  return server;
}

/**
 * Check if the request is an initialization request
 */
function isInitializeRequest(req: JsonRpcRequest): boolean {
  return req.method === 'initialize';
}

/**
 * Check if the message is a notification (no id field)
 */
function isNotification(msg: JsonRpcRequest | JsonRpcNotification): msg is JsonRpcNotification {
  return !('id' in msg) || msg.id === undefined;
}

/**
 * Handle a single JSON-RPC request
 */
async function handleSingleRequest(req: JsonRpcRequest, session: Session | null): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // Notifications don't get responses
  if (id === undefined) {
    // Handle notification
    if (method === 'notifications/initialized') {
      if (session) {
        session.initialized = true;
        logger.debug('Session initialized', { sessionId: session.id });
      }
    }
    return null;
  }

  try {
    let result: unknown;

    switch (method) {
      case 'initialize':
        // Return server capabilities
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "EspoCRM Integration Server",
            version: "1.0.0"
          }
        };
        break;

      case 'tools/list':
        if (!toolsListHandler) {
          throw new Error("Server not initialized");
        }
        result = await toolsListHandler({ params: params || {} });
        break;

      case 'tools/call':
        if (!toolCallHandler) {
          throw new Error("Server not initialized");
        }
        result = await toolCallHandler({ params: params || {} });
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
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error("JSON-RPC handler error", { method, error: errorMessage });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: errorMessage,
        data: { stack: errorStack }
      }
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

  // Parse JSON bodies
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

    // Check if this is an initialization request
    const hasInitialize = messages.some(msg => isInitializeRequest(msg));

    let session: Session | null = null;

    if (hasInitialize) {
      // Create new session
      const newSessionId = generateSessionId();
      session = {
        id: newSessionId,
        createdAt: new Date(),
        lastActivity: new Date(),
        initialized: false
      };
      sessions.set(newSessionId, session);
      logger.info('New session created', { sessionId: newSessionId });
    } else if (sessionId) {
      // Validate existing session
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
      // No session ID and not initializing - error
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

    // If only notifications/responses were sent, return 202 Accepted
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
      // SSE response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (session && hasInitialize) {
        res.setHeader('Mcp-Session-Id', session.id);
      }

      // Send each response as an SSE event
      for (const response of responses) {
        const eventId = generateEventId();
        sendSSEEvent(res, eventId, response);
      }

      // Close the stream after sending all responses
      res.end();

    } else {
      // JSON response
      res.setHeader('Content-Type', 'application/json');
      if (session && hasInitialize) {
        res.setHeader('Mcp-Session-Id', session.id);
      }

      if (responses.length === 1) {
        res.json(responses[0]);
      } else {
        res.json(responses);
      }
    }
  });

  // MCP Streamable HTTP endpoint - GET (server-to-client SSE stream)
  app.get('/mcp', (req: Request, res: Response) => {
    const acceptHeader = req.headers.accept || '';
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Validate Accept header
    if (!acceptHeader.includes('text/event-stream')) {
      res.status(400).json({
        error: "Accept header must include text/event-stream"
      });
      return;
    }

    // Validate session
    if (!sessionId) {
      res.status(400).json({
        error: "Missing Mcp-Session-Id header"
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: "Session not found or expired"
      });
      return;
    }

    session.lastActivity = new Date();

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Store connection
    const connection: SSEConnection = {
      res,
      sessionId,
      eventId: 0
    };

    if (!sseConnections.has(sessionId)) {
      sseConnections.set(sessionId, []);
    }
    sseConnections.get(sessionId)!.push(connection);

    logger.debug('SSE connection opened', { sessionId });

    // Send initial comment to establish connection
    res.write(': connected\n\n');

    // Handle client disconnect
    req.on('close', () => {
      const connections = sseConnections.get(sessionId);
      if (connections) {
        const index = connections.indexOf(connection);
        if (index > -1) {
          connections.splice(index, 1);
        }
        if (connections.length === 0) {
          sseConnections.delete(sessionId);
        }
      }
      logger.debug('SSE connection closed', { sessionId });
    });

    // Keep connection alive with periodic comments
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(keepAlive);
    });
  });

  // MCP Streamable HTTP endpoint - DELETE (session termination)
  app.delete('/mcp', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({
        error: "Missing Mcp-Session-Id header"
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: "Session not found or expired"
      });
      return;
    }

    // Close any SSE connections
    const connections = sseConnections.get(sessionId);
    if (connections) {
      connections.forEach(conn => {
        try {
          conn.res.end();
        } catch {
          // Connection already closed
        }
      });
      sseConnections.delete(sessionId);
    }

    // Delete session
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
    logger.error("Express error", { error: err.message, stack: err.stack });
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
  // Validate configuration
  const configErrors = validateConfiguration();
  if (configErrors.length > 0) {
    logger.error('Configuration validation failed', { errors: configErrors });
    console.error('Configuration errors:');
    configErrors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  // Load configuration
  const config = loadConfig();
  logger.info('Configuration loaded', {
    espoUrl: config.espocrm.baseUrl,
    authMethod: config.espocrm.authMethod
  });

  // Create MCP server (this registers handlers)
  await createMCPServer(config);
  logger.info('MCP server initialized');

  // Create and start HTTP server
  const app = createStreamableHttpApp();

  app.listen(port, () => {
    logger.info(`EspoMCP Streamable HTTP server listening on port ${port}`);
    console.log(`EspoCRM MCP Server (Streamable HTTP) running at http://localhost:${port}/mcp`);
  });
}
