import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";

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
  const rows = await sql`
    SELECT html_output
    FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = rows[0];
  if (!doc?.html_output) return json(event, 400, { error: "Document has no HTML output" });

  const browserlessToken = process.env.BROWSERLESS_TOKEN;
  const browserlessEndpoint = process.env.BROWSERLESS_ENDPOINT ?? "https://production-sfo.browserless.io/pdf";
  if (!browserlessToken) return json(event, 500, { error: "BROWSERLESS_TOKEN not configured" });

  const response = await fetch(`${browserlessEndpoint}?token=${encodeURIComponent(browserlessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html: doc.html_output,
      options: {
        format: "A4",
        printBackground: true,
      },
      addScriptTag: [{ url: "https://unpkg.com/pagedjs/dist/paged.polyfill.js" }],
      waitForFunction: "window.PagedPolyfill !== undefined",
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    return json(event, 502, { error: "Browserless export failed", details });
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer).toString("base64");

  return json(event, 200, { ok: true, pdf_base64: bytes });
};
