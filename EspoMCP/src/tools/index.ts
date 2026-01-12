/**
 * Dynamic tool registration for EspoCRM MCP server.
 *
 * This module sets up dynamically generated CRUD tools for all entity types
 * discovered from the EspoCRM metadata API, plus utility tools for
 * relationship management and health checks.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolResult,
  CallToolRequest,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EspoCRMClient } from "../espocrm/client.js";
import { Config } from "../types.js";
import { MetadataService } from "../metadata/service.js";
import { DynamicToolGenerator } from "./generator.js";
import { DynamicToolHandler } from "./handler.js";
import { MCPToolDefinition } from "../metadata/types.js";
import { formatGenericEntityResults } from "../utils/formatting.js";
import { IdSchema } from "../utils/validation.js";
import logger from "../utils/logger.js";

/**
 * Utility tool definitions that are not entity-specific.
 */
const UTILITY_TOOLS: MCPToolDefinition[] = [
  {
    name: "health_check",
    description: "Check EspoCRM connection and API status",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "link_entities",
    description: "Create relationships between any two entities",
    inputSchema: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: "The main entity type (e.g., 'Account', 'Contact')",
        },
        entityId: {
          type: "string",
          description: "ID of the main entity",
        },
        relationshipName: {
          type: "string",
          description: "Name of the relationship (e.g., 'contacts', 'opportunities')",
        },
        relatedEntityIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of related entity IDs to link",
        },
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
        entityType: {
          type: "string",
          description: "The main entity type (e.g., 'Account', 'Contact')",
        },
        entityId: {
          type: "string",
          description: "ID of the main entity",
        },
        relationshipName: {
          type: "string",
          description: "Name of the relationship (e.g., 'contacts', 'opportunities')",
        },
        relatedEntityIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of related entity IDs to unlink",
        },
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
        entityType: {
          type: "string",
          description: "The main entity type (e.g., 'Account', 'Contact')",
        },
        entityId: {
          type: "string",
          description: "ID of the main entity",
        },
        relationshipName: {
          type: "string",
          description: "Name of the relationship (e.g., 'contacts', 'opportunities')",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return",
          default: 50,
        },
        offset: {
          type: "integer",
          description: "Number of records to skip",
          default: 0,
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in results",
        },
      },
      required: ["entityType", "entityId", "relationshipName"],
    },
  },
];

/**
 * Set up EspoCRM tools with dynamic tool generation.
 */
export async function setupEspoCRMTools(
  server: Server,
  config: Config
): Promise<void> {
  logger.info("Setting up EspoCRM tools", {
    baseUrl: config.espocrm.baseUrl,
    authMethod: config.espocrm.authMethod,
  });

  // Initialize EspoCRM client
  const client = new EspoCRMClient(config.espocrm);

  // Test connection before proceeding
  const connectionTest = await client.testConnection();
  if (!connectionTest.success) {
    throw new Error("Failed to connect to EspoCRM. Please check your configuration.");
  }

  logger.info("EspoCRM connection verified", {
    version: connectionTest.version,
    user: connectionTest.user?.userName,
  });

  // Initialize metadata service
  const metadataService = new MetadataService(client);
  await metadataService.initialize();

  // Generate dynamic tools from metadata
  const toolGenerator = new DynamicToolGenerator(metadataService);
  const dynamicTools = toolGenerator.generateAllTools();

  // Create dynamic tool handler
  const toolHandler = new DynamicToolHandler(client, metadataService);

  // Combine dynamic tools with utility tools
  const allTools = [...dynamicTools, ...UTILITY_TOOLS];

  logger.info(`Registered ${allTools.length} tools (${dynamicTools.length} dynamic, ${UTILITY_TOOLS.length} utility)`);

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  // Register tool call handler
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      try {
        // Check if it's a dynamic tool
        if (toolHandler.isDynamicTool(name)) {
          return await toolHandler.handleTool(name, args || {});
        }

        // Handle utility tools
        switch (name) {
          case "health_check":
            return await handleHealthCheck(client, connectionTest);

          case "link_entities":
            return await handleLinkEntities(client, args || {});

          case "unlink_entities":
            return await handleUnlinkEntities(client, args || {});

          case "get_entity_relationships":
            return await handleGetRelationships(client, args || {});

          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error: any) {
        logger.error(`Tool execution failed: ${name}`, { error: error.message });
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Handle health_check tool.
 */
async function handleHealthCheck(
  client: EspoCRMClient,
  connectionTest: { success: boolean; version?: string; user?: any }
): Promise<CallToolResult> {
  if (!connectionTest.success) {
    throw new Error("Connection test failed");
  }

  const result = `EspoCRM connection healthy
API authentication working
Server version: ${connectionTest.version || "Unknown"}
User: ${connectionTest.user?.userName || "Unknown"}
Current time: ${new Date().toISOString()}`;

  return {
    content: [{ type: "text", text: result }],
  };
}

/**
 * Handle link_entities tool.
 */
async function handleLinkEntities(
  client: EspoCRMClient,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const schema = z.object({
    entityType: z.string().min(1),
    entityId: IdSchema,
    relationshipName: z.string().min(1),
    relatedEntityIds: z.array(IdSchema).min(1),
  });

  const validatedArgs = schema.parse(args);

  await client.linkRecords(
    validatedArgs.entityType,
    validatedArgs.entityId,
    validatedArgs.relationshipName,
    validatedArgs.relatedEntityIds
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully linked ${validatedArgs.relatedEntityIds.length} entities to ${validatedArgs.entityType} ${validatedArgs.entityId} via relationship '${validatedArgs.relationshipName}'`,
      },
    ],
  };
}

/**
 * Handle unlink_entities tool.
 */
async function handleUnlinkEntities(
  client: EspoCRMClient,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const schema = z.object({
    entityType: z.string().min(1),
    entityId: IdSchema,
    relationshipName: z.string().min(1),
    relatedEntityIds: z.array(IdSchema).min(1),
  });

  const validatedArgs = schema.parse(args);

  await client.unlinkRecords(
    validatedArgs.entityType,
    validatedArgs.entityId,
    validatedArgs.relationshipName,
    validatedArgs.relatedEntityIds
  );

  return {
    content: [
      {
        type: "text",
        text: `Successfully unlinked ${validatedArgs.relatedEntityIds.length} entities from ${validatedArgs.entityType} ${validatedArgs.entityId} via relationship '${validatedArgs.relationshipName}'`,
      },
    ],
  };
}

/**
 * Handle get_entity_relationships tool.
 */
async function handleGetRelationships(
  client: EspoCRMClient,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const schema = z.object({
    entityType: z.string().min(1),
    entityId: IdSchema,
    relationshipName: z.string().min(1),
    limit: z.number().min(1).max(200).default(50),
    offset: z.number().min(0).default(0),
    select: z.array(z.string()).optional(),
  });

  const validatedArgs = schema.parse(args);

  const related = await client.getRelated(
    validatedArgs.entityType,
    validatedArgs.entityId,
    validatedArgs.relationshipName,
    {
      maxSize: validatedArgs.limit,
      offset: validatedArgs.offset,
      select: validatedArgs.select,
    }
  );

  if (!related?.list?.length) {
    return {
      content: [
        {
          type: "text",
          text: `No related entities found for ${validatedArgs.entityType} ${validatedArgs.entityId} via relationship '${validatedArgs.relationshipName}'`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: formatGenericEntityResults(
          related.list,
          `Related ${validatedArgs.relationshipName}`
        ),
      },
    ],
  };
}
