import { randomUUID } from "node:crypto";
import { connectLambda, getStore } from "@netlify/blobs";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

const uploadSchema = z
  .object({
    family_name: z.string().min(1),
    weight: z.string().default("400"),
    style: z.string().default("normal"),
    format: z.enum(["woff2", "woff", "ttf"]),
    blob_key: z.string().min(1).optional(),
    file_base64: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.blob_key || value.file_base64), {
    message: "Either blob_key or file_base64 is required",
  });

function dataUrlToBuffer(maybeDataUrl) {
  const clean = maybeDataUrl.includes(",") ? maybeDataUrl.split(",").pop() : maybeDataUrl;
  return Buffer.from(clean || "", "base64");
}

function getBlobContentType(format) {
  if (format === "woff2") return "font/woff2";
  if (format === "woff") return "font/woff";
  return "font/ttf";
}

function createStore(event) {
  try {
    connectLambda(event);
    return getStore("report-ai-fonts");
  } catch {
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (!siteID || !token) return null;
    return getStore({ name: "report-ai-fonts", siteID, token });
  }
}

function buildBlobUrl(key) {
  const baseUrl = process.env.FONT_BLOB_BASE_URL;
  if (!baseUrl) return key;
  return `${baseUrl.replace(/\/$/, "")}/${key}`;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  // Public font-file serving by id (no auth — fonts are embedded in HTML via @font-face)
  if (event.httpMethod === "GET") {
    const params = new URLSearchParams(event.rawUrl?.split("?")[1] || "");
    const fontId = params.get("id");
    if (fontId) {
      const sql = getSql();
      const rows = await sql`
        SELECT id, blob_key, format
        FROM custom_fonts
        WHERE id = ${fontId}
        LIMIT 1
      `;
      if (!rows[0]) return json(event, 404, { error: "Font not found" });
      const blobKey = rows[0].blob_key;
      if (blobKey.startsWith("http")) {
        return { statusCode: 302, headers: { Location: blobKey, "Access-Control-Allow-Origin": "*" } };
      }
      const store = createStore(event);
      if (!store) return json(event, 500, { error: "Blob store unavailable" });
      const data = await store.get(blobKey, { type: "arrayBuffer" });
      if (!data) return json(event, 404, { error: "Font file not found in store" });
      return {
        statusCode: 200,
        headers: {
          "Content-Type": getBlobContentType(rows[0].format),
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*",
        },
        body: Buffer.from(data).toString("base64"),
        isBase64Encoded: true,
      };
    }
  }

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();

  if (event.httpMethod === "GET") {
    const rows = await sql`
      SELECT *
      FROM custom_fonts
      WHERE hub_user_id = ${auth.hubUserId}
      ORDER BY created_at DESC
    `;
    return json(event, 200, { items: rows });
  }

  if (event.httpMethod === "POST") {
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return json(event, 400, { error: "Invalid JSON" });
    }

    const parsed = uploadSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const id = randomUUID();
    let blobKey = parsed.data.blob_key;

    if (!blobKey && parsed.data.file_base64) {
      const store = createStore(event);
      if (!store) {
        return json(event, 500, {
          error: "Blob store not configured",
          details: "Set Netlify Blobs context or NETLIFY_SITE_ID + NETLIFY_API_TOKEN",
        });
      }

      const key = `${auth.hubUserId}/${id}.${parsed.data.format}`;
      const bytes = dataUrlToBuffer(parsed.data.file_base64);
      await store.set(key, bytes, {
        metadata: {
          family_name: parsed.data.family_name,
          format: parsed.data.format,
        },
        contentType: getBlobContentType(parsed.data.format),
      });

      blobKey = buildBlobUrl(key);
    }

    const rows = await sql`
      INSERT INTO custom_fonts (id, hub_user_id, family_name, weight, style, format, blob_key)
      VALUES (
        ${id},
        ${auth.hubUserId},
        ${parsed.data.family_name},
        ${parsed.data.weight},
        ${parsed.data.style},
        ${parsed.data.format},
        ${blobKey}
      )
      RETURNING *
    `;

    return json(event, 201, { item: rows[0] });
  }

  return json(event, 405, { error: "Method Not Allowed" });
};
