/**
 * MCP Streamable HTTP Transport Implementation
 *
 * Implements the MCP Streamable HTTP transport specification:
 * - POST /mcp - Client-to-server JSON-RPC messages (with SSE response option)
 * - GET /mcp - Server-to-client SSE stream for server-initiated messages
 * - DELETE /mcp - Session termination
 *
 * API Key is passed via x-api-key header on EVERY request. Stateless design.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import express, { Request, Response, NextFunction } from 'express';
import { EspoCRMClient } from "./espocrm/client.js";
import { MetadataService } from "./metadata/service.js";
import { DynamicToolGenerator } from "./tools/generator.js";
import { DynamicToolHandler } from "./tools/handler.js";
import { MCPToolDefinition } from "./metadata/types.js";
import { loadConfig } from "./config/index.js";
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

// Base URL from config (loaded once at startup)
let espoBaseUrl: string = '';

// Cache for metadata/tools per API key to avoid re-fetching on every request
interface CachedClient {
  client: EspoCRMClient;
  metadataService: MetadataService;
  toolHandler: DynamicToolHandler;
  tools: MCPToolDefinition[];
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
 * Clean up expired cache entries
 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [key, cached] of clientCache.entries()) {
    if (now - cached.lastUsed > CACHE_TTL_MS) {
      clientCache.delete(key);
      logger.debug('Cache entry expired', { apiKeyPrefix: key.substring(0, 8) });
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * Get or create a cached client for the given API key.
 */
async function getOrCreateClient(apiKey: string): Promise<CachedClient> {
  // Check cache first
  const cached = clientCache.get(apiKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }

  // Create new client
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

  const cachedClient: CachedClient = {
    client,
    metadataService,
    toolHandler,
    tools: allTools,
    lastUsed: Date.now(),
  };

  clientCache.set(apiKey, cachedClient);
  logger.info('New client created and cached', { toolCount: allTools.length });

  return cachedClient;
}

/**
 * Handle a single JSON-RPC request
 */
async function handleRequest(
  req: JsonRpcRequest,
  cachedClient: CachedClient
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  // Notifications don't get responses
  if (id === undefined) {
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
        result = { tools: cachedClient.tools };
        break;

      case 'tools/call':
        result = await handleToolCall(cachedClient, params || {});
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
 * Handle tool call
 */
async function handleToolCall(
  cachedClient: CachedClient,
  params: Record<string, unknown>
): Promise<unknown> {
  const name = params.name as string;
  const args = (params.arguments || {}) as Record<string, unknown>;

  // Check if it's a dynamic tool
  if (cachedClient.toolHandler.isDynamicTool(name)) {
    return await cachedClient.toolHandler.handleTool(name, args);
  }

  // Handle utility tools
  switch (name) {
    case "health_check": {
      const test = await cachedClient.client.testConnection();
      return {
        content: [{
          type: "text",
          text: `EspoCRM connection healthy\nServer version: ${test.version || 'Unknown'}\nUser: ${test.user?.userName || 'Unknown'}`
        }]
      };
    }

    case "link_entities": {
      await cachedClient.client.linkRecords(
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
      await cachedClient.client.unlinkRecords(
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
      const related = await cachedClient.client.getRelated(
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
 * Creates an Express app with Streamable HTTP MCP endpoints.
 */
export function createStreamableHttpApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Health check endpoint (no auth required)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'espocrm-mcp-server',
      transport: 'streamable-http',
      cachedClients: clientCache.size
    });
  });

  // MCP Streamable HTTP endpoint - POST
  app.post('/mcp', async (req: Request, res: Response) => {
    const acceptHeader = req.headers.accept || '';
    const apiKey = req.headers['x-api-key'] as string | undefined;

    // Require API key on every request
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Missing x-api-key header" }
      });
      return;
    }

    // Validate Accept header
    if (!acceptHeader.includes('application/json') && !acceptHeader.includes('text/event-stream')) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Accept header must include application/json and/or text/event-stream" }
      });
      return;
    }

    // Get or create client for this API key
    let cachedClient: CachedClient;
    try {
      cachedClient = await getOrCreateClient(apiKey);
    } catch (error: any) {
      res.status(401).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `Authentication failed: ${error.message}` }
      });
      return;
    }

    const body = req.body;
    const messages: JsonRpcRequest[] = Array.isArray(body) ? body : [body];

    // Process messages
    const responses: JsonRpcResponse[] = [];

    for (const msg of messages) {
      const response = await handleRequest(msg, cachedClient);
      if (response) {
        responses.push(response);
      }
    }

    // If no responses (all notifications), return 202
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }

    // Determine response format
    const preferSSE = acceptHeader.includes('text/event-stream');

    if (preferSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const response of responses) {
        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }
      res.end();
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.json(responses.length === 1 ? responses[0] : responses);
    }
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
  // Load configuration to get base URL
  const config = loadConfig();
  espoBaseUrl = config.espocrm.baseUrl;

  if (!espoBaseUrl) {
    console.error('ESPOCRM_URL environment variable is required');
    process.exit(1);
  }

  logger.info('Configuration loaded', { espoUrl: espoBaseUrl });

  // Create and start HTTP server
  const app = createStreamableHttpApp();

  app.listen(port, () => {
    logger.info(`EspoMCP Streamable HTTP server listening on port ${port}`);
    console.log(`EspoCRM MCP Server (Streamable HTTP) running at http://localhost:${port}/mcp`);
    console.log(`API Key must be provided via x-api-key header on every request`);
  });
}
