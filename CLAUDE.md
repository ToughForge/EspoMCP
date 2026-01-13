# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EspoMCP is a Model Context Protocol (MCP) server for EspoCRM integration. It provides 47 MCP tools for complete CRUD operations on CRM entities (Contacts, Accounts, Opportunities, Meetings, Users, Tasks, Leads) plus team/role management, generic entity operations, and communication tools.

The project has two main components:
1. **MCP Server** (`EspoMCP/`) - TypeScript-based MCP server with stdio and HTTP transports
2. **Chatbot Bridge** (`EspoMCP/chatbot-bridge/`) - Node.js server that embeds a chat widget in EspoCRM

## Common Commands

```bash
# All commands run from EspoMCP/ directory
cd EspoMCP

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode (uses tsx)
npm run dev

# Start production server (stdio transport)
npm start

# Run tests
npm test                  # Jest unit tests
npm run test:config       # Test EspoCRM configuration/connectivity
npm run test:client       # Test MCP client functionality

# Lint
npm run lint

# Docker
npm run docker:build
npm run docker:run

# For chatbot bridge (from EspoMCP/chatbot-bridge/)
cd chatbot-bridge
npm install
npm start                 # Start chatbot server
npm run dev               # Development with nodemon
```

## Architecture

### MCP Server (`EspoMCP/src/`)

```
src/
├── index.ts              # Entry point - handles stdio/HTTP transport selection
├── http-server.ts        # Express HTTP transport server
├── config/index.ts       # Environment config loading and validation
├── espocrm/
│   ├── client.ts         # Axios-based EspoCRM API client with API key/HMAC auth
│   └── types.ts          # TypeScript interfaces for all CRM entities
├── tools/index.ts        # MCP tool definitions and handlers (47 tools)
├── utils/
│   ├── errors.ts         # MCPErrorHandler for standardized error handling
│   ├── formatting.ts     # Entity formatting functions for tool responses
│   ├── logger.ts         # Winston logger configuration
│   └── validation.ts     # Zod schemas for input validation
└── types.ts              # Config and server types
```

### Key Patterns

- **Tool Registration**: Tools are registered in `src/tools/index.ts` using MCP SDK's `ListToolsRequestSchema` and `CallToolRequestSchema` handlers
- **API Client**: `EspoCRMClient` class wraps Axios with authentication interceptors (API key or HMAC)
- **Validation**: All tool inputs use Zod schemas defined in `src/utils/validation.ts`
- **Error Handling**: `MCPErrorHandler` provides consistent error responses across all tools
- **Formatting**: Each entity type has dedicated formatting functions in `src/utils/formatting.ts`

### Transport Modes

- **stdio** (default): For CLI-based MCP clients like Claude Desktop
- **HTTP**: Set `MCP_TRANSPORT=http` and `HTTP_PORT=3000` for HTTP transport

### Chatbot Bridge (`EspoMCP/chatbot-bridge/`)

Separate Node.js (vanilla JS) server using Socket.IO for real-time chat. Embeds in EspoCRM via script tags. Optional OpenAI integration for NLP.

## Environment Configuration

Required in `.env`:
```
ESPOCRM_URL=https://your-espocrm-instance.com
ESPOCRM_API_KEY=your-api-key
ESPOCRM_AUTH_METHOD=apikey  # or 'hmac' with ESPOCRM_SECRET_KEY
```

Optional:
```
MCP_TRANSPORT=stdio         # or 'http'
HTTP_PORT=3000
RATE_LIMIT=100
REQUEST_TIMEOUT=30000
LOG_LEVEL=info              # debug for verbose logging
```

## Testing

Tests are in `EspoMCP/tests/` using Jest with ts-jest. Manual test scripts in project root:
- `test-connection.js` - Basic API connectivity
- `test-enhanced-tools.js` - Full tool testing
- `create-random-contact.js` - CRUD verification

## Adding New Tools

1. Add entity types to `src/espocrm/types.ts`
2. Add tool definition to the tools array in `src/tools/index.ts`
3. Add handler case in `CallToolRequestSchema` handler
4. Add formatting function to `src/utils/formatting.ts`
5. Add Zod validation schemas if needed in `src/utils/validation.ts`
