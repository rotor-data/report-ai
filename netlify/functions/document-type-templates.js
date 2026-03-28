import { getSql } from "./db.js";
import { randomUUID } from "node:crypto";

// ─── Hardcoded fallbacks when document_type_templates table is missing ───
const FALLBACK_TEMPLATES = {
  annual_report: {
    document_type: "annual_report",
    required_sections: [
      { module_type: "cover", label: "Omslag", required: true },
      { module_type: "text_spread", label: "VD-ord / Executive Summary", required: true, semantic_role: "executive_summary" },
      { module_type: "kpi_grid", label: "Nyckeltal", required: true },
      { module_type: "financial_summary", label: "Finansiell sammanfattning", required: true },
      { module_type: "back_cover", label: "Baksida", required: true },
    ],
    default_stub_plan: [
      { order: 1, module_type: "cover", title: "Omslag", data: {}, stub: true },
      { order: 2, module_type: "text_spread", title: "VD-ord", semantic_role: "executive_summary", content: "", data: {}, stub: true },
      { order: 3, module_type: "kpi_grid", title: "Nyckeltal", data: { kpis: [] }, stub: true },
      { order: 4, module_type: "financial_summary", title: "Finansiell sammanfattning", data: {}, stub: true },
      { order: 99, module_type: "back_cover", title: "Baksida", data: {}, stub: true },
    ],
  },
  quarterly: {
    document_type: "quarterly",
    required_sections: [
      { module_type: "cover", label: "Omslag", required: true },
      { module_type: "kpi_grid", label: "Nyckeltal", required: true },
      { module_type: "financial_summary", label: "Finansiell sammanfattning", required: true },
      { module_type: "text_spread", label: "Utsikt/Outlook", required: true, semantic_role: "outlook" },
      { module_type: "back_cover", label: "Baksida", required: true },
    ],
    default_stub_plan: [
      { order: 1, module_type: "cover", title: "Omslag", data: {}, stub: true },
      { order: 2, module_type: "kpi_grid", title: "Nyckeltal", data: { kpis: [] }, stub: true },
      { order: 3, module_type: "financial_summary", title: "Finansiell sammanfattning", data: {}, stub: true },
      { order: 4, module_type: "text_spread", title: "Utsikt", semantic_role: "outlook", content: "", data: {}, stub: true },
      { order: 99, module_type: "back_cover", title: "Baksida", data: {}, stub: true },
    ],
  },
  pitch: {
    document_type: "pitch",
    required_sections: [
      { module_type: "cover", label: "Omslag", required: true },
      { module_type: "back_cover", label: "Baksida", required: true },
    ],
    default_stub_plan: [
      { order: 1, module_type: "cover", title: "Omslag", data: {}, stub: true },
      { order: 99, module_type: "back_cover", title: "Baksida", data: {}, stub: true },
    ],
  },
  proposal: {
    document_type: "proposal",
    required_sections: [
      { module_type: "cover", label: "Omslag", required: true },
      { module_type: "back_cover", label: "Baksida", required: true },
    ],
    default_stub_plan: [
      { order: 1, module_type: "cover", title: "Omslag", data: {}, stub: true },
      { order: 99, module_type: "back_cover", title: "Baksida", data: {}, stub: true },
    ],
  },
};

export async function getTemplate(documentType) {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT document_type, required_sections, default_stub_plan
      FROM document_type_templates
      WHERE document_type = ${documentType}
      LIMIT 1
    `;
    if (rows[0]) return rows[0];
  } catch (e) {
    // Table might not exist — fall through to hardcoded fallback
    console.warn("[document-type-templates] DB query failed, using fallback:", e.message);
  }
  return FALLBACK_TEMPLATES[documentType] ?? null;
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
