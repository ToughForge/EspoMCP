/**
 * HTTP transport adapter for the EspoMCP server.
 *
 * This module wraps the MCP server with an Express HTTP server that accepts
 * JSON-RPC requests at POST /mcp, making it compatible with HTTP-based MCP
 * clients like ToolChest.
 *
 * JSON-RPC Protocol:
 * - Request: { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
 * - Response: { "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } }
 */

import express, { Request, Response, NextFunction } from 'express';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, validateConfiguration } from "./config/index.js";
import { setupEspoCRMTools } from "./tools/index.js";
import logger from "./utils/logger.js";
import { Config } from "./types.js";

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Request handlers stored after server setup
type RequestHandler = (request: any) => Promise<any>;
let toolsListHandler: RequestHandler | null = null;
let toolCallHandler: RequestHandler | null = null;

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
  server.setRequestHandler = ((schema: any, handler: RequestHandler) => {
    if (schema === ListToolsRequestSchema) {
      toolsListHandler = handler;
    } else if (schema === CallToolRequestSchema) {
      toolCallHandler = handler;
    }
    return originalSetRequestHandler(schema, handler);
  }) as typeof server.setRequestHandler;

  await setupEspoCRMTools(server, config);

  return server;
}

/**
 * Handles incoming JSON-RPC requests and routes to MCP handlers.
 */
async function handleJsonRpcRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { jsonrpc, id, method, params } = req;

  // Validate JSON-RPC version
  if (jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" }
    };
  }

  try {
    let result: any;

    switch (method) {
      case "tools/list":
        if (!toolsListHandler) {
          throw new Error("Server not initialized");
        }
        result = await toolsListHandler({ params: params || {} });
        break;

      case "tools/call":
        if (!toolCallHandler) {
          throw new Error("Server not initialized");
        }
        result = await toolCallHandler({ params: params || {} });
        break;

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }

    return { jsonrpc: "2.0", id, result };

  } catch (error: any) {
    logger.error("JSON-RPC handler error", { method, error: error.message });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error.message || "Internal error",
        data: { stack: error.stack }
      }
    };
  }
}

/**
 * Creates an Express app with the /mcp endpoint.
 */
export function createHttpApp(): express.Application {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'espocrm-mcp-server' });
  });

  // MCP JSON-RPC endpoint
  app.post('/mcp', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const jsonRpcRequest = req.body as JsonRpcRequest;

      logger.debug("Received JSON-RPC request", {
        method: jsonRpcRequest.method,
        id: jsonRpcRequest.id
      });

      const response = await handleJsonRpcRequest(jsonRpcRequest);

      // Set appropriate content type
      res.setHeader('Content-Type', 'application/json');
      res.json(response);

    } catch (error: any) {
      logger.error("HTTP handler error", { error: error.message });
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" }
      });
    }
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
 * Starts the HTTP server.
 */
export async function startHttpServer(port: number = 3000): Promise<void> {
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
  const app = createHttpApp();

  app.listen(port, () => {
    logger.info(`EspoMCP HTTP server listening on port ${port}`);
    console.log(`EspoCRM MCP Server (HTTP) running at http://localhost:${port}/mcp`);
  });
}

// Export for testing
export { toolsListHandler, toolCallHandler, handleJsonRpcRequest };
