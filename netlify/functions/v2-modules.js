/**
 * REST endpoints for Report Engine v2 modules.
 *
 * POST   /api/v2-modules            → add module (mirrors mcp-v2 add_module)
 * PATCH  /api/v2-modules/:id        → update content/style, re-renders html_cache
 * DELETE /api/v2-modules/:id        → delete module
 *
 * Auth: Hub JWT.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { mintSmyraRenderToken } from "./smyra-render-jwt.js";
import { getSql } from "./db.js";

const RENDER_SERVICE_URL = process.env.RENDER_SERVICE_URL || "http://localhost:8080";

const VALID_MODULE_TYPES = ["cover", "chapter_break", "back_cover", "layout"];
const VALID_COLUMNS = ["full", "half", "primary", "sidebar", "thirds", "wide-left", "quarter"];
const MAX_SLOTS = { full: 1, half: 2, primary: 2, sidebar: 2, thirds: 3, "wide-left": 2, quarter: 2 };
const VALID_CATEGORIES = ["text", "data", "media"];

const addSchema = z.object({
  report_id: z.string().uuid(),
  module_type: z.enum(VALID_MODULE_TYPES),
  content: z.record(z.string(), z.any()),
  style: z.record(z.string(), z.any()).optional(),
  after_module_id: z.string().uuid().nullable().optional(),
});

const updateSchema = z.object({
  content: z.record(z.string(), z.any()).optional(),
  style: z.record(z.string(), z.any()).optional(),
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

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const moduleId = getIdFromPath(event.path);

  try {
    if (event.httpMethod === "POST" && !moduleId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = addSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { report_id, module_type, content, style, after_module_id } = parsed.data;

      if (module_type === "layout") {
        const err = validateLayoutContent(content);
        if (err) return json(event, 400, { error: err });
      }

      const reports = await sql`SELECT id, brand_id, tenant_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
      if (!reports.length) return json(event, 404, { error: "Report not found" });
      const brandId = reports[0].brand_id;
      const tenantId = reports[0].tenant_id;

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

      const newId = randomUUID();
      await sql`
        INSERT INTO v2_report_modules (id, report_id, module_type, order_index, content, style)
        VALUES (
          ${newId}, ${report_id}, ${module_type}, ${orderIndex},
          ${JSON.stringify(content)}::jsonb,
          ${JSON.stringify(style || {})}::jsonb
        )
      `;

      let heightMm = null;
      let htmlCache = null;
      try {
        const brand = await fetchBrandContext(sql, brandId);
        const rr = await callRenderService("/render/module", {
          module_id: newId,
          module_type,
          content,
          style: style || {},
          brand_tokens: brand.tokens,
          brand_fonts: brand.fonts,
        }, tenantId);
        heightMm = rr.height_mm ?? null;
        htmlCache = (rr.html_fragment ?? rr.html ?? null);
        await sql`
          UPDATE v2_report_modules SET html_cache = ${htmlCache}, height_mm = ${heightMm}
          WHERE id = ${newId}
        `;
      } catch (e) {
        console.warn("[v2-modules] render failed:", e.message);
      }

      const rows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, created_at, updated_at
        FROM v2_report_modules WHERE id = ${newId}
      `;
      return json(event, 201, { item: rows[0] });
    }

    if (event.httpMethod === "PATCH" && moduleId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
      if (!parsed.data.content && !parsed.data.style) {
        return json(event, 400, { error: "Provide content and/or style" });
      }

      const mods = await sql`
        SELECT m.id, m.report_id, m.module_type, m.content, m.style, r.brand_id, r.tenant_id
        FROM v2_report_modules m
        JOIN v2_reports r ON r.id = m.report_id
        WHERE m.id = ${moduleId} LIMIT 1
      `;
      if (!mods.length) return json(event, 404, { error: "Module not found" });
      const mod = mods[0];

      const newContent = parsed.data.content || mod.content;
      const newStyle = parsed.data.style || mod.style;

      if (mod.module_type === "layout" && parsed.data.content) {
        const err = validateLayoutContent(newContent);
        if (err) return json(event, 400, { error: err });
      }

      await sql`
        UPDATE v2_report_modules
        SET content = ${JSON.stringify(newContent)}::jsonb,
            style = ${JSON.stringify(newStyle)}::jsonb,
            html_cache = NULL,
            height_mm = NULL,
            updated_at = NOW()
        WHERE id = ${moduleId}
      `;

      try {
        const brand = await fetchBrandContext(sql, mod.brand_id);
        const rr = await callRenderService("/render/module", {
          module_id: moduleId,
          module_type: mod.module_type,
          content: newContent,
          style: newStyle,
          brand_tokens: brand.tokens,
          brand_fonts: brand.fonts,
        }, mod.tenant_id);
        await sql`
          UPDATE v2_report_modules SET html_cache = ${(rr.html_fragment ?? rr.html ?? null)}, height_mm = ${rr.height_mm ?? null}
          WHERE id = ${moduleId}
        `;
      } catch (e) {
        console.warn("[v2-modules] re-render failed:", e.message);
      }

      const rows = await sql`
        SELECT id, report_id, page_id, module_type, order_index, content, style, html_cache, height_mm, created_at, updated_at
        FROM v2_report_modules WHERE id = ${moduleId}
      `;
      return json(event, 200, { item: rows[0] });
    }

    if (event.httpMethod === "DELETE" && moduleId) {
      const mods = await sql`SELECT report_id, order_index FROM v2_report_modules WHERE id = ${moduleId} LIMIT 1`;
      if (!mods.length) return json(event, 404, { error: "Module not found" });
      const { report_id, order_index } = mods[0];
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
