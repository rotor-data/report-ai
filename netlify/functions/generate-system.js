import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { checkRateLimit } from "./rate-limit.js";

const schema = z.object({
  document_id: z.string().uuid(),
  brand_input: z.record(z.any()),
});

function fallbackSystem(brand = {}) {
  return {
    colors: {
      primary: brand.primary_color ?? "#0f4c81",
      background: "#ffffff",
      text: "#1a1a1a",
      accent: "#e6eef5",
    },
    typography: {
      heading: brand.font_heading ?? "Helvetica Neue",
      body: brand.font_body ?? "Georgia",
      tone: brand.tone ?? "professional",
    },
    spacing: {
      base: 8,
      section: 24,
    },
    page: {
      size: "A4",
      margin_mm: 15,
    },
    company_name: brand.company_name ?? "",
  };
}

function safeJsonFromClaudeText(text, fallback) {
  try {
    return JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
  } catch {
    return fallback;
  }
}

async function generateWithClaude(brandInput) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackSystem(brandInput);

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";

  const message = await client.messages.create({
    model,
    max_tokens: 1800,
    system: "Return only JSON. Build a print design system.",
    messages: [
      {
        role: "user",
        content: `Create a JSON design system from: ${JSON.stringify(brandInput)}`,
      },
    ],
  });

  const text = message.content?.find((part) => part.type === "text")?.text ?? "";
  return safeJsonFromClaudeText(text, fallbackSystem(brandInput));
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const rl = checkRateLimit({ route: "generate-system", hubUserId: auth.hubUserId, max: 12, windowMs: 60_000 });
  if (!rl.ok) return json(event, 429, { error: "Rate limit exceeded", retry_after_seconds: rl.retryAfterSeconds });

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
    SELECT id FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!docs[0]) return json(event, 404, { error: "Document not found" });

  const designSystem = await generateWithClaude(parsed.data.brand_input);

  await sql`
    UPDATE documents
    SET
      brand_input = ${JSON.stringify(parsed.data.brand_input)}::jsonb,
      design_system = ${JSON.stringify(designSystem)}::jsonb,
      status = 'ready',
      updated_at = NOW()
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
  `;

  return json(event, 200, { ok: true, design_system: designSystem });
};
