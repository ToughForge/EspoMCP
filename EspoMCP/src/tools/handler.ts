/**
 * Dynamic tool handler - routes tool calls to EspoCRM client methods.
 */

import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EspoCRMClient } from "../espocrm/client.js";
import { MetadataService } from "../metadata/service.js";
import { WhereClause } from "../espocrm/types.js";
import { formatGenericEntityResults, formatGenericEntityDetails } from "../utils/formatting.js";
import { sanitizeInput } from "../utils/validation.js";
import logger from "../utils/logger.js";

// Dynamic tool actions
type ToolAction = "create" | "search" | "get" | "update" | "delete";

// Parsed tool name
interface ParsedToolName {
  action: ToolAction;
  entityType: string;
}

// Standard search parameters
const SEARCH_PARAMS = new Set(["select", "limit", "offset", "orderBy", "order"]);

export class DynamicToolHandler {
  private entitySet: Set<string>;

  constructor(
    private client: EspoCRMClient,
    private metadataService: MetadataService
  ) {
    // Pre-compute entity set for quick lookup
    this.entitySet = new Set(metadataService.getEntityList());
  }

  /**
   * Check if a tool name matches the dynamic tool pattern.
   */
  isDynamicTool(toolName: string): boolean {
    const parsed = this.parseToolName(toolName);
    if (!parsed) return false;

    // Check if entity exists (with C prefix fallback)
    try {
      this.metadataService.resolveEntityType(parsed.entityType);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a tool name into action and entity type.
   */
  private parseToolName(toolName: string): ParsedToolName | null {
    const match = toolName.match(/^(create|search|get|update|delete)_(.+)$/);
    if (!match) return null;

    return {
      action: match[1] as ToolAction,
      entityType: match[2],
    };
  }

  /**
   * Handle a dynamic tool call.
   */
  async handleTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    const parsed = this.parseToolName(toolName);
    if (!parsed) {
      return this.errorResult(`Invalid tool name: ${toolName}`);
    }

    // Resolve entity type (with C prefix fallback)
    let entityType: string;
    try {
      entityType = this.metadataService.resolveEntityType(parsed.entityType);
    } catch (error: any) {
      return this.errorResult(error.message);
    }

    logger.debug(`Handling dynamic tool: ${parsed.action} ${entityType}`, { args });

    try {
      switch (parsed.action) {
        case "create":
          return await this.handleCreate(entityType, args);
        case "search":
          return await this.handleSearch(entityType, args);
        case "get":
          return await this.handleGet(entityType, args);
        case "update":
          return await this.handleUpdate(entityType, args);
        case "delete":
          return await this.handleDelete(entityType, args);
        default:
          return this.errorResult(`Unknown action: ${parsed.action}`);
      }
    } catch (error: any) {
      logger.error(`Tool execution failed: ${toolName}`, { error: error.message });
      return this.errorResult(`Failed to execute ${toolName}: ${error.message}`);
    }
  }

  /**
   * Handle create action.
   */
  private async handleCreate(
    entityType: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    // Validate required fields
    const metadata = this.metadataService.getEntityMetadata(entityType);
    if (metadata) {
      const requiredFields = Object.entries(metadata.fields || {})
        .filter(([_, field]) => field.required && !field.readOnly)
        .map(([name]) => name);

      const missingFields = requiredFields.filter((f) => !(f in args) || args[f] === undefined);
      if (missingFields.length > 0) {
        return this.errorResult(`Missing required fields: ${missingFields.join(", ")}`);
      }
    }

    const sanitizedData = sanitizeInput(args);
    const result = await this.client.post(entityType, sanitizedData);

    const nameField = this.getNameField(result);
    return this.successResult(
      `Successfully created ${entityType}: ${nameField} (ID: ${result.id})`
    );
  }

  /**
   * Handle search action.
   */
  private async handleSearch(
    entityType: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    // Separate search params from filter params
    const select = args.select as string[] | undefined;
    const limit = (args.limit as number) || 20;
    const offset = (args.offset as number) || 0;
    const orderBy = args.orderBy as string | undefined;
    const order = (args.order as "asc" | "desc") || "asc";

    // Build where clauses from remaining args
    const filterArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!SEARCH_PARAMS.has(key) && value !== undefined && value !== null && value !== "") {
        filterArgs[key] = value;
      }
    }

    const where = this.buildWhereClause(filterArgs);

    const result = await this.client.search(entityType, {
      where: where.length > 0 ? where : undefined,
      select,
      maxSize: limit,
      offset,
      orderBy,
      order,
    });

    const list = result.list || [];
    const total = result.total || list.length;

    if (list.length === 0) {
      return this.successResult(`No ${entityType} records found matching the criteria.`);
    }

    const formatted = formatGenericEntityResults(list, entityType);
    return this.successResult(
      `Found ${total} ${entityType} record(s) (showing ${list.length}):\n\n${formatted}`
    );
  }

  /**
   * Handle get action.
   */
  private async handleGet(
    entityType: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const id = args.id as string;
    if (!id) {
      return this.errorResult("Missing required parameter: id");
    }

    const select = args.select as string[] | undefined;
    const result = await this.client.getById(entityType, id, select);

    const formatted = formatGenericEntityDetails(result, entityType);
    return this.successResult(formatted);
  }

  /**
   * Handle update action.
   */
  private async handleUpdate(
    entityType: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const id = args.id as string;
    if (!id) {
      return this.errorResult("Missing required parameter: id");
    }

    // Remove id from update data
    const { id: _, ...updateData } = args;

    if (Object.keys(updateData).length === 0) {
      return this.errorResult("No fields to update provided");
    }

    const sanitizedData = sanitizeInput(updateData);
    const result = await this.client.put(entityType, id, sanitizedData);

    const nameField = this.getNameField(result);
    return this.successResult(
      `Successfully updated ${entityType}: ${nameField} (ID: ${id})`
    );
  }

  /**
   * Handle delete action.
   */
  private async handleDelete(
    entityType: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const id = args.id as string;
    if (!id) {
      return this.errorResult("Missing required parameter: id");
    }

    await this.client.delete(entityType, id);

    return this.successResult(`Successfully deleted ${entityType} with ID: ${id}`);
  }

  /**
   * Build EspoCRM where clause from filter arguments.
   */
  private buildWhereClause(filters: Record<string, unknown>): WhereClause[] {
    const where: WhereClause[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === "") continue;

      if (typeof value === "string" && value.includes("*")) {
        // Wildcard search - use contains
        where.push({
          type: "contains",
          attribute: key,
          value: value.replace(/\*/g, ""),
        });
      } else if (Array.isArray(value)) {
        // Array values use "in" operator
        where.push({
          type: "in",
          attribute: key,
          value,
        });
      } else {
        // Exact match
        where.push({
          type: "equals",
          attribute: key,
          value,
        });
      }
    }

    return where;
  }

  /**
   * Get a displayable name from an entity result.
   */
  private getNameField(entity: Record<string, unknown>): string {
    // Try common name fields
    if (entity.name) return String(entity.name);
    if (entity.firstName || entity.lastName) {
      return `${entity.firstName || ""} ${entity.lastName || ""}`.trim();
    }
    if (entity.title) return String(entity.title);
    if (entity.subject) return String(entity.subject);
    return entity.id ? String(entity.id) : "Unknown";
  }

  /**
   * Create a success result.
   */
  private successResult(text: string): CallToolResult {
    return {
      content: [{ type: "text", text }],
    };
  }

  /**
   * Create an error result.
   */
  private errorResult(message: string): CallToolResult {
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
