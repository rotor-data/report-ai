import { getSql } from "./db.js";
import { randomUUID } from "node:crypto";

export async function getTemplate(documentType) {
  const sql = getSql();
  const rows = await sql`
    SELECT document_type, required_sections, default_stub_plan
    FROM document_type_templates
    WHERE document_type = ${documentType}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function validateModulePlan(docType, modulePlan = []) {
  const t = await getTemplate(docType);
  if (!t) return { valid: true, missing: [] };

  const planTypes = new Set(modulePlan.map((m) => m.module_type));
  const planRoles = new Set(modulePlan.filter((m) => m.semantic_role).map((m) => m.semantic_role));

  const missing = t.required_sections.filter((req) => {
    if (req.semantic_role) return !planRoles.has(req.semantic_role);
    return !planTypes.has(req.module_type);
  });

  return { valid: missing.length === 0, missing };
}

export async function getDefaultStubPlan(docType) {
  const t = await getTemplate(docType);
  return t?.default_stub_plan ?? [];
}

function normalizeOrder(plan = []) {
  const sorted = [...plan].sort((a, b) => {
    if (a.module_type === "cover") return -1;
    if (b.module_type === "cover") return 1;
    if (a.module_type === "back_cover") return 1;
    if (b.module_type === "back_cover") return -1;
    return (a.order ?? 999) - (b.order ?? 999);
  });
  return sorted.map((m, idx) => ({ ...m, order: idx + 1 }));
}

export async function mergeMissingStubs(docType, modulePlan = []) {
  const validation = await validateModulePlan(docType, modulePlan);
  if (validation.valid) {
    return { modulePlan: normalizeOrder(modulePlan), warnings: [] };
  }

  const template = await getTemplate(docType);
  const defaults = template?.default_stub_plan ?? [];
  const toAdd = [];

  for (const req of validation.missing) {
    const stub = defaults.find((m) => {
      if (req.semantic_role) return m.semantic_role === req.semantic_role;
      return m.module_type === req.module_type;
    });

    if (stub) {
      toAdd.push({
        id: randomUUID(),
        ...stub,
        stub: true,
      });
    } else {
      toAdd.push({
        id: randomUUID(),
        order: 999,
        module_type: req.module_type,
        title: req.label,
        semantic_role: req.semantic_role,
        content: "",
        data: {},
        stub: true,
      });
    }
  }

  return {
    modulePlan: normalizeOrder([...modulePlan, ...toAdd]),
    warnings: validation.missing,
  };
}
