import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { computeBrandReadiness } from "./layout-quality.js";

const schema = z.object({
  document_id: z.string().uuid(),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(event, 400, { error: "Invalid JSON" });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(event, 400, { error: "Invalid payload", issues: parsed.error.issues });

  const sql = getSql();
  const docs = await sql`
    SELECT id, title, design_system, brand_input
    FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = docs[0];
  if (!doc) return json(event, 404, { error: "Document not found" });

  const fonts = await sql`
    SELECT id
    FROM custom_fonts
    WHERE hub_user_id = ${auth.hubUserId}
    LIMIT 1
  `;

  const assets = await sql`
    SELECT id, asset_type
    FROM design_assets
    WHERE hub_user_id = ${auth.hubUserId} AND document_id = ${doc.id} AND deleted_at IS NULL
  `;

  const readiness = computeBrandReadiness({
    designSystem: doc.design_system,
    fontsCount: fonts.length,
    assets,
  });

  return json(event, 200, {
    ...readiness,
    user_message:
      readiness.missing.length === 0
        ? "Allt ser bra ut. Vi kan fortsätta med layoutgenerering."
        : `Innan vi går vidare behöver vi komplettera: ${readiness.missing.join(", ")}.`,
    technical_details: {
      has_design_system: Boolean(doc.design_system),
      has_uploaded_fonts: fonts.length > 0,
      asset_counts: {
        design_examples: assets.filter((a) => a.asset_type === "design_example").length,
        pdf_references: assets.filter((a) => a.asset_type === "pdf_reference").length,
      },
    },
  });
};
