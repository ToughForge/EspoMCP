# The problem
Currently, tools are statically coded, for example `create Lead`.

This is problematic, as arbitrary fields and links can be added to stock entities, and custom entities can be created. 

# The solution
I would like you to implement dynamically defined tooling. When the list of tools is created, the endpoints below are
queried, and a set of entity specific CRUD tools are returned, each with the correctly and specifically defined 
parameters available on them.

All endpoints must be HTTP streamable.

Similarly, when a CRUD tool is created, it is also dynamically handled. For example, if I were to start the MCP server,
and immediately call create_CProduct(name: Foo), it would treat that as a call to the  generic "create entity" tool, 
with an entity type of CProduct, and a field name: Foo.

Where a entity type can't be found, try prefixing with C before failing the tool usage - i.e. Product -> CProduct

# Technical constraints
Entity types can be found at http://<server>/api/v1/Metadata

Each entity can be found at `entityDefs.<product-name>`

Eg for the entity CProduct, at `entityDefs.CProduct`, the returned JSON looks like:

```json
[

{


"fields":
{



"name":
{




"type":
"varchar",




"required":
true,




"pattern":
"$noBadCharacters"



},



"description":
{




"type":
"text"



},



"createdAt":
{




"type":
"datetime",




"readOnly":
true



},



"modifiedAt":
{




"type":
"datetime",




"readOnly":
true



},



"createdBy":
{




"type":
"link",




"readOnly":
true,




"view":
"views/fields/user"



},



"modifiedBy":
{




"type":
"link",




"readOnly":
true,




"view":
"views/fields/user"



},



"assignedUser":
{




"type":
"link",




"required":
false,




"view":
"views/fields/assigned-user"



},



"teams":
{




"type":
"linkMultiple",




"view":
"views/fields/teams"



},



"landingPages":
{




"type":
"urlMultiple",




"storeArrayValues":
true,




"isCustom":
true



},



"gitRepo":
{




"type":
"url",




"copyToClipboard":
true,




"isCustom":
true



},



"unitRevenue":
{




"type":
"currency",




"min":
1,




"isCustom":
true

```

A list of translations can be found at http://<server>/api/v1/I18n?default=true

Where available, translations should be used to describe the tool arguments. The tooltips in particular (where available)
are most descriptive, otherwise the field name translations are useful.

The translations for CProduct would be found at `CProduct`:

```json
  
{
  
  
"links": 
{
  
  
  
"leads": 
"Leads",
  
  
  
"campaignTopics": 
"Campaign Topics",
  
  
  
"targetMarket": 
"Target Market",
  
  
  
"productHeroImages": 
"Product Hero Images",
  
  
  
"productBenefits": 
"Product Benefits",
  
  
  
"productCapabilities": 
"Product Capabilities"
  
  
},
  
  
"labels": 
{
  
  
  
"Create CProduct": 
"Create Product"
  
  
},
  
  
"fields": 
{
  
  
  
"landingPages": 
"Landing Pages",
  
  
  
"gitRepo": 
"Git Repo",
  
  
  
"leads": 
"Leads",
  
  
  
"unitRevenue": 
"Unit Revenue",
  
  
  
"unitRevenueCurrency": 
"Unit Revenue (Currency)",
  
  
  
"unitRevenueConverted": 
"Unit Revenue (Converted)",
  
  
  
"campaignTopics": 
"Campaign Topics",
  
  
  
"leadQualifiers": 
"Lead Qualifiers",
  
  
  
"targetMarket": 
"Target Market",
  
  
  
"productHeroImages": 
"Product Hero Images",
  
  
  
"productBenefits": 
"Product Benefits",
  
  
  
"productCapabilities": 
"Product Capabilities"
  
  
},
  
  
"layouts": 
{
  
  
  
"listForMyEntityType": 
"List (for MyEntityType)"
  
  
},
  
  
"tooltips": 
{
  
  
  
"leadQualifiers":
"Describe what factors a lead, who has shown interest in this product, would have to have to be converted into an opportunity."


}

}
```

