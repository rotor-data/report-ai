import { randomUUID } from "node:crypto";
import { getSql } from "../db.js";
import { validateHtml } from "../guardrails.js";
import { fillTokens, extractTokens } from "./token-fill.js";

function toPageTypeMapEntries(contentSchema) {
  if (Array.isArray(contentSchema?.page_type_map)) return contentSchema.page_type_map;
  if (Array.isArray(contentSchema?.pageTypeMap)) return contentSchema.pageTypeMap;
  return [];
}

function toPlanPattern(contentSchema) {
  if (Array.isArray(contentSchema?.page_plan_pattern)) return contentSchema.page_plan_pattern;
  if (Array.isArray(contentSchema?.pagePlanPattern)) return contentSchema.pagePlanPattern;
  return [];
}

function buildDefaultTemplate(pageType, tokenList = []) {
  const tokenRows = tokenList
    .map((token) => `<p><strong>${token}</strong>: [[${String(token).toUpperCase()}]]</p>`)
    .join("\n");

  return `<section class="module module-${pageType}">
  <div class="content-frame">
    <h2>${pageType.replaceAll("_", " ")}</h2>
    ${tokenRows || "<p></p>"}
  </div>
</section>`;
}

function normalizeTokenDefs(tokenSpec = [], tokenData = {}) {
  if (!Array.isArray(tokenSpec)) return [];

  if (tokenSpec.every((item) => typeof item === "string")) {
    return tokenSpec.map((name) => {
      const raw = tokenData?.[name] ?? tokenData?.[String(name).toUpperCase()] ?? tokenData?.[String(name).toLowerCase()];
      const type = raw && typeof raw === "object" && raw.chart_type ? "svg_chart" : "text";
      return { name: String(name).toUpperCase(), type, required: false };
    });
  }

  return tokenSpec
    .filter((item) => item && typeof item === "object" && item.name)
    .map((item) => ({
      ...item,
      name: String(item.name).toUpperCase(),
    }));
}

function normalizeTokenValues(values = {}) {
  if (!values || typeof values !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[String(key).toUpperCase()] = value;
  }
  return out;
}

