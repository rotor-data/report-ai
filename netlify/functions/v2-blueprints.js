/**
 * REST endpoints for Report Engine v2 blueprints.
 *
 * GET    /api/v2-blueprints                        → list (filtered)
 *        ?brand_id=...      — brand-owned
 *        ?visibility=smyra  — platform templates
 *        ?document_type=... — filter by doctype
 *        ?style=...         — filter by style_direction
 * GET    /api/v2-blueprints/:id                    → single blueprint
 * POST   /api/v2-blueprints                        → create/save blueprint
 *        Legacy shape: { report_id, name }         — snapshot from report
 *        Smart shape:  { name, slots, ... }        — intent-driven
 * POST   /api/v2-blueprints/:id                    → update in place
 * POST   /api/v2-blueprints/create-from            → clone into a new report
 *        body: { blueprint_id, title, document_type }
 * DELETE /api/v2-blueprints/:id                    → remove
 *
 * Auth: Hub JWT (primary). Smart-shape create / update requires hub-
 * level scope — Smyra blueprints are system content, not user-editable.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

// ── Schemas ────────────────────────────────────────────────────────

const legacySaveSchema = z.object({
  report_id: z.string().uuid(),
  name: z.string().min(1),
});

const createFromSchema = z.object({
  blueprint_id: z.string().uuid(),
  title: z.string().min(1),
  document_type: z.string().min(1),
});

const slotSchema = z.object({
  slot_id: z.string().min(1),
  role: z.string().min(1),                    // component_type key
  required: z.boolean().optional().default(false),
  intent: z.string().optional(),               // "3-6 KPIs that set the scene"
  notes: z.string().optional(),                // extra guidance to Claude
});

const smartSaveSchema = z.object({
  name: z.string().min(1),
  visibility: z.enum(["private", "brand", "smyra"]).default("private"),
  brand_id: z.string().uuid().nullable().optional(),
  owner_tenant_id: z.string().uuid().nullable().optional(),
  document_type: z.string().optional(),
  style_direction: z.string().optional(),
  tagline: z.string().optional(),
  chat_summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  slots: z.array(slotSchema),
  narrative_guidance: z.record(z.string(), z.any()).optional(),
  pages_estimate: z.number().int().optional(),
  page_format: z.string().optional().default("a4_portrait"),
  thumbnail_small_base64: z.string().optional(),
  thumbnail_url: z.string().optional(),
});

const updateSchema = smartSaveSchema.partial();

// ── Helpers ────────────────────────────────────────────────────────

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return null; }
}

function getIdFromPath(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-blueprints");
  if (idx === -1) return null;
  const next = parts[idx + 1];
  if (!next || next === "create-from") return null;
  return next;
}

function getSubpathFromPath(path = "") {
  // /v2-blueprints/:id/thumbnail → "thumbnail"
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("v2-blueprints");
  if (idx === -1) return null;
  return parts[idx + 2] || null;
}

// Lazy-load blob store so this file doesn't break when the module is
// imported without the Netlify runtime (e.g. local unit test).
async function getBlobStore(event) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore("report-ai-blueprint-thumbs");
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "report-ai-blueprint-thumbs", siteID, token });
    throw new Error(`Cannot access blob store "report-ai-blueprint-thumbs"`);
  }
}

function stripDataUri(b64) {
  if (!b64 || typeof b64 !== "string") return b64;
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma > 0) return b64.slice(comma + 1);
  return b64;
}

function isCreateFromPath(path = "") {
  return path.split("?")[0].endsWith("/create-from");
}

// Pick one of the two save shapes based on body shape. Smart shape
// has `slots` and no `report_id`; legacy is the opposite.
function detectSaveShape(body) {
  if (Array.isArray(body?.slots)) return "smart";
  if (body?.report_id) return "legacy";
  return null;
}

// Column list used in SELECTs. Keep in sync with migration 023.
const SELECT_COLS = `
  id, brand_id, owner_tenant_id, visibility, name, tagline, chat_summary,
  document_type, style_direction, tags,
  slots, narrative_guidance,
  thumbnail_small_base64, thumbnail_url,
  pages_estimate, page_format,
  source_report_id, modules,
  created_at, updated_at
`;

function shapeRow(r) {
  // Expose a consistent client-side shape. modules/slots are JSONB →
  // the serverless driver may or may not parse depending on type casts.
  return {
    ...r,
    slots: typeof r.slots === "string" ? JSON.parse(r.slots) : r.slots,
    modules: typeof r.modules === "string" ? JSON.parse(r.modules) : r.modules,
    narrative_guidance:
      typeof r.narrative_guidance === "string"
        ? JSON.parse(r.narrative_guidance)
        : r.narrative_guidance,
    tags: r.tags || [],
  };
}

// ── Handler ────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const blueprintId = getIdFromPath(event.path);
  const subpath = getSubpathFromPath(event.path);

  try {
    // ── POST /api/v2-blueprints/:id/thumbnail ─────────────────
    if (event.httpMethod === "POST" && blueprintId && subpath === "thumbnail") {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const largePng = stripDataUri(body.png_base64 || body.large_png_base64);
      const smallPng = stripDataUri(body.small_png_base64);
      if (!largePng) {
        return json(event, 400, {
          error: "png_base64 (large, ~400x567) is required. small_png_base64 (~96x128, inlined) is optional.",
        });
      }

      // Save the large PNG as a blob — URL goes in thumbnail_url so
      // MCP responses can point at it with no auth. The blob key embeds
      // the blueprint id and a cache-busting timestamp so updates don't
      // get served stale.
      const blobKey = `bp-${blueprintId}-${Date.now()}.png`;
      const store = await getBlobStore(event);
      const pngBytes = Buffer.from(largePng, "base64");
      await store.set(blobKey, pngBytes, { metadata: { blueprint_id: blueprintId } });

      const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "https://rotor-report-ai.netlify.app";
      const thumbUrl = `${siteUrl}/api/v2-blueprint-thumbnail?key=${encodeURIComponent(blobKey)}`;

      // Inline small thumbnail (for chat surfacing). Data-URI form so
      // it's embeddable verbatim in markdown / tool results.
      const smallInline = smallPng ? `data:image/png;base64,${smallPng}` : null;

      const rows = await sql`
        UPDATE report_blueprints
        SET thumbnail_url = ${thumbUrl},
            thumbnail_small_base64 = ${smallInline}
        WHERE id = ${blueprintId}
        RETURNING id, thumbnail_url, thumbnail_small_base64
      `;
      if (!rows.length) return json(event, 404, { error: "Blueprint not found" });
      return json(event, 200, {
        blueprint_id: blueprintId,
        thumbnail_url: rows[0].thumbnail_url,
        has_inline: !!rows[0].thumbnail_small_base64,
        blob_key: blobKey,
      });
    }

    // ── GET /api/v2-blueprints/:id ─────────────────────────────
    if (event.httpMethod === "GET" && blueprintId) {
      const rows = await sql`
        SELECT ${sql.unsafe(SELECT_COLS)}
        FROM report_blueprints WHERE id = ${blueprintId} LIMIT 1
      `;
      if (!rows.length) return json(event, 404, { error: "Blueprint not found" });
      return json(event, 200, { item: shapeRow(rows[0]) });
    }

    // ── GET /api/v2-blueprints (list with filters) ────────────
    if (event.httpMethod === "GET") {
      const qs = event.queryStringParameters || {};
      const { brand_id, visibility, document_type, style, tenant_id } = qs;

      const clauses = [];
      const params = [];
      if (visibility) { clauses.push(`visibility = $${params.length + 1}`); params.push(visibility); }
      if (brand_id)   { clauses.push(`brand_id = $${params.length + 1}`); params.push(brand_id); }
      if (tenant_id)  { clauses.push(`owner_tenant_id = $${params.length + 1}`); params.push(tenant_id); }
      if (document_type) { clauses.push(`document_type = $${params.length + 1}`); params.push(document_type); }
      if (style)         { clauses.push(`style_direction = $${params.length + 1}`); params.push(style); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      // Fall back to SELECT-without-thumbnails when thumbnails may be
      // large; list endpoint still includes thumbnail_small_base64 since
      // that's exactly what the chat-surface needs inline.
      const rows = await sql.unsafe(`
        SELECT ${SELECT_COLS}
        FROM report_blueprints ${where}
        ORDER BY visibility DESC, updated_at DESC
        LIMIT 100
      `, params);
      return json(event, 200, { items: rows.map(shapeRow), count: rows.length });
    }

    // ── POST /api/v2-blueprints/create-from ───────────────────
    if (event.httpMethod === "POST" && isCreateFromPath(event.path)) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });
      const parsed = createFromSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { blueprint_id, title, document_type } = parsed.data;

      const bps = await sql`
        SELECT id, brand_id, owner_tenant_id, visibility, modules, slots, page_format
        FROM report_blueprints WHERE id = ${blueprint_id} LIMIT 1
      `;
      if (!bps.length) return json(event, 404, { error: "Blueprint not found" });
      const bp = bps[0];

      // Resolve which brand + tenant the new report goes under.
      // Priority: explicit brand_id on bp → brand's tenant. Smyra
      // blueprints require a caller-side brand_id to create into.
      let brandId = bp.brand_id;
      let tenantId = bp.owner_tenant_id;
      if (!brandId && body.brand_id) brandId = body.brand_id;
      if (!brandId) {
        return json(event, 400, {
          error: "Smyra blueprint requires brand_id in request body",
        });
      }
      if (!tenantId) {
        const brands = await sql`SELECT tenant_id FROM brands WHERE id = ${brandId} LIMIT 1`;
        if (!brands.length) return json(event, 400, { error: "Brand not found" });
        tenantId = brands[0].tenant_id;
      }

      const reportRows = await sql`
        INSERT INTO v2_reports (tenant_id, brand_id, title, document_type, status, page_format)
        VALUES (${tenantId}, ${brandId}, ${title}, ${document_type}, 'draft', ${bp.page_format || 'a4_portrait'})
        RETURNING id, tenant_id, brand_id, title, document_type, status, page_format, created_at, updated_at
      `;
      const reportId = reportRows[0].id;

      // Legacy shape: modules is a literal array — seed directly.
      // Smart shape: slots — nothing to seed yet, Claude fills on first
      // workflow step.
      const legacyModules = bp.modules
        ? (typeof bp.modules === "string" ? JSON.parse(bp.modules) : bp.modules)
        : null;
      let seededModules = 0;
      if (Array.isArray(legacyModules) && legacyModules.length) {
        for (const mod of legacyModules) {
          await sql`
            INSERT INTO v2_report_modules (report_id, module_type, order_index, content, style)
            VALUES (
              ${reportId}, ${mod.module_type}, ${mod.order_index},
              ${JSON.stringify(mod.content || {})}::jsonb,
              ${JSON.stringify(mod.style || {})}::jsonb
            )
          `;
        }
        seededModules = legacyModules.length;
      }

      return json(event, 201, {
        item: reportRows[0],
        blueprint_id,
        blueprint_kind: legacyModules ? "legacy" : "smart",
        module_count: seededModules,
      });
    }

    // ── POST /api/v2-blueprints/:id (update in place) ─────────
    if (event.httpMethod === "POST" && blueprintId) {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });
      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      // Build a partial update — only keys the caller provided are set.
      const d = parsed.data;
      const sets = [];
      const vals = [];
      const push = (col, v, cast = "") => {
        if (v === undefined) return;
        vals.push(v);
        sets.push(`${col} = $${vals.length}${cast}`);
      };
      push("name", d.name);
      push("visibility", d.visibility);
      push("brand_id", d.brand_id ?? null);
      push("owner_tenant_id", d.owner_tenant_id ?? null);
      push("document_type", d.document_type);
      push("style_direction", d.style_direction);
      push("tagline", d.tagline);
      push("chat_summary", d.chat_summary);
      push("tags", d.tags);
      if (d.slots !== undefined) push("slots", JSON.stringify(d.slots), "::jsonb");
      if (d.narrative_guidance !== undefined) push("narrative_guidance", JSON.stringify(d.narrative_guidance), "::jsonb");
      push("pages_estimate", d.pages_estimate);
      push("page_format", d.page_format);
      push("thumbnail_small_base64", d.thumbnail_small_base64);
      push("thumbnail_url", d.thumbnail_url);
      if (!sets.length) return json(event, 400, { error: "No fields to update" });

      vals.push(blueprintId);
      const rows = await sql.unsafe(
        `UPDATE report_blueprints SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING ${SELECT_COLS}`,
        vals
      );
      if (!rows.length) return json(event, 404, { error: "Blueprint not found" });
      return json(event, 200, { item: shapeRow(rows[0]) });
    }

    // ── POST /api/v2-blueprints (create) ──────────────────────
    if (event.httpMethod === "POST") {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const shape = detectSaveShape(body);
      if (!shape) {
        return json(event, 400, {
          error: "Body must be either { report_id, name } (legacy) or { name, slots, ... } (smart)",
        });
      }

      // Legacy: snapshot from existing report
      if (shape === "legacy") {
        const parsed = legacySaveSchema.safeParse(body);
        if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
        const { report_id, name } = parsed.data;

        const reports = await sql`SELECT id, brand_id FROM v2_reports WHERE id = ${report_id} LIMIT 1`;
        if (!reports.length) return json(event, 404, { error: "Report not found" });
        const brandId = reports[0].brand_id;
        if (!brandId) return json(event, 400, { error: "Report has no brand_id" });

        const modules = await sql`
          SELECT module_type, order_index, style
          FROM v2_report_modules WHERE report_id = ${report_id}
          ORDER BY order_index
        `;
        const blueprintModules = modules.map((m) => ({
          module_type: m.module_type,
          order_index: m.order_index,
          style: m.style,
          content: {},
        }));

        const rows = await sql`
          INSERT INTO report_blueprints (id, brand_id, name, source_report_id, modules, visibility)
          VALUES (${randomUUID()}, ${brandId}, ${name}, ${report_id}, ${JSON.stringify(blueprintModules)}::jsonb, 'brand')
          RETURNING ${sql.unsafe(SELECT_COLS)}
        `;
        return json(event, 201, { item: shapeRow(rows[0]), module_count: blueprintModules.length });
      }

      // Smart: intent-driven blueprint
      const parsed = smartSaveSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });
      const d = parsed.data;

      const id = randomUUID();
      const rows = await sql`
        INSERT INTO report_blueprints (
          id, brand_id, owner_tenant_id, visibility,
          name, tagline, chat_summary, document_type, style_direction, tags,
          slots, narrative_guidance,
          thumbnail_small_base64, thumbnail_url,
          pages_estimate, page_format
        ) VALUES (
          ${id},
          ${d.brand_id ?? null},
          ${d.owner_tenant_id ?? null},
          ${d.visibility},
          ${d.name},
          ${d.tagline ?? null},
          ${d.chat_summary ?? null},
          ${d.document_type ?? null},
          ${d.style_direction ?? null},
          ${d.tags ?? []},
          ${JSON.stringify(d.slots)}::jsonb,
          ${d.narrative_guidance ? JSON.stringify(d.narrative_guidance) : null}::jsonb,
          ${d.thumbnail_small_base64 ?? null},
          ${d.thumbnail_url ?? null},
          ${d.pages_estimate ?? null},
          ${d.page_format}
        )
        RETURNING ${sql.unsafe(SELECT_COLS)}
      `;
      return json(event, 201, { item: shapeRow(rows[0]) });
    }

    // ── DELETE /api/v2-blueprints/:id ─────────────────────────
    if (event.httpMethod === "DELETE" && blueprintId) {
      const res = await sql`DELETE FROM report_blueprints WHERE id = ${blueprintId} RETURNING id`;
      if (!res.length) return json(event, 404, { error: "Blueprint not found" });
      return noContent(event);
    }

    return json(event, 405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[v2-blueprints]", err);
    return json(event, 500, { error: err.message });
  }
};
