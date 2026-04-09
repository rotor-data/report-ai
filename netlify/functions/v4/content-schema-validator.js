import { z } from "zod";

const TOKEN_TYPES = ["text", "number", "currency", "percent", "date", "image_url", "svg_chart"];

export const TokenDefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(TOKEN_TYPES),
  required: z.boolean().default(true),
});

export const PageTypeMapEntrySchema = z.object({
  page_type: z.string().min(1),
  design_components: z.array(z.string().min(1)).default([]),
  layout_name: z.string().min(1),
  token_list: z.array(z.string().min(1)).default([]),
  repeatable: z.boolean().default(false),
});

const GlobalFieldSchema = z.object({
  type: z.enum(TOKEN_TYPES).default("text"),
  required: z.boolean().default(false),
  description: z.string().optional(),
});

const PageTypeSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
  token_defs: z.array(TokenDefSchema).default([]),
});

export const ContentSchemaSchema = z.object({
  page_types: z.array(z.string().min(1)).default([]),
  global_fields: z.record(z.string(), GlobalFieldSchema).default({}),
  scalability: z.object({
    min_pages: z.number().int().positive().optional(),
    max_pages: z.union([z.number().int().positive(), z.literal("unlimited")]).optional(),
    repeatable_page_types: z.array(z.string().min(1)).default([]),
  }).default({ repeatable_page_types: [] }),
  page_type_map: z.array(PageTypeMapEntrySchema).default([]),
  token_definitions: z.record(z.string(), z.array(TokenDefSchema)).default({}),
  page_type_definitions: z.record(z.string(), PageTypeSchema).default({}),
});

export const PagePlanSchema = z.object({
  page_number: z.number().int().positive(),
  page_type: z.string().min(1),
  layout_name: z.string().min(1),
  instance_id: z.string().optional(),
  template_html: z.string().optional(),
  tokens: z.array(z.string().min(1)).optional(),
});

const PageDataSchema = z.object({
  page_number: z.number().int().positive().optional(),
  page_type: z.string().optional(),
  instance_id: z.string().optional(),
  tokens: z.record(z.string(), z.any()).default({}),
});

export const SchemaDataSchema = z.object({
  global: z.record(z.string(), z.any()).default({}),
  pages: z.array(PageDataSchema).default([]),
});

export const ManifestInputSchema = z.object({
  source_url: z.string().url().optional(),
  file_base64: z.string().min(1).optional(),
  filename: z.string().optional(),
}).refine(
  (data) => Boolean(data.source_url) !== Boolean(data.file_base64),
  { message: "Provide exactly one of source_url or file_base64" },
);

function formatIssues(issues = []) {
  return issues.map((issue) => {
    const path = issue.path?.length ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}

function collectRequiredGlobalFields(schema) {
  const required = new Set();
  const globalFields = schema?.global_fields || {};
  for (const [name, def] of Object.entries(globalFields)) {
    if (def?.required) required.add(name);
  }
  return required;
}

function collectRequiredPageTokens(schema, pageType) {
  const required = new Set();

  const pageTypeDefs = schema?.page_type_definitions?.[pageType]?.token_defs || [];
  for (const def of pageTypeDefs) {
    if (def?.required && def?.name) required.add(def.name);
  }

  const tokenDefs = schema?.token_definitions?.[pageType] || [];
  for (const def of tokenDefs) {
    if (def?.required && def?.name) required.add(def.name);
  }

  const pageTypeMap = Array.isArray(schema?.page_type_map) ? schema.page_type_map : [];
  const mapEntry = pageTypeMap.find((entry) => entry.page_type === pageType);
  const tokenList = Array.isArray(mapEntry?.token_list) ? mapEntry.token_list : [];
  for (const tokenName of tokenList) {
    if (tokenName) required.add(tokenName);
  }

  return required;
}

export function validateContentSchema(data) {
  const parsed = ContentSchemaSchema.safeParse(data);
  if (!parsed.success) {
    return {
      valid: false,
      issues: formatIssues(parsed.error.issues),
    };
  }

  return {
    valid: true,
    issues: [],
  };
}

export function validateSchemaData(schema, data) {
  const schemaParse = ContentSchemaSchema.safeParse(schema);
  if (!schemaParse.success) {
    return {
      valid: false,
      issues: [
        "schema: invalid content schema",
        ...formatIssues(schemaParse.error.issues).map((issue) => `schema.${issue}`),
      ],
    };
  }

  const dataParse = SchemaDataSchema.safeParse(data);
  if (!dataParse.success) {
    return {
      valid: false,
      issues: formatIssues(dataParse.error.issues),
    };
  }

  const issues = [];
  const parsedSchema = schemaParse.data;
  const parsedData = dataParse.data;

  const requiredGlobal = collectRequiredGlobalFields(parsedSchema);
  for (const key of requiredGlobal) {
    if (parsedData.global[key] == null || parsedData.global[key] === "") {
      issues.push(`global.${key}: required value is missing`);
    }
  }

  for (const page of parsedData.pages) {
    const pageType = page.page_type;
    if (!pageType) continue;
    const requiredTokens = collectRequiredPageTokens(parsedSchema, pageType);
    for (const tokenName of requiredTokens) {
      const value = page.tokens[tokenName];
      if (value == null || value === "") {
        const pageLabel = page.page_number ? `pages.${page.page_number}` : `pages.${pageType}`;
        issues.push(`${pageLabel}.${tokenName}: required token is missing`);
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