function resolvePageData(schemaData = {}, page) {
  const pages = schemaData?.pages;
  if (Array.isArray(pages)) {
    const exact = pages.find((entry) => entry?.page_number === page.page_number);
    if (exact) return exact.tokens || exact;
    const byType = pages.find((entry) => entry?.page_type === page.page_type && (!entry?.instance_id || entry.instance_id === page.instance_id));
    if (byType) return byType.tokens || byType;
  }

  if (pages && typeof pages === "object") {
    const byNumber = pages[String(page.page_number)];
    if (byNumber) return byNumber.tokens || byNumber;

    const byType = pages[page.page_type];
    if (byType) {
      if (Array.isArray(byType)) {
        const byInstance = byType.find((entry) => !entry.instance_id || entry.instance_id === page.instance_id);
        return byInstance?.tokens || byInstance || {};
      }
      return byType.tokens || byType;
    }
  }

  return schemaData?.[page.page_type] || {};
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function buildPreviewDoc(fragmentHtml) {
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 20mm; }
    body { margin: 20mm; }
  </style>
</head>
<body>
${fragmentHtml}
</body>
</html>`;
}

async function loadSvgGenerators() {
  try {
    const mod = await import("./svg-generators.js");
    return mod || {};
  } catch {
    return {};
  }
}

async function loadCssBuilders() {
  const mod = await import("../mcp.js");
  return {
    buildDocumentCss: mod.buildDocumentCss,
    buildFontFaceCss: mod.buildFontFaceCss,
  };
}

export async function createPagePlan(manifestId, contentSchema, overrides = {}) {
  const sql = getSql();

  const mapEntries = toPageTypeMapEntries(contentSchema);
  const planPattern = toPlanPattern(contentSchema);

  const inferredPlan = planPattern.length > 0
    ? planPattern.map((entry, index) => {
      const candidate = Number(entry.page_number ?? entry.position);
      return {
        page_number: Number.isFinite(candidate) && candidate > 0 ? candidate : index + 1,
        page_type: entry.page_type || entry.type,
        instance_id: entry.instance_id,
      };
    })
    : mapEntries.map((entry, index) => ({
      page_number: index + 1,
      page_type: entry.page_type,
      instance_id: entry.instance_id,
    }));

  const pageOverrides = Array.isArray(overrides?.page_overrides) ? overrides.page_overrides : [];
  const templateOverrides = overrides?.template_html_by_type || {};

  const plannedRows = [];

  for (const page of inferredPlan) {
    const override = pageOverrides.find((candidate) => Number(candidate.page_number) === Number(page.page_number)) || {};
    const entry = mapEntries.find((candidate) => candidate.page_type === page.page_type) || {};

    const pageType = override.page_type || page.page_type;
    const layoutName = override.layout_name || entry.layout_name || pageType;
    const tokenList = Array.isArray(override.token_list)
      ? override.token_list
      : (Array.isArray(entry.token_list) ? entry.token_list : []);

    const templateHtml =
      override.template_html
      || templateOverrides[pageType]
      || entry.template_html
      || buildDefaultTemplate(pageType, tokenList);

    const tokens = Array.isArray(override.tokens) && override.tokens.length > 0
      ? override.tokens
      : tokenList;

    const rowId = override.id || randomUUID();

    const rows = await sql`
      INSERT INTO report_pages (id, manifest_id, page_number, page_type, layout_name, instance_id, template_html, tokens, created_at, updated_at)
      VALUES (
        ${rowId}::uuid,
        ${manifestId}::uuid,
        ${Number(page.page_number)},
        ${pageType},
        ${layoutName},
        ${override.instance_id || page.instance_id || null},
        ${templateHtml},
        ${JSON.stringify(tokens)}::jsonb,
        NOW(),
        NOW()
      )
      ON CONFLICT (manifest_id, page_number)
      DO UPDATE SET
        page_type = EXCLUDED.page_type,
        layout_name = EXCLUDED.layout_name,
        instance_id = EXCLUDED.instance_id,
        template_html = EXCLUDED.template_html,
        tokens = EXCLUDED.tokens,
        updated_at = NOW()
      RETURNING *
    `;

    plannedRows.push(rows[0]);
  }

  return {
    manifest_id: manifestId,
    page_count: plannedRows.length,
    pages: plannedRows.sort((a, b) => a.page_number - b.page_number),
  };
}

export async function generatePage(pageId, schemaData = {}, designTokens = {}) {
  const sql = getSql();

  const rows = await sql`
    SELECT rp.*, rm.design_tokens_extracted
    FROM report_pages rp
    JOIN report_manifests rm ON rm.id = rp.manifest_id
    WHERE rp.id = ${pageId}::uuid
    LIMIT 1
  `;

  if (!rows[0]) throw new Error("Page not found");

  const page = rows[0];
  const pageData = resolvePageData(schemaData, page);
  const tokenValues = normalizeTokenValues(pageData?.tokens || pageData || {});
  const tokenDefs = normalizeTokenDefs(page.tokens, tokenValues);
  const svgGenerators = await loadSvgGenerators();

  const colors = designTokens?.colors
    || designTokens
    || page.design_tokens_extracted?.colors
    || {};

  const tokenizedHtml = page.template_html || "";
  const fillResult = fillTokens(tokenizedHtml, tokenValues, tokenDefs, colors, svgGenerators);

  const validation = validateHtml(buildPreviewDoc(fillResult.html));
  const nonBlockingIssues = new Set(["cover module missing", "back_cover module missing"]);
  const blockingIssues = validation.issues.filter((issue) => !nonBlockingIssues.has(issue));

  const svgFragments = {};
  for (const [key, value] of Object.entries(tokenValues)) {
    if (!value || typeof value !== "object" || !value.chart_type) continue;
    if (typeof value.svg === "string") {
      svgFragments[key] = value.svg;
    }
  }

  const status = blockingIssues.length === 0 ? "rendered" : "error";

  const upsertRows = await sql`
    INSERT INTO report_generated_pages (id, page_id, html_output, svg_fragments, render_status, created_at, updated_at)
    VALUES (
      ${randomUUID()}::uuid,
      ${page.id}::uuid,
      ${fillResult.html},
      ${JSON.stringify(svgFragments)}::jsonb,
      ${status},
      NOW(),
      NOW()
    )
    ON CONFLICT (page_id)
    DO UPDATE SET
      html_output = EXCLUDED.html_output,
      svg_fragments = EXCLUDED.svg_fragments,
      render_status = EXCLUDED.render_status,
      updated_at = NOW()
    RETURNING *
  `;

  await sql`
    UPDATE report_pages
    SET updated_at = NOW()
    WHERE id = ${page.id}::uuid
  `;

  return {
    page_id: page.id,
    page_number: page.page_number,
    render_status: upsertRows[0].render_status,
    unfilled_tokens: fillResult.unfilled_tokens,
    issues: blockingIssues,
    html: fillResult.html,
  };
}

export async function generateAllPages(manifestId, schemaData = {}, designTokens = {}, options = {}) {
  const sql = getSql();
  const concurrency = Math.max(1, Number(options?.concurrency || 5));

  const pages = await sql`
    SELECT id, page_number
    FROM report_pages
    WHERE manifest_id = ${manifestId}::uuid
    ORDER BY page_number ASC
  `;

  const results = [];
  for (const batch of chunk(pages, concurrency)) {
    const batchResults = await Promise.all(
      batch.map((page) => generatePage(page.id, schemaData, designTokens)),
    );
    results.push(...batchResults);
  }

  return {
    manifest_id: manifestId,
    page_count: pages.length,
    rendered: results.filter((result) => result.render_status === "rendered").length,
    errored: results.filter((result) => result.render_status === "error").length,
    pages: results,
  };
}

export async function assembleFullDocument(manifestId) {
  const sql = getSql();

  const manifestRows = await sql`
    SELECT id, design_tokens_extracted
    FROM report_manifests
    WHERE id = ${manifestId}::uuid
    LIMIT 1
  `;
  if (!manifestRows[0]) throw new Error("Manifest not found");

  const pageRows = await sql`
    SELECT rp.page_number, rp.page_type, rp.template_html, rgp.html_output, rgp.render_status
    FROM report_pages rp
    LEFT JOIN report_generated_pages rgp ON rgp.page_id = rp.id
    WHERE rp.manifest_id = ${manifestId}::uuid
    ORDER BY rp.page_number ASC
  `;

  if (pageRows.length === 0) throw new Error("No pages found for manifest");

  const designSystem = manifestRows[0].design_tokens_extracted || {};
  const customFonts = Array.isArray(designSystem?.custom_fonts) ? designSystem.custom_fonts : [];
  const { buildDocumentCss, buildFontFaceCss } = await loadCssBuilders();

  const css = `${buildFontFaceCss(customFonts)}\n${buildDocumentCss(designSystem, customFonts)}\n
.v4-page {
  page-break-before: always;
}
.v4-page:first-child {
  page-break-before: auto;
}
`;

  const pagesHtml = pageRows
    .map((row) => {
      const pageHtml = row.html_output || row.template_html || "";
      return `<section class="v4-page" data-page="${row.page_number}" data-page-type="${row.page_type}">\n${pageHtml}\n</section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
${css}
  </style>
</head>
<body>
${pagesHtml}
</body>
</html>`;

  const validation = validateHtml(html);

  return {
    manifest_id: manifestId,
    page_count: pageRows.length,
    html,
    valid: validation.valid,
    issues: validation.issues,
  };
}

export function extractPageTokens(templateHtml = "") {
  return extractTokens(templateHtml);
}