---

# Implementation Plan

## Summary
**Completely replace** the current 47 static MCP tools with dynamically generated entity-specific CRUD tools based on EspoCRM's metadata API. No backwards compatibility with static tools - all entity tools will be generated from metadata. Each entity (including custom entities prefixed with `C`) will have tools like `create_Contact`, `search_Contact`, `get_Contact`, `update_Contact`, `delete_Contact` with parameters derived from the entity's field definitions and translations.

## Architecture Overview

```
                    ┌─────────────────────────────────────────┐
                    │           MCP Server Startup            │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │         MetadataService                 │
                    │  - Fetches /api/v1/Metadata             │
                    │  - Fetches /api/v1/I18n?default=true    │
                    │  - Caches entity definitions & labels   │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │     DynamicToolGenerator                │
                    │  - Generates tool definitions from      │
                    │    entity metadata                      │
                    │  - Maps field types to JSON Schema      │
                    │  - Uses translations for descriptions   │
                    └────────────────┬────────────────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
   create_Contact          search_CProduct           update_Account
   (dynamic tool)          (dynamic tool)           (dynamic tool)
          │                          │                          │
          └──────────────────────────┼──────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │    DynamicToolHandler                   │
                    │  - Parses tool name → entity + action   │
                    │  - Falls back to "C" prefix if needed   │
                    │  - Routes to generic client methods     │
                    └─────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Create MetadataService (`src/metadata/service.ts`)
New service to fetch and cache EspoCRM metadata and translations.

```typescript
interface EntityFieldDef {
  type: string;        // varchar, text, int, float, date, datetime, bool, enum, link, linkMultiple, etc.
  required?: boolean;
  readOnly?: boolean;
  options?: string[];  // For enum types
  min?: number;
  max?: number;
  default?: any;
}

interface EntityMetadata {
  name: string;
  fields: Record<string, EntityFieldDef>;
  links: Record<string, LinkDef>;
}

