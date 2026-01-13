/**
 * TypeScript interfaces for EspoCRM metadata and translations.
 */

/**
 * Field definition from EspoCRM metadata.
 */
export interface EntityFieldDef {
  type: string;        // varchar, text, int, float, date, datetime, bool, enum, link, linkMultiple, currency, etc.
  required?: boolean;
  readOnly?: boolean;
  options?: string[];  // For enum types
  min?: number;
  max?: number;
  default?: any;
  maxLength?: number;
  pattern?: string;
  view?: string;
  isCustom?: boolean;
  storeArrayValues?: boolean;
  copyToClipboard?: boolean;
}

/**
 * Link definition from EspoCRM metadata.
 */
export interface EntityLinkDef {
  type: string;        // hasMany, belongsTo, hasOne, belongsToParent, hasChildren
  entity?: string;     // Target entity type
  foreign?: string;    // Foreign link name
  relationName?: string;
  isCustom?: boolean;
}

/**
 * Entity metadata from EspoCRM.
 */
export interface EntityMetadata {
  fields: Record<string, EntityFieldDef>;
  links?: Record<string, EntityLinkDef>;
}

/**
 * Full metadata response structure.
 */
export interface MetadataResponse {
  entityDefs: Record<string, EntityMetadata>;
  scopes?: Record<string, ScopeDefinition>;
  [key: string]: any;
}

/**
 * Scope definition - determines if an entity is visible/enabled.
 */
export interface ScopeDefinition {
  entity?: boolean;
  object?: boolean;
  disabled?: boolean;
  stream?: boolean;
  tab?: boolean;
  customizable?: boolean;
  [key: string]: any;
}

/**
 * Translations for a single entity.
 */
export interface EntityTranslations {
  fields?: Record<string, string>;
  tooltips?: Record<string, string>;
  labels?: Record<string, string>;
  links?: Record<string, string>;
  options?: Record<string, Record<string, string>>;
}

/**
 * Full I18n response structure.
 */
export interface I18nResponse {
  [entityType: string]: EntityTranslations;
}

/**
 * Processed entity info for tool generation.
 */
export interface ProcessedEntityInfo {
  name: string;
  fields: ProcessedFieldInfo[];
  translations: EntityTranslations;
}

/**
 * Processed field info with translations merged.
 */
export interface ProcessedFieldInfo {
  name: string;
  type: string;
  required: boolean;
  readOnly: boolean;
  description: string;
  options?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

/**
 * MCP Tool definition structure.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, PropertyDefinition>;
    required: string[];
  };
}

/**
 * JSON Schema property definition.
 */
export interface PropertyDefinition {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  pattern?: string;
  default?: any;
}
