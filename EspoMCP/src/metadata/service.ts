/**
 * Service for fetching and caching EspoCRM metadata and translations.
 */

import { EspoCRMClient } from "../espocrm/client.js";
import {
  EntityMetadata,
  EntityFieldDef,
  EntityLinkDef,
  EntityTranslations,
  MetadataResponse,
  I18nResponse,
  ProcessedEntityInfo,
  ProcessedFieldInfo,
  ScopeDefinition,
} from "./types.js";
import logger from "../utils/logger.js";

export class MetadataService {
  private entityDefs: Record<string, EntityMetadata> = {};
  private scopes: Record<string, ScopeDefinition> = {};
  private translations: I18nResponse = {};
  private initialized = false;

  constructor(private client: EspoCRMClient) {}

  /**
   * Initialize by fetching metadata and translations from EspoCRM.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("Fetching EspoCRM metadata and translations...");

    try {
      // Fetch metadata and translations in parallel
      const [metadataResponse, i18nResponse] = await Promise.all([
        this.fetchMetadata(),
        this.fetchTranslations(),
      ]);

      this.entityDefs = metadataResponse.entityDefs || {};
      this.scopes = metadataResponse.scopes || {};
      this.translations = i18nResponse;
      this.initialized = true;

      const entityCount = this.getEntityList().length;
      logger.info(`Metadata initialized: ${entityCount} entities available`);
    } catch (error: any) {
      logger.error("Failed to fetch metadata", { error: error.message });
      throw new Error(`Failed to initialize metadata: ${error.message}`);
    }
  }

  /**
   * Fetch raw metadata from EspoCRM /api/v1/Metadata endpoint.
   */
  private async fetchMetadata(): Promise<MetadataResponse> {
    const response = await this.client.get<MetadataResponse>("Metadata");
    return response as unknown as MetadataResponse;
  }

  /**
   * Fetch translations from EspoCRM /api/v1/I18n endpoint.
   */
  private async fetchTranslations(): Promise<I18nResponse> {
    const response = await this.client.get<I18nResponse>("I18n", { default: true });
    return response as unknown as I18nResponse;
  }

  /**
   * Get list of available entity types (only those that are enabled and are entities).
   */
  getEntityList(): string[] {
    return Object.keys(this.entityDefs).filter((name) => {
      const scope = this.scopes[name];
      // Include if scope doesn't exist (assume enabled) or if explicitly an entity and not disabled
      if (!scope) return true;
      if (scope.disabled) return false;
      // Must be an entity (not just a scope)
      return scope.entity !== false;
    });
  }

  /**
   * Check if an entity type exists.
   */
  hasEntity(entityType: string): boolean {
    return entityType in this.entityDefs;
  }

  /**
   * Resolve entity type with "C" prefix fallback.
   * @param entityType The entity type name to resolve
   * @returns The resolved entity type name
   * @throws Error if entity type not found
   */
  resolveEntityType(entityType: string): string {
    if (this.hasEntity(entityType)) return entityType;
    const prefixedType = "C" + entityType;
    if (this.hasEntity(prefixedType)) return prefixedType;
    throw new Error(
      `Entity type not found: ${entityType} (also tried ${prefixedType})`
    );
  }

  /**
   * Get metadata for a specific entity type.
   */
  getEntityMetadata(entityType: string): EntityMetadata | undefined {
    return this.entityDefs[entityType];
  }

  /**
   * Get translations for a specific entity type.
   */
  getEntityTranslations(entityType: string): EntityTranslations {
    return this.translations[entityType] || {};
  }

  /**
   * Get field definition for a specific field.
   */
  getFieldDef(entityType: string, fieldName: string): EntityFieldDef | undefined {
    return this.entityDefs[entityType]?.fields?.[fieldName];
  }

  /**
   * Get all fields for an entity type.
   */
  getFields(entityType: string): Record<string, EntityFieldDef> {
    return this.entityDefs[entityType]?.fields || {};
  }

  /**
   * Get all links for an entity type.
   */
  getLinks(entityType: string): Record<string, EntityLinkDef> {
    return this.entityDefs[entityType]?.links || {};
  }

  /**
   * Get human-readable description for a field.
   * Priority: tooltips > fields translation > camelCase split
   */
  getFieldDescription(entityType: string, fieldName: string): string {
    const translations = this.getEntityTranslations(entityType);

    // First try tooltip (most descriptive)
    if (translations.tooltips?.[fieldName]) {
      return translations.tooltips[fieldName];
    }

    // Then try field name translation
    if (translations.fields?.[fieldName]) {
      return translations.fields[fieldName];
    }

    // Fall back to splitting camelCase
    return this.camelCaseToWords(fieldName);
  }

  /**
   * Get tool label translation (e.g., "Create Contact").
   */
  getToolLabel(entityType: string, action: string): string | undefined {
    const translations = this.getEntityTranslations(entityType);
    const labelKey = `${this.capitalizeFirst(action)} ${entityType}`;
    return translations.labels?.[labelKey];
  }

  /**
   * Get link description.
   */
  getLinkDescription(entityType: string, linkName: string): string {
    const translations = this.getEntityTranslations(entityType);
    return translations.links?.[linkName] || this.camelCaseToWords(linkName);
  }

  /**
   * Get enum option translations for a field.
   */
  getEnumOptions(entityType: string, fieldName: string): Record<string, string> | undefined {
    const translations = this.getEntityTranslations(entityType);
    return translations.options?.[fieldName];
  }

  /**
   * Get processed entity info with fields and translations merged.
   */
  getProcessedEntityInfo(entityType: string): ProcessedEntityInfo | undefined {
    const metadata = this.getEntityMetadata(entityType);
    if (!metadata) return undefined;

    const translations = this.getEntityTranslations(entityType);
    const fields: ProcessedFieldInfo[] = [];

    for (const [fieldName, fieldDef] of Object.entries(metadata.fields || {})) {
      fields.push({
        name: fieldName,
        type: fieldDef.type,
        required: fieldDef.required || false,
        readOnly: fieldDef.readOnly || false,
        description: this.getFieldDescription(entityType, fieldName),
        options: fieldDef.options,
        min: fieldDef.min,
        max: fieldDef.max,
        maxLength: fieldDef.maxLength,
      });
    }

    return {
      name: entityType,
      fields,
      translations,
    };
  }

  /**
   * Get all processed entity infos for tool generation.
   */
  getAllProcessedEntities(): ProcessedEntityInfo[] {
    return this.getEntityList()
      .map((entityType) => this.getProcessedEntityInfo(entityType))
      .filter((info): info is ProcessedEntityInfo => info !== undefined);
  }

  /**
   * Convert camelCase to human-readable words.
   */
  private camelCaseToWords(str: string): string {
    return str
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (s) => s.toUpperCase())
      .trim();
  }

  /**
   * Capitalize first letter.
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
