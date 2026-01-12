/**
 * Tests for the EspoMCP HTTP transport layer.
 * These tests verify the HTTP server correctly handles JSON-RPC requests
 * for MCP tools/list and tools/call methods.
 */

import request from 'supertest';
import express from 'express';

// Mock metadata response
const mockMetadataResponse = {
  entityDefs: {
    Contact: {
      fields: {
        firstName: { type: 'varchar', required: true },
        lastName: { type: 'varchar', required: true },
        emailAddress: { type: 'email' },
      },
      links: {},
    },
    Account: {
      fields: {
        name: { type: 'varchar', required: true },
      },
      links: {},
    },
  },
  scopes: {
    Contact: { entity: true },
    Account: { entity: true },
  },
};

// Mock I18n response
const mockI18nResponse = {
  Contact: { fields: { firstName: 'First Name' }, labels: {}, tooltips: {} },
  Account: { fields: { name: 'Name' }, labels: {}, tooltips: {} },
};

// Create mock functions before any imports that use them
const mockTestConnection = jest.fn().mockResolvedValue({
  success: true,
  user: { userName: 'test-user' },
  version: '8.0.0'
});
const mockGet = jest.fn().mockImplementation((endpoint: string) => {
  if (endpoint === 'Metadata') return Promise.resolve(mockMetadataResponse);
  if (endpoint === 'I18n') return Promise.resolve(mockI18nResponse);
  return Promise.resolve({});
});
const mockSearch = jest.fn().mockResolvedValue({ list: [], total: 0 });
const mockGetById = jest.fn().mockResolvedValue({ id: 'test-id', name: 'Test' });
const mockPost = jest.fn().mockResolvedValue({ id: 'new-id' });
const mockPut = jest.fn().mockResolvedValue({ id: 'updated-id' });
const mockDelete = jest.fn().mockResolvedValue(true);

// Mock the EspoCRM client
jest.mock('../src/espocrm/client.js', () => ({
  __esModule: true,
  EspoCRMClient: jest.fn().mockImplementation(() => ({
    testConnection: mockTestConnection,
    get: mockGet,
    search: mockSearch,
    getById: mockGetById,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
  }))
}));

// Mock logger
jest.mock('../src/utils/logger.js', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }
}));

import { createHttpApp, createMCPServer } from '../src/http-server.js';
import { Config } from '../src/types.js';

describe('EspoMCP HTTP Server', () => {
  let app: express.Application;

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
    // Initialize the MCP server (registers handlers)
    await createMCPServer(mockConfig);
    // Create the Express app
    app = createHttpApp();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        service: 'espocrm-mcp-server'
      });
    });
  });

  describe('POST /mcp - tools/list', () => {
    it('should return list of tools', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        })
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(1);
      expect(response.body.result).toHaveProperty('tools');
      expect(Array.isArray(response.body.result.tools)).toBe(true);
      expect(response.body.result.tools.length).toBeGreaterThan(0);
    });

    it('should include core CRM tools in response', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        })
        .expect(200);

      const toolNames = response.body.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('create_Contact');
      expect(toolNames).toContain('search_Contact');
      expect(toolNames).toContain('create_Account');
      expect(toolNames).toContain('health_check');
    });
  });

  describe('POST /mcp - tools/call', () => {
    it('should execute search_Contact tool', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'search_Contact',
            arguments: { limit: 10 }
          }
        })
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(3);
      expect(response.body.result).toHaveProperty('content');
    });

    it('should return error result for unknown tool', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'nonexistent_tool',
            arguments: {}
          }
        })
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(4);
      // With dynamic tools, unknown tools return a result with isError=true rather than a JSON-RPC error
      expect(response.body.result).toBeDefined();
      expect(response.body.result.isError).toBe(true);
      expect(response.body.result.content[0].text).toContain('Unknown tool');
    });
  });

  describe('POST /mcp - error handling', () => {
    it('should return error for unknown method', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'unknown/method',
          params: {}
        })
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.id).toBe(5);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(-32601);
      expect(response.body.error.message).toContain('Method not found');
    });

    it('should return error for invalid JSON-RPC version', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '1.0',
          id: 6,
          method: 'tools/list',
          params: {}
        })
        .expect(200);

      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe(-32600);
    });

    it('should handle string request IDs', async () => {
      const response = await request(app)
        .post('/mcp')
        .send({
          jsonrpc: '2.0',
          id: 'string-id-123',
          method: 'tools/list',
          params: {}
        })
        .expect(200);

      expect(response.body.id).toBe('string-id-123');
      expect(response.body.result).toBeDefined();
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app)
        .get('/unknown-route')
        .expect(404);

      expect(response.body).toEqual({ error: 'Not found' });
    });
  });
});