interface Translations {
  fields: Record<string, string>;
  tooltips: Record<string, string>;
  labels: Record<string, string>;
  links: Record<string, string>;
}
```

Key methods:
- `fetchMetadata(): Promise<Record<string, EntityMetadata>>`
- `fetchTranslations(): Promise<Record<string, Translations>>`
- `getEntityList(): string[]`
- `getEntityFields(entityType: string): EntityFieldDef[]`
- `getFieldDescription(entityType: string, fieldName: string): string`

### Step 2: Create DynamicToolGenerator (`src/tools/generator.ts`)
Generates MCP tool definitions from entity metadata.

**Field type to JSON Schema mapping:**
| EspoCRM Type | JSON Schema | Notes |
|--------------|-------------|-------|
| varchar, text, url, urlMultiple | string | |
| int | integer | Add min/max constraints |
| float, currency | number | |
| date | string (YYYY-MM-DD) | pattern constraint |
| datetime | string (ISO 8601) | |
| bool | boolean | |
| enum | string with enum | use options array |
| link | string | ID reference |
| linkMultiple | array of strings | ID array |

**Generated tools per entity:**
1. `create_<EntityType>` - All writable fields as optional params (required ones marked)
2. `search_<EntityType>` - Searchable fields + limit/offset/orderBy/order
3. `get_<EntityType>` - entityId + optional select fields
4. `update_<EntityType>` - entityId + all writable fields as optional
5. `delete_<EntityType>` - entityId only

**Description generation:**
- Tool description: "Create a new <EntityType>" or use translation `labels["Create <EntityType>"]`
- Field description: Priority order:
  1. `tooltips.<fieldName>` (most descriptive)
  2. `fields.<fieldName>` (human readable name)
  3. Camel case split of field name

### Step 3: Create DynamicToolHandler (`src/tools/handler.ts`)
Routes dynamic tool calls to the existing EspoCRM client methods.

**Tool name parsing:**
```
create_Contact  → action: "create", entity: "Contact"
search_CProduct → action: "search", entity: "CProduct"
get_Lead        → action: "get",    entity: "Lead"
```

**Entity resolution with "C" prefix fallback:**
```typescript
async function resolveEntityType(name: string, metadata: MetadataService): Promise<string> {
  if (metadata.hasEntity(name)) return name;
  if (metadata.hasEntity('C' + name)) return 'C' + name;
  throw new Error(`Entity type not found: ${name} (also tried C${name})`);
}
```

**Action routing:**
- `create_*` → `client.post(entityType, data)`
- `search_*` → `client.search(entityType, { where, select, ... })`
- `get_*` → `client.getById(entityType, id, select)`
- `update_*` → `client.put(entityType, id, data)`
- `delete_*` → `client.delete(entityType, id)`

### Step 4: Update setupEspoCRMTools (`src/tools/index.ts`)
Modify to use dynamic tool generation.

```typescript
export async function setupEspoCRMTools(server: Server, config: Config): Promise<void> {
  const client = new EspoCRMClient(config.espocrm);

  // Verify connection
  const connectionTest = await client.testConnection();
  if (!connectionTest.success) throw new Error("Failed to connect");

  // Fetch metadata and translations
  const metadataService = new MetadataService(client);
  await metadataService.initialize();

  // Generate dynamic tools
  const toolGenerator = new DynamicToolGenerator(metadataService);
  const dynamicTools = toolGenerator.generateAllTools();

  // Create handler
  const toolHandler = new DynamicToolHandler(client, metadataService);

  // Register ListTools - returns dynamic tool definitions
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...dynamicTools,
      // Keep utility tools: health_check, link_entities, unlink_entities, etc.
    ]
  }));

  // Register CallTool - routes to dynamic handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Check if it's a dynamic tool (matches pattern)
    if (toolHandler.isDynamicTool(name)) {
      return toolHandler.handleTool(name, args);
    }

    // Fall back to utility tools
    switch (name) {
      case "health_check": ...
      case "link_entities": ...
      // etc.
    }
  });
}
```

### Step 5: Update HTTP Streamable Server (`src/http-streamable.ts`)
No changes needed - already captures handlers dynamically.

### Step 6: Keep Utility Tools
Retain these non-entity-specific tools:
- `health_check` - API connection verification
- `link_entities` / `unlink_entities` - Relationship management
- `get_entity_relationships` - List entity relationships

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/metadata/service.ts` | Create | Metadata and translation fetching/caching |
| `src/metadata/types.ts` | Create | TypeScript interfaces for metadata |
| `src/tools/generator.ts` | Create | Dynamic tool definition generation |
| `src/tools/handler.ts` | Create | Dynamic tool call routing |
| `src/tools/index.ts` | Modify | Wire up dynamic generation, keep utility tools |
| `src/espocrm/client.ts` | Modify | Add raw GET method for metadata endpoints |

## Validation Strategy

For dynamically generated tools:
1. Required fields validation at runtime based on metadata
2. Type coercion (string→number for int/float fields)
3. Enum validation for enum-type fields
4. Date format validation for date/datetime fields
5. Sanitization using existing `sanitizeInput()` function

## Error Handling

1. **Metadata fetch failure**: Server fails to start with clear error message
2. **Unknown entity type**: Try "C" prefix, then return error with available entity list
3. **Invalid field values**: Return validation error with field-specific message
4. **API errors**: Existing MCPErrorHandler already handles these

## Testing Verification

1. Start server in streamable HTTP mode: `MCP_TRANSPORT=streamable npm start`
2. Call `tools/list` - verify dynamic tools appear for entities like Contact, Lead, CProduct
3. Call `tools/call` with `create_CProduct(name: "Test")` - verify creates entity
4. Call `tools/call` with `create_Product(name: "Test")` - verify "C" prefix fallback works
5. Call `tools/call` with `search_Contact(limit: 5)` - verify returns results
6. Verify field descriptions use translations where available
```