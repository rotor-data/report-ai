import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, noContent } from "./cors.js";
import { requireHubAuth } from "./auth-middleware.js";
import { getSql } from "./db.js";
import { getTemplate, mergeMissingStubs } from "./document-type-templates.js";
import { checkRateLimit } from "./rate-limit.js";

const schema = z.object({
  document_id: z.string().uuid(),
  raw_content: z.string().min(1),
});

function fallbackPlan(documentType) {
  return [{ id: randomUUID(), order: 1, module_type: "text_spread", title: `Utkast ${documentType}`, content: "", data: {} }];
}

function safeJsonArray(text, fallback = []) {
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|```$/g, "").trim());
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function generateWithClaude(documentType, rawContent, requiredSections) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackPlan(documentType);

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";

  const message = await client.messages.create({
    model,
    max_tokens: 3200,
    system: "Return only JSON array for module plan.",
    messages: [
      {
        role: "user",
        content: `documentType=${documentType}\nrequired_sections=${JSON.stringify(requiredSections)}\ncontent=${rawContent}`,
      },
    ],
  });

  const text = message.content?.find((part) => part.type === "text")?.text ?? "[]";
  return safeJsonArray(text, fallbackPlan(documentType));
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noContent(event);
  if (event.httpMethod !== "POST") return json(event, 405, { error: "Method Not Allowed" });

  const auth = requireHubAuth(event);
  if (!auth.ok) return json(event, auth.status, { error: auth.error });

  const rl = checkRateLimit({ route: "generate-modules", hubUserId: auth.hubUserId, max: 8, windowMs: 60_000 });
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
  const rows = await sql`
    SELECT id, document_type
    FROM documents
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
    LIMIT 1
  `;

  const doc = rows[0];
  if (!doc) return json(event, 404, { error: "Document not found" });

  const template = await getTemplate(doc.document_type);
  const generated = await generateWithClaude(doc.document_type, parsed.data.raw_content, template?.required_sections ?? []);
  const withIds = generated.map((m, idx) => ({ id: m.id ?? randomUUID(), order: idx + 1, ...m }));

  const merged = await mergeMissingStubs(doc.document_type, withIds);

  await sql`
    UPDATE documents
    SET
      raw_content = ${parsed.data.raw_content},
      module_plan = ${JSON.stringify(merged.modulePlan)}::jsonb,
      status = 'ready',
      updated_at = NOW()
    WHERE id = ${parsed.data.document_id} AND hub_user_id = ${auth.hubUserId} AND deleted_at IS NULL
  `;

  return json(event, 200, { ok: true, module_plan: merged.modulePlan, warnings: merged.warnings });
};
