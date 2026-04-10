/**
 * REST endpoints for Report Engine v2 tenant assets.
 *
 * GET  /api/v2-assets?tenant_id=...   → list assets
 * POST /api/v2-assets                 → upload asset (base64) → Netlify Blobs + DB row
 *
 * Auth: Hub JWT.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

const uploadSchema = z.object({
  tenant_id: z.string().uuid(),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  data_base64: z.string().min(1),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

async function getBlobStore(storeName, event) {
  const { connectLambda, getStore } = await import("@netlify/blobs");
  try {
    if (event) connectLambda(event);
    return getStore(storeName);
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: storeName, siteID, token });
    throw new Error(`Cannot access blob store "${storeName}"`);
  }
}

function classifyAsset(mimeType, dataBase64) {
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType.startsWith("image/") && dataBase64.length < 50000) return "icon";
  return "photo";
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();

  try {
    if (event.httpMethod === "GET") {
      const tenantId = event.queryStringParameters?.tenant_id;
      if (!tenantId) return json(event, 400, { error: "tenant_id query param required" });

      const rows = await sql`
        SELECT id, tenant_id, filename, mime_type, storage_url, size_bytes, asset_class,
               width_px, height_px, dpi, created_at
        FROM tenant_assets
        WHERE tenant_id = ${tenantId}
        ORDER BY created_at DESC
      `;
      const items = rows.map((r) => ({
        ...r,
        dpi_warning:
          r.asset_class === "photo" && (r.size_bytes || 0) < 100000
            ? "Bilden är liten och kan bli lågupplöst i tryck vid A4-storlek."
            : null,
      }));
      return json(event, 200, { items });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event);
      if (!body) return json(event, 400, { error: "Invalid JSON" });

      const parsed = uploadSchema.safeParse(body);
      if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

      const { tenant_id, filename, mime_type, data_base64 } = parsed.data;

      const assetId = randomUUID();
      const ext = (filename.split(".").pop() || "bin").toLowerCase();
      const blobKey = `tenants/${tenant_id}/assets/${assetId}.${ext}`;
      const store = await getBlobStore("report-ai-assets", event);
      const buffer = Buffer.from(data_base64, "base64");
      await store.set(blobKey, buffer, { contentType: mime_type });

      const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
      const storageUrl = `${siteUrl}/api/v2-asset?key=${encodeURIComponent(blobKey)}`;
      const sizeBytes = buffer.length;
      const assetClass = classifyAsset(mime_type, data_base64);

      // Simple DPI heuristic for raster images (real dimensions need image decoder).
      let dpiWarning = null;
      if (assetClass === "photo" && sizeBytes < 100000) {
        dpiWarning = "Bilden är liten och kan bli lågupplöst i tryck vid A4-storlek.";
      }

      await sql`
        INSERT INTO tenant_assets (id, tenant_id, filename, mime_type, storage_url, size_bytes, asset_class)
        VALUES (${assetId}, ${tenant_id}, ${filename}, ${mime_type}, ${storageUrl}, ${sizeBytes}, ${assetClass})
      `;

      const rows = await sql`
        SELECT id, tenant_id, filename, mime_type, storage_url, size_bytes, asset_class,
               width_px, height_px, dpi, created_at
        FROM tenant_assets WHERE id = ${assetId}
      `;
      return json(event, 201, { item: { ...rows[0], dpi_warning: dpiWarning }, warning: dpiWarning });
    }

    return json(event, 405, { error: "Method Not Allowed" });
  } catch (err) {
    console.error("[v2-assets]", err);
    return json(event, 500, { error: err.message });
  }
};
