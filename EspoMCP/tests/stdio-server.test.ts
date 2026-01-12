/**
 * Smoke tests for the EspoMCP stdio server interface.
 * These tests verify the MCP server can be created and responds correctly
 * to tools/list and tools/call requests.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Create mock functions
const mockTestConnection = jest.fn().mockResolvedValue({
  success: true,
  user: { userName: 'test-user' },
  version: '8.0.0'
});
const mockSearch = jest.fn().mockResolvedValue({ list: [], total: 0 });
const mockGetById = jest.fn().mockResolvedValue({ id: 'test-id', name: 'Test' });
const mockPost = jest.fn().mockResolvedValue({ id: 'new-id' });
const mockPut = jest.fn().mockResolvedValue({ id: 'updated-id' });
const mockDelete = jest.fn().mockResolvedValue(true);

// Mock the EspoCRM client before importing tools
jest.mock('../src/espocrm/client.js', () => ({
  __esModule: true,
  EspoCRMClient: jest.fn().mockImplementation(() => ({
    testConnection: mockTestConnection,
    search: mockSearch,
    getById: mockGetById,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
  }))
}));

// Mock logger to reduce noise in tests
jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }
}));

import { setupEspoCRMTools } from '../src/tools/index.js';
import { Config } from '../src/types.js';

describe('EspoMCP Stdio Server', () => {
  let server: Server;
  let toolsListHandler: ((request: any) => Promise<any>) | null = null;
  let toolCallHandler: ((request: any) => Promise<any>) | null = null;

  const mockConfig: Config = {
    espocrm: {
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-api-key',
      authMethod: 'apikey',
    },
    server: {
      rateLimit: 100,
      timeout: 30000,
      logLevel: 'error',
    }
  };

  beforeAll(async () => {
    // Create MCP server
    server = new Server(
      { name: "Test EspoCRM Server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    // Capture the request handlers when they're registered
    const originalSetRequestHandler = server.setRequestHandler.bind(server);
    server.setRequestHandler = ((schema: any, handler: any) => {
      if (schema === ListToolsRequestSchema) {
        toolsListHandler = handler;
      } else if (schema === CallToolRequestSchema) {
        toolCallHandler = handler;
      }
      return originalSetRequestHandler(schema, handler);
    }) as typeof server.setRequestHandler;

    // Setup tools (this registers the handlers)
    await setupEspoCRMTools(server, mockConfig);
  });

  describe('tools/list', () => {
    it('should return a list of available tools', async () => {
      expect(toolsListHandler).not.toBeNull();

      const result = await toolsListHandler!({});

      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should include core CRM tools', async () => {
      const result = await toolsListHandler!({});
      const toolNames = result.tools.map((t: any) => t.name);

      // Check for essential tools
      expect(toolNames).toContain('create_contact');
      expect(toolNames).toContain('search_contacts');
      expect(toolNames).toContain('create_account');
      expect(toolNames).toContain('search_accounts');
    });

    it('should have proper tool schema structure', async () => {
      const result = await toolsListHandler!({});

      // Check first tool has required properties
      const tool = result.tools[0];
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    });
  });

  describe('tools/call', () => {
    it('should handle search_contacts tool call', async () => {
      expect(toolCallHandler).not.toBeNull();

      const result = await toolCallHandler!({
        params: {
          name: 'search_contacts',
          arguments: { limit: 10 }
        }
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
    });

    it('should throw error for unknown tool', async () => {
      await expect(toolCallHandler!({
        params: {
          name: 'nonexistent_tool',
          arguments: {}
        }
      })).rejects.toThrow('Unknown tool: nonexistent_tool');
    });
  });
});
