import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

const createProfileSchema = z.object({
  name: z.string().min(1),
  status: z.string().min(1).optional(),
  brand_tokens: z.record(z.any()).optional(),
  typography_rules: z.record(z.any()).optional(),
  layout_policy: z.record(z.any()).optional(),
  source_asset_ids: z.array(z.string().uuid()).optional(),
  notes: z.string().optional(),
});

const patchProfileSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

const createVersionSchema = z.object({
  brand_tokens: z.record(z.any()).default({}),
  typography_rules: z.record(z.any()).default({}),
  layout_policy: z.record(z.any()).default({}),
  source_asset_ids: z.array(z.string().uuid()).default([]),
  notes: z.string().optional(),
});

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

function getPathParts(path = "") {
  const clean = path.split("?")[0];
  const parts = clean.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("brand-profiles");
  if (idx === -1) return { id: null, action: null };
  return {
    id: parts[idx + 1] ?? null,
    action: parts[idx + 2] ?? null,
  };
}

async function getProfile(sql, profileId, hubUserId) {
  const rows = await sql`
    SELECT *
    FROM brand_profiles
    WHERE id = ${profileId} AND hub_user_id = ${hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const sql = getSql();
  const { id, action } = getPathParts(event.path);

  if (event.httpMethod === "GET" && !id) {
    const rows = await sql`
      SELECT *
      FROM brand_profiles
      WHERE hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `;
    return json(event, 200, { items: rows });
  }

  if (event.httpMethod === "GET" && id && !action) {
    const profile = await getProfile(sql, id, auth.hubUserId);
    if (!profile) return json(event, 404, { error: "Brand profile not found" });

    const versions = await sql`
      SELECT *
      FROM brand_profile_versions
      WHERE brand_profile_id = ${id}
      ORDER BY version_no DESC
    `;

    return json(event, 200, { item: profile, versions });
  }

  if (event.httpMethod === "GET" && id && action === "versions") {
    const profile = await getProfile(sql, id, auth.hubUserId);
    if (!profile) return json(event, 404, { error: "Brand profile not found" });

    const versions = await sql`
      SELECT *
      FROM brand_profile_versions
      WHERE brand_profile_id = ${id}
      ORDER BY version_no DESC
    `;
    return json(event, 200, { items: versions });
  }

  if (event.httpMethod === "POST" && !id) {
    const body = parseBody(event);
    if (!body) return json(event, 400, { error: "Invalid JSON" });

    const parsed = createProfileSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const profileId = randomUUID();
    const rows = await sql`
      INSERT INTO brand_profiles (id, hub_user_id, name, status)
      VALUES (${profileId}, ${auth.hubUserId}, ${parsed.data.name}, ${parsed.data.status ?? "active"})
      RETURNING *
    `;

    const versionRows = await sql`
      INSERT INTO brand_profile_versions (
        id,
        brand_profile_id,
        version_no,
        brand_tokens,
        typography_rules,
        layout_policy,
        source_asset_ids,
        notes
      ) VALUES (
        ${randomUUID()},
        ${profileId},
        1,
        ${JSON.stringify(parsed.data.brand_tokens || {})}::jsonb,
        ${JSON.stringify(parsed.data.typography_rules || {})}::jsonb,
        ${JSON.stringify(parsed.data.layout_policy || { mode: "strict_brand" })}::jsonb,
        ${JSON.stringify(parsed.data.source_asset_ids || [])}::jsonb,
        ${parsed.data.notes ?? null}
      )
      RETURNING *
    `;

    return json(event, 201, { item: rows[0], version: versionRows[0] });
  }

  if (event.httpMethod === "PATCH" && id && !action) {
    const body = parseBody(event);
    if (!body) return json(event, 400, { error: "Invalid JSON" });

    const parsed = patchProfileSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const profile = await getProfile(sql, id, auth.hubUserId);
    if (!profile) return json(event, 404, { error: "Brand profile not found" });

    const updated = await sql`
      UPDATE brand_profiles
      SET
        name = COALESCE(${parsed.data.name ?? null}, name),
        status = COALESCE(${parsed.data.status ?? null}, status),
        updated_at = NOW()
      WHERE id = ${id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      RETURNING *
    `;

    return json(event, 200, { item: updated[0] });
  }

  if (event.httpMethod === "POST" && id && action === "versions") {
    const body = parseBody(event);
    if (!body) return json(event, 400, { error: "Invalid JSON" });

    const parsed = createVersionSchema.safeParse(body);
    if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

    const profile = await getProfile(sql, id, auth.hubUserId);
    if (!profile) return json(event, 404, { error: "Brand profile not found" });

    const latest = await sql`
      SELECT version_no
      FROM brand_profile_versions
      WHERE brand_profile_id = ${id}
      ORDER BY version_no DESC
      LIMIT 1
    `;
    const nextVersion = (latest[0]?.version_no ?? 0) + 1;

    const rows = await sql`
      INSERT INTO brand_profile_versions (
        id,
        brand_profile_id,
        version_no,
        brand_tokens,
        typography_rules,
        layout_policy,
        source_asset_ids,
        notes
      ) VALUES (
        ${randomUUID()},
        ${id},
        ${nextVersion},
        ${JSON.stringify(parsed.data.brand_tokens)}::jsonb,
        ${JSON.stringify(parsed.data.typography_rules)}::jsonb,
        ${JSON.stringify(parsed.data.layout_policy)}::jsonb,
        ${JSON.stringify(parsed.data.source_asset_ids)}::jsonb,
        ${parsed.data.notes ?? null}
      )
      RETURNING *
    `;

    await sql`
      UPDATE brand_profiles
      SET updated_at = NOW()
      WHERE id = ${id}
    `;

    return json(event, 201, { item: rows[0] });
  }

  if (event.httpMethod === "DELETE" && id && !action) {
    const rows = await sql`
      UPDATE brand_profiles
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
      RETURNING id
    `;
    if (!rows[0]) return json(event, 404, { error: "Brand profile not found" });
    return noContent(event);
  }

  return json(event, 405, { error: "Method Not Allowed" });
};
