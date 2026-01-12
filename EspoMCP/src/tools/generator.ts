/**
 * Dynamic tool generator - creates MCP tool definitions from EspoCRM metadata.
 */

import { MetadataService } from "../metadata/service.js";
import {
  MCPToolDefinition,
  PropertyDefinition,
  ProcessedEntityInfo,
  ProcessedFieldInfo,
} from "../metadata/types.js";
import logger from "../utils/logger.js";

// Fields to exclude from tool parameters (internal/system fields)
const EXCLUDED_FIELDS = new Set([
  "id",
  "deleted",
  "createdAt",
  "modifiedAt",
  "createdBy",
  "createdById",
  "createdByName",
  "modifiedBy",
  "modifiedById",
  "modifiedByName",
]);

// Field types that can be searched
const SEARCHABLE_FIELD_TYPES = new Set([
  "varchar",
  "text",
  "email",
  "phone",
  "url",
  "int",
  "float",
  "currency",
  "date",
  "datetime",
  "enum",
  "bool",
  "link",
]);

export class DynamicToolGenerator {
  constructor(private metadataService: MetadataService) {}

  /**
   * Generate all tools for all available entities.
   */
  generateAllTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];
    const entities = this.metadataService.getAllProcessedEntities();

    for (const entity of entities) {
      try {
        tools.push(...this.generateEntityTools(entity));
      } catch (error: any) {
        logger.warn(`Failed to generate tools for ${entity.name}`, {
          error: error.message,
        });
      }
    }

    logger.info(`Generated ${tools.length} dynamic tools for ${entities.length} entities`);
    return tools;
  }

  /**
   * Generate CRUD tools for a single entity.
   */
  generateEntityTools(entity: ProcessedEntityInfo): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];

    // create_<EntityType>
    tools.push(this.generateCreateTool(entity));

    // search_<EntityType>
    tools.push(this.generateSearchTool(entity));

    // get_<EntityType>
    tools.push(this.generateGetTool(entity));

    // update_<EntityType>
    tools.push(this.generateUpdateTool(entity));

    // delete_<EntityType>
    tools.push(this.generateDeleteTool(entity));

    return tools;
  }

  /**
   * Generate a create tool for an entity.
   */
  private generateCreateTool(entity: ProcessedEntityInfo): MCPToolDefinition {
    const writableFields = entity.fields.filter(
      (f) => !f.readOnly && !EXCLUDED_FIELDS.has(f.name)
    );

    const properties: Record<string, PropertyDefinition> = {};
    const required: string[] = [];

    for (const field of writableFields) {
      properties[field.name] = this.fieldToPropertyDef(field);
      if (field.required) {
        required.push(field.name);
      }
    }

    const label =
      this.metadataService.getToolLabel(entity.name, "Create") ||
      `Create ${entity.name}`;

    return {
      name: `create_${entity.name}`,
      description: label,
      inputSchema: {
        type: "object",
        properties,
        required,
      },
    };
  }

  /**
   * Generate a search tool for an entity.
   */
  private generateSearchTool(entity: ProcessedEntityInfo): MCPToolDefinition {
    const searchableFields = entity.fields.filter(
      (f) =>
        !f.readOnly &&
        !EXCLUDED_FIELDS.has(f.name) &&
        SEARCHABLE_FIELD_TYPES.has(f.type)
    );

    const properties: Record<string, PropertyDefinition> = {};

    // Add searchable field filters
    for (const field of searchableFields) {
      properties[field.name] = this.fieldToPropertyDef(field);
    }

    // Add standard search parameters
    properties.select = {
      type: "array",
      items: { type: "string" },
      description: "Fields to include in results",
    };
    properties.limit = {
      type: "integer",
      description: "Maximum number of results to return",
      default: 20,
      minimum: 1,
      maximum: 200,
    };
    properties.offset = {
      type: "integer",
      description: "Number of records to skip",
      default: 0,
      minimum: 0,
    };
    properties.orderBy = {
      type: "string",
      description: "Field to order results by",
    };
    properties.order = {
      type: "string",
      enum: ["asc", "desc"],
      description: "Sort order",
      default: "asc",
    };

    return {
      name: `search_${entity.name}`,
      description: `Search for ${entity.name} records`,
      inputSchema: {
        type: "object",
        properties,
        required: [],
      },
    };
  }

  /**
   * Generate a get tool for an entity.
   */
  private generateGetTool(entity: ProcessedEntityInfo): MCPToolDefinition {
    return {
      name: `get_${entity.name}`,
      description: `Get a specific ${entity.name} by ID`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: `The unique ID of the ${entity.name}`,
          },
          select: {
            type: "array",
            items: { type: "string" },
            description: "Fields to include in the response",
          },
        },
        required: ["id"],
      },
    };
  }

  /**
   * Generate an update tool for an entity.
   */
  private generateUpdateTool(entity: ProcessedEntityInfo): MCPToolDefinition {
    const writableFields = entity.fields.filter(
      (f) => !f.readOnly && !EXCLUDED_FIELDS.has(f.name)
    );

    const properties: Record<string, PropertyDefinition> = {
      id: {
        type: "string",
        description: `The unique ID of the ${entity.name} to update`,
      },
    };

    for (const field of writableFields) {
      properties[field.name] = this.fieldToPropertyDef(field);
    }

    return {
      name: `update_${entity.name}`,
      description: `Update an existing ${entity.name}`,
      inputSchema: {
        type: "object",
        properties,
        required: ["id"],
      },
    };
  }

  /**
   * Generate a delete tool for an entity.
   */
  private generateDeleteTool(entity: ProcessedEntityInfo): MCPToolDefinition {
    return {
      name: `delete_${entity.name}`,
      description: `Delete a ${entity.name} by ID`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: `The unique ID of the ${entity.name} to delete`,
          },
        },
        required: ["id"],
      },
    };
  }

  /**
   * Convert a field definition to a JSON Schema property definition.
   */
  private fieldToPropertyDef(field: ProcessedFieldInfo): PropertyDefinition {
    const prop: PropertyDefinition = {
      type: this.espoTypeToJsonType(field.type),
      description: field.description,
    };

    // Add enum values for enum types
    if (field.type === "enum" && field.options) {
      prop.enum = field.options;
    }

    // Add min/max for numeric types
    if (field.type === "int" || field.type === "float" || field.type === "currency") {
      if (field.min !== undefined) prop.minimum = field.min;
      if (field.max !== undefined) prop.maximum = field.max;
    }

    // Add maxLength for string types
    if (
      (field.type === "varchar" || field.type === "text") &&
      field.maxLength !== undefined
    ) {
      prop.maxLength = field.maxLength;
    }

    // Handle array types
    if (field.type === "linkMultiple" || field.type === "urlMultiple") {
      prop.type = "array";
      prop.items = { type: "string" };
    }

    // Add date pattern hint
    if (field.type === "date") {
      prop.pattern = "^\\d{4}-\\d{2}-\\d{2}$";
      prop.description = `${field.description} (YYYY-MM-DD format)`;
    }

    if (field.type === "datetime") {
      prop.description = `${field.description} (ISO 8601 format)`;
    }

    return prop;
  }

  /**
   * Map EspoCRM field type to JSON Schema type.
   */
  private espoTypeToJsonType(espoType: string): string {
    switch (espoType) {
      case "int":
        return "integer";
      case "float":
      case "currency":
        return "number";
      case "bool":
        return "boolean";
      case "linkMultiple":
      case "urlMultiple":
        return "array";
      default:
        return "string";
    }
  }
}
