/**
 * REST endpoints for Report Engine v2 modules.
 *
 * POST   /api/v2-modules                    → add module (mirrors mcp-v2 add_module)
 * POST   /api/v2-modules/:id/duplicate      → clone module directly after the source
 * PATCH  /api/v2-modules/:id                → update content/style, re-renders html_cache
 * DELETE /api/v2-modules/:id                → delete module
 *
 * Auth: Hub JWT.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubOrEditorAuth, editorScopeMismatch } from "./auth-middleware.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";
import { getSql } from "./db.js";

const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "http://localhost:8080";

const VALID_MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout", "freeform"];
const VALID_COLUMNS = ["full", "half", "primary", "sidebar", "thirds", "wide-left", "quarter"];
const MAX_SLOTS = { full: 1, half: 2, primary: 2, sidebar: 2, thirds: 3, "wide-left": 2, quarter: 2 };
const VALID_CATEGORIES = ["text", "data", "media"];

const addSchema = z.object({
  report_id: z.string().uuid(),
  module_type: z.enum(VALID_MODULE_TYPES),
  content: z.record(z.string(), z.any()).optional(),
  style: z.record(z.string(), z.any()).optional(),
  html_content: z.string().optional(),
  after_module_id: z.string().uuid().nullable().optional(),
}).refine(d => d.html_content || d.content, { message: "Either html_content or content is required" });

const updateSchema = z.object({
  content: z.record(z.string(), z.any()).optional(),
  style: z.record(z.string(), z.any()).optional(),
  html_content: z.string().optional(),
  order_index: z.number().int().min(0).optional(),
  // Per-module background spec. See migration 022 for full shape.
  // Stored as JSONB; editor-side writes the whole object or null to
  // clear.
  background: z.record(z.string(), z.any()).nullable().optional(),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

function getIdFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-modules");
  if (idx === -1) return null;
  return parts[idx + 1] ?? null;
}

// Detects the trailing segment after the module id — used for action
// endpoints like /v2-modules/:id/duplicate.
function getActionFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-modules");
  if (idx === -1) return null;
  return parts[idx + 2] ?? null;
}

async function callRenderService(path, body, tenantId) {
  const token = mintSmyraRenderToken({ tenantId });
  const res = await fetch(`${RENDER_SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Render service ${path} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchBrandContext(sql, brandId) {
  if (!brandId) return { tokens: {}, fonts: [], logos: [] };
  const brands = await sql`SELECT tokens FROM brands WHERE id = ${brandId} LIMIT 1`;
  const tokens = brands[0]?.tokens || {};
  const fonts = await sql`SELECT family, weight, style, format, data_base64 FROM brand_fonts WHERE brand_id = ${brandId}`;
  const logos = await sql`SELECT variant, format, data_base64 FROM brand_logos WHERE brand_id = ${brandId}`;
  return { tokens, fonts, logos };
}

function validateLayoutContent(content) {
  const columns = content.columns;
  if (!columns || !VALID_COLUMNS.includes(columns)) {
    return `Layout modules require content.columns to be one of: ${VALID_COLUMNS.join(", ")}`;
  }
  const slots = content.slots;
  if (slots && Array.isArray(slots)) {
    if (slots.length > MAX_SLOTS[columns]) {
      return `Column preset "${columns}" supports max ${MAX_SLOTS[columns]} slots, got ${slots.length}.`;
    }
    for (const slot of slots) {
      if (slot.category && !VALID_CATEGORIES.includes(slot.category)) {
        return `Invalid slot category "${slot.category}". Must be one of: ${VALID_CATEGORIES.join(", ")}`;
      }
    }
  }
  return null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubOrEditorAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const moduleId = getIdFromPath(event.path);
  const action = getActionFromPath(event.path);

  // Hub-JWT path: the JWT org is the only trusted tenant. A Hub JWT with no
  // tenant_id has no org context → FAIL CLOSED (403). Editor tokens are
  // report-scoped and verified separately (assertEditorScopeForReport).
  const hubTenantId = auth.editorScope
    ? null
    : (auth.payload?.tenant_id ?? auth.payload?.claims?.tenant_id ?? null);
  if (!auth.editorScope && !hubTenantId) {
    return json(event, 403, { error: "Token carries no tenant — access denied" });
  }

  // Helper: verify auth is allowed to operate on the report that owns a
  // module/payload. Editor tokens are matched against their scoped reportId;
  // Hub JWTs are matched against the report's tenant_id (resolved from the DB).
  // Pass the report's tenant_id when it's already loaded to avoid a re-query.
  async function assertReportAccess(reportId, knownTenantId) {
    if (auth.editorScope) {
      if (editorScopeMismatch(auth, reportId)) {
        return json(event, 403, { error: "Editor token does not match report" });
      }
      return null;
    }
    // Hub JWT — require the report's tenant to equal the caller's tenant.
    let tenantId = knownTenantId;
    if (tenantId === undefined) {
      const rows = await sql`SELECT tenant_id FROM v2_reports WHERE id = ${reportId} LIMIT 1`;
      if (!rows.length) return json(event, 404, { error: "Report not found" });
      tenantId = rows[0].tenant_id;
    }
    if (tenantId !== hubTenantId) {
      return json(event, 403, { error: "Report not accessible in this tenant" });
    }
    return null;
  }

  // Back-compat alias — the old name only checked editor scope. Now it also
  // enforces the Hub-JWT tenant. Callers that already hold the report's
  // tenant_id should call assertReportAccess directly to skip the re-query.
  async function assertEditorScopeForReport(reportId) {
    return assertReportAccess(reportId);
  }

  try {
    if (event.httpMethod === "POST" && !moduleId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = addSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { report_id, module_type, content, style, after_module_id, html_content } = parsed.data;

      if (module_type === "layout" && !html_content) {
        const err = validateLayoutContent(content);
        if (err) return json(event, 400, { error: err });
      }

      const reports = await sql`SELECT id, brand_id, tenant_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
      if (!reports.length) return json(event, 404, { error: "Report not found" });
      const brandId = reports[0].brand_id;
      const tenantId = reports[0].tenant_id;

      // Tenant/scope check AFTER loading the report so we can match the Hub-JWT
      // tenant against the report's actual tenant_id (no second query).
      const scopeErr = await assertReportAccess(report_id, tenantId);
      if (scopeErr) return scopeErr;

      let orderIndex;
      if (after_module_id) {
        const afterMods = await sql`
          SELECT order_index FROM v2_report_modules
          WHERE id = ${after_module_id} AND report_id = ${report_id} LIMIT 1
        `;
        if (!afterMods.length) return json(event, 400, { error: "after_module_id not in report" });
        const afterIdx = afterMods[0].order_index;
        await sql`
          UPDATE v2_report_modules SET order_index = order_index + 1
          WHERE report_id = ${report_id} AND order_index > ${afterIdx}
        `;
        orderIndex = afterIdx + 1;
      } else {
        const maxRows = await sql`
          SELECT COALESCE(MAX(order_index), -1) AS max_idx FROM v2_report_modules WHERE report_id = ${report_id}
        `;
        orderIndex = maxRows[0].max_idx + 1;
      }

      // Attach to a page — either inherit from the sibling we're
      // inserting after, or create a new page at the end. Without
      // this the module is orphaned (page_id = null) and silently
      // dropped from PDF rendering.
      let pageId = null;
      if (after_module_id) {
        const sibling = await sql`
          SELECT page_id FROM v2_report_modules
          WHERE id = ${after_module_id} AND report_id = ${report_id} LIMIT 1
        `;
        pageId = sibling[0]?.page_id || null;
      }
      if (!pageId) {
        // Create a new page slotted at the end of the report.
        const newPageId = randomUUID();
        const pageType = module_type === "cover" ? "cover"
          : module_type === "back_cover" ? "back_cover"
          : module_type === "chapter_break" ? "chapter_break"
          : "content";
        const maxRes = await sql`
          SELECT COALESCE(MAX(page_number), 0) AS m FROM v2_report_pages WHERE report_id = ${report_id}
        `;
        const nextPageNum = (maxRes[0]?.m || 0) + 1;
        await sql`
          INSERT INTO v2_report_pages (id, report_id, page_number, page_type)
          VALUES (${newPageId}, ${report_id}, ${nextPageNum}, ${pageType})
        `;
        pageId = newPageId;
      }

      const newId = randomUUID();
      await sql`
        INSERT INTO v2_report_modules (id, report_id, page_id, module_type, order_index, content, style, html_content)
        VALUES (
          ${newId}, ${report_id}, ${pageId}, ${module_type}, ${orderIndex},
          ${JSON.stringify(content || {})}::jsonb,
          ${JSON.stringify(style || {})}::jsonb,
          ${html_content || null}
        )
      `;

      let heightMm = null;
      let htmlCache = null;
      try {
        const brand = await fetchBrandContext(sql, brandId);
        const renderPayload = html_content
          ? { html_content, brand_tokens: brand.tokens, brand_fonts: brand.fonts, mode: "draft" }
          : { module_id: newId, module_type, content, style: style || {}, brand_tokens: brand.tokens, brand_fonts: brand.fonts };
        const rr = await callRenderService("/render/module", renderPayload, tenantId);
        heightMm = rr.height_mm ?? null;
        htmlCache = (rr.html_fragment ?? rr.html ?? null);
        await sql`
          UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
          WHERE id = ${newId}
        `;
      } catch (e) {
        console.warn("[v2-modules] render failed:", e.message);
      }
      // Fallback so the module always renders SOMETHING rather than a
      // blank card when the render service is slow / down / rejecting.
      if (!htmlCache && html_content) {
        await sql`
          UPDATE v2_report_modules SET html_cache = ${html_content}
          WHERE id = ${newId} AND html_cache IS NULL
        `;
      }

      const rows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, background, created_at, updated_at
        FROM v2_report_modules WHERE id = ${newId}
      `;
      return json(event, 201, { item: rows[0] });
    }

    // Duplicate: clone the source module, place it directly after the
    // original, shift subsequent siblings down one slot. No re-render —
    // we copy html_cache + height_mm from the source so the duplicate
    // shows up in the preview instantly.
    if (event.httpMethod === "POST" && moduleId && action === "duplicate") {
      const srcRows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style,
               html_content, html_cache, height_mm, background
        FROM v2_report_modules WHERE id = ${moduleId} LIMIT 1
      `;
      if (!srcRows.length) return json(event, 404, { error: "Module not found" });
      const src = srcRows[0];

      const scopeErr = await assertEditorScopeForReport(src.report_id);
      if (scopeErr) return scopeErr;

      await sql`
        UPDATE v2_report_modules SET order_index = order_index + 1
        WHERE report_id = ${src.report_id} AND order_index > ${src.order_index}
      `;

      const newId = randomUUID();
      await sql`
        INSERT INTO v2_report_modules (
          id, report_id, page_id, module_type, order_index,
          content, style, html_content, html_cache, height_mm, background
        ) VALUES (
          ${newId}, ${src.report_id}, ${src.page_id || null}, ${src.module_type}, ${src.order_index + 1},
          ${JSON.stringify(src.content || {})}::jsonb,
          ${JSON.stringify(src.style || {})}::jsonb,
          ${src.html_content || null},
          ${src.html_cache || null},
          ${src.height_mm || null},
          ${JSON.stringify(src.background || {})}::jsonb
        )
      `;

      const rows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style,
               html_cache, height_mm, background, created_at, updated_at
        FROM v2_report_modules WHERE id = ${newId}
      `;
      return json(event, 201, { item: rows[0] });
    }

    if (event.httpMethod === "PATCH" && moduleId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
      if (
        !parsed.data.content &&
        !parsed.data.style &&
        !parsed.data.html_content &&
        parsed.data.order_index === undefined &&
        parsed.data.background === undefined
      ) {
        return json(event, 400, { error: "Provide html_content, content, style, order_index, or background" });
      }

      const mods = await sql`
        SELECT m.id, m.report_id, m.module_type, m.content, m.style, m.html_content, m.html_cache, m.order_index,
               r.brand_id, r.tenant_id, r.document_css, r.document_css_overrides
        FROM v2_report_modules m
        JOIN v2_reports r ON r.id = m.report_id
        WHERE m.id = ${moduleId} LIMIT 1
      `;
      if (!mods.length) return json(event, 404, { error: "Module not found" });
      const mod = mods[0];

      const scopeErr = await assertReportAccess(mod.report_id, mod.tenant_id);
      if (scopeErr) return scopeErr;

      // Background-only request — update the JSONB column without
      // touching html_cache or re-rendering. The HtmlPreview layer
      // reads background from the module row client-side, so no
      // render round-trip needed.
      if (
        parsed.data.background !== undefined &&
        !parsed.data.content &&
        !parsed.data.style &&
        !parsed.data.html_content &&
        parsed.data.order_index === undefined
      ) {
        await sql`
          UPDATE v2_report_modules
          SET background = ${JSON.stringify(parsed.data.background || {})}::jsonb,
              updated_at = NOW()
          WHERE id = ${moduleId}
        `;
        // Background is a visual editor edit → mark editor_updated_at (guarded, see migration 041).
        try {
          await sql`UPDATE v2_report_modules SET editor_updated_at = NOW() WHERE id = ${moduleId}`;
        } catch (e) {
          console.warn(`[v2-modules] editor_updated_at not set (column missing? run migration 041): ${e?.message || e}`);
        }
        const rows = await sql`
          SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, background, created_at, updated_at
          FROM v2_report_modules WHERE id = ${moduleId}
        `;
        return json(event, 200, { item: rows[0] });
      }

      // Reorder-only request: adjust order_index of all modules to keep
      // a contiguous sequence, then return the updated row.
      if (
        parsed.data.order_index !== undefined &&
        !parsed.data.content &&
        !parsed.data.style &&
        !parsed.data.html_content
      ) {
        const targetIdx = parsed.data.order_index;
        const currentIdx = mod.order_index;
        if (targetIdx !== currentIdx) {
          if (targetIdx > currentIdx) {
            // Moving down: shift intermediate modules up
            await sql`
              UPDATE v2_report_modules
              SET order_index = order_index - 1
              WHERE report_id = ${mod.report_id}
                AND order_index > ${currentIdx}
                AND order_index <= ${targetIdx}
            `;
          } else {
            // Moving up: shift intermediate modules down
            await sql`
              UPDATE v2_report_modules
              SET order_index = order_index + 1
              WHERE report_id = ${mod.report_id}
                AND order_index >= ${targetIdx}
                AND order_index < ${currentIdx}
            `;
          }
          await sql`
            UPDATE v2_report_modules
            SET order_index = ${targetIdx}, updated_at = NOW()
            WHERE id = ${moduleId}
          `;
        }
        const rows = await sql`
          SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, background, created_at, updated_at
          FROM v2_report_modules WHERE id = ${moduleId}
        `;
        return json(event, 200, { item: rows[0] });
      }

      const newHtmlContent = parsed.data.html_content ?? mod.html_content ?? null;
      const newContent = parsed.data.content || mod.content;
      const newStyle = parsed.data.style || mod.style;

      if (mod.module_type === "layout" && parsed.data.content && !newHtmlContent) {
        const err = validateLayoutContent(newContent);
        if (err) return json(event, 400, { error: err });
      }

      // Persist content/style/html_content first; we keep the existing
      // html_cache + height_mm in place so a render failure below doesn't
      // wipe the last good design — editor preview + PDF stay readable
      // until the next successful render lands.
      await sql`
        UPDATE v2_report_modules
        SET content = ${JSON.stringify(newContent)}::jsonb,
            style = ${JSON.stringify(newStyle)}::jsonb,
            html_content = ${newHtmlContent},
            updated_at = NOW()
        WHERE id = ${moduleId}
      `;
      // Authoritative editor edit → mark editor_updated_at so a later Claude re-compose
      // (persist_freeform_pages) PRESERVES this page's html_cache instead of clobbering it.
      // Guarded: tolerate the column not existing yet (migration 041) without breaking the save.
      try {
        await sql`UPDATE v2_report_modules SET editor_updated_at = NOW() WHERE id = ${moduleId}`;
      } catch (e) {
        console.warn(`[v2-modules] editor_updated_at not set (column missing? run migration 041): ${e?.message || e}`);
      }

      let renderOk = false;
      let renderError = null;
      try {
        const brand = await fetchBrandContext(sql, mod.brand_id);
        // Freeform alpha-v3 modules must render against the report's full
        // document_css cascade, otherwise html_cache lands as bare HTML
        // (no design language applied) and the editor + next PDF render
        // both lose the design. Legacy v2 component modules (no
        // html_content) keep the old payload shape — render.py picks the
        // freeform branch only when document_css + html_content are both
        // present.
        const renderPayload = newHtmlContent
          ? {
              html_content: newHtmlContent,
              brand_tokens: brand.tokens,
              brand_fonts: brand.fonts,
              document_css: mod.document_css ?? "",
              document_css_overrides: mod.document_css_overrides ?? "",
              mode: "draft",
            }
          : { module_id: moduleId, module_type: mod.module_type, content: newContent, style: newStyle, brand_tokens: brand.tokens, brand_fonts: brand.fonts };
        const rr = await callRenderService("/render/module", renderPayload, mod.tenant_id);
        const rendered = rr.html_fragment ?? rr.html ?? null;
        if (rendered) {
          await sql`
            UPDATE v2_report_modules SET html_cache = ${rendered}, height_mm = ${rr.height_mm ?? null}
            WHERE id = ${moduleId}
          `;
          renderOk = true;
        } else {
          renderError = "render service returned empty html_fragment";
        }
      } catch (e) {
        renderError = e.message || String(e);
        console.warn("[v2-modules] re-render failed:", renderError);
      }

      // True-fresh-edit case: a freeform module with no prior html_cache
      // and a render failure. Without a fallback the editor would show a
      // blank card. Use newHtmlContent as a degraded cache; design will
      // be re-applied on the next successful render.
      if (!renderOk && newHtmlContent && !mod.html_cache) {
        await sql`
          UPDATE v2_report_modules SET html_cache = ${newHtmlContent}
          WHERE id = ${moduleId} AND html_cache IS NULL
        `;
        console.warn(`[v2-modules] fallback html_cache := html_content for ${moduleId} (no prior cache)`);
      }

      const rows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, background, created_at, updated_at
        FROM v2_report_modules WHERE id = ${moduleId}
      `;
      return json(event, 200, {
        item: rows[0],
        // Surface render outcome so the editor can toast on failure
        // ("Re-render failed — design may not have applied"). Previously
        // the failure was silent and users only noticed the next time
        // they opened the PDF.
        render: renderOk
          ? { ok: true }
          : { ok: false, error: renderError, used_fallback: !!(newHtmlContent && !mod.html_cache) },
      });
    }

    if (event.httpMethod === "DELETE" && moduleId) {
      const mods = await sql`SELECT report_id, order_index FROM v2_report_modules WHERE id = ${moduleId} LIMIT 1`;
      if (!mods.length) return json(event, 404, { error: "Module not found" });
      const { report_id, order_index } = mods[0];

      const scopeErr = await assertEditorScopeForReport(report_id);
      if (scopeErr) return scopeErr;

      await sql`DELETE FROM v2_report_modules WHERE id = ${moduleId}`;
      await sql`
        UPDATE v2_report_modules SET order_index = order_index - 1
        WHERE report_id = ${report_id} AND order_index > ${order_index}
      `;
      return noContent(event);
    }

    return json(event, 405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[v2-modules]", err);
    return json(event, 500, { error: err.message });
  }
};
