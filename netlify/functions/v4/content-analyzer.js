/**
 * V4 Pipeline — Content Analyzer
 * Extracts structural content-schema from a source PDF.
 *
 * Uses pdf-parse for text extraction.
 * Reuses Netlify Blobs pattern from design-assets.js and DB pattern from db.js.
 *
 * The analyzer identifies:
 *   - Page types (cover, summary, financial_table, etc.)
 *   - Required fields and token definitions per page type
 *   - Page type map (page_type → design_component → layout_name → tokens)
 *   - Structural patterns (repeatable sections, KPI formats, table structures)
 */
// Lazy-loaded to avoid crashing entire MCP module if pdf-parse unavailable
let _pdf = null;
let _pdfLoaded = false;

async function getPdfParser() {
  if (_pdfLoaded) return _pdf;
  _pdfLoaded = true;
  try {
    _pdf = (await import("pdf-parse/lib/pdf-parse.js")).default;
  } catch {
    try {
      _pdf = (await import("pdf-parse")).default;
    } catch {
      _pdf = null;
    }
  }
  return _pdf;
}

// ── Page type classifiers ──────────────────────────────────────────────────

const PAGE_TYPES = {
  cover: {
    layout_name: "page-cover",
    design_components: ["kpi_strip"],
  },
  summary: {
    layout_name: "page-summary",
    design_components: ["data_table", "facts_column"],
  },
  vd_letter: {
    layout_name: "page-vd-letter",
    design_components: ["text_column", "photo_placeholder"],
  },
  financial_table: {
    layout_name: "page-financial-table",
    design_components: ["data_table"],
    repeatable: true,
  },
  multi_chart: {
    layout_name: "page-multi-chart",
    design_components: ["bar_chart", "donut_chart"],
    repeatable: true,
  },
  portfolio_page: {
    layout_name: "page-portfolio",
    design_components: ["map_bubble", "data_table", "donut_chart"],
    repeatable: true,
  },
  esg_page: {
    layout_name: "page-esg",
    design_components: ["esg_pillars"],
  },
  stock_page: {
    layout_name: "page-stock",
    design_components: ["stock_chart__price_volume", "stock_chart__nav_vs_price"],
  },
  closing: {
    layout_name: "page-closing",
    design_components: [],
  },
};

// ── Heuristic classifiers ──────────────────────────────────────────────────

/** Classify a single page based on text content and position */
function classifyPage(text, pageIndex, totalPages) {
  const lower = text.toLowerCase();
  const lineCount = text.split("\n").filter((l) => l.trim()).length;

  // First page is almost always a cover
  if (pageIndex === 0) return "cover";

  // Last page is almost always closing/contact
  if (pageIndex === totalPages - 1) return "closing";

  // VD har ordet / CEO letter
  if (lower.includes("vd har ordet") || lower.includes("vd-ord") || lower.includes("ceo") ||
      lower.includes("verkställande direktör")) return "vd_letter";

  // ESG / sustainability
  if (lower.includes("hållbarhet") || lower.includes("sustainability") ||
      lower.includes("environment") || lower.includes("esg")) return "esg_page";

  // Stock / share information
  if (lower.includes("aktie") && (lower.includes("kurs") || lower.includes("volym") || lower.includes("börsen"))) return "stock_page";

  // Portfolio / property page
  if (lower.includes("fastighetsbestånd") || lower.includes("portfölj") ||
      (lower.includes("karta") && lower.includes("ort"))) return "portfolio_page";

  // Financial tables — detect by numeric density and financial keywords
  const numberCount = (text.match(/[\d\s]+[\d,.][\d\s]*/g) || []).length;
  const hasTableStructure = numberCount > 10 && lineCount > 5;
  const financialKeywords = ["mkr", "tsek", "msek", "resultat", "balans", "kassaflöde",
    "ebitda", "intäkt", "kostnad", "skuld", "tillgång", "not ", "note "];
  const financialHits = financialKeywords.filter((kw) => lower.includes(kw)).length;

  if (hasTableStructure && financialHits >= 2) return "financial_table";

  // Summary page — typically early pages with bullet points and key figures
  if (pageIndex <= 2 && (lower.includes("sammandrag") || lower.includes("perioden") ||
      lower.includes("nyckeltal") || lower.includes("höjdpunkt"))) return "summary";

  // Chart pages — mentions of diagram, chart, utveckling with less text
  if ((lower.includes("diagram") || lower.includes("utveckling") || lower.includes("fördelning")) &&
      lineCount < 15) return "multi_chart";

  // Default: if lots of numbers, it's likely a financial table
  if (hasTableStructure) return "financial_table";

  // If mostly text, classify based on position
  if (pageIndex <= 3) return "summary";
  return "financial_table";
}

/** Extract a table-like instance_id from page text */
function inferInstanceId(text, pageType, pageIndex) {
  if (pageType !== "financial_table") return null;

  const lower = text.toLowerCase();

  // Common financial statement patterns
  const patterns = [
    { match: /resultaträkning/i, id: "income_statement" },
    { match: /balansräkning/i, id: "balance_sheet" },
    { match: /kassaflöde/i, id: "cash_flow" },
    { match: /förändring.+eget.+kapital/i, id: "changes_equity" },
    { match: /nyckeltal/i, id: "key_ratios" },
    { match: /not\s+(\d+)/i, id: null }, // handled below
    { match: /segmentrapportering/i, id: "segment_reporting" },
    { match: /redovisningsprincip/i, id: "accounting_principles" },
  ];

  for (const p of patterns) {
    const m = lower.match(p.match);
    if (m) {
      if (p.id === null && m[1]) return `note_${m[1]}`;
      if (p.id) return p.id;
    }
  }

  return `financial_table_p${pageIndex + 1}`;
}

/** Extract token definitions based on page type */
function getTokensForPageType(pageType) {
  const tokenSets = {
    cover: [
      { name: "COMPANY_NAME", type: "text", required: true },
      { name: "COMPANY_SHORT", type: "text", required: true },
      { name: "REPORT_TYPE", type: "text", required: true },
      { name: "PERIOD_LABEL", type: "text", required: true },
      { name: "COVER_IMAGE_URL", type: "image_url", required: false },
      { name: "KPI_ITEMS", type: "list", required: true },
    ],
    summary: [
      { name: "SECTION_TITLE", type: "text", required: true },
      { name: "BULLET_Q", type: "list", required: true },
      { name: "BULLET_FY", type: "list", required: false },
      { name: "NYCKELTAL_TABLE", type: "table", required: true },
      { name: "FACTS_Q", type: "table", required: false },
      { name: "FACTS_NEXT", type: "table", required: false },
    ],
    vd_letter: [
      { name: "SECTION_TITLE", type: "text", required: true },
      { name: "CEO_NAME", type: "text", required: true },
      { name: "CEO_TITLE", type: "text", required: true },
      { name: "BODY_SECTIONS", type: "list", required: true },
      { name: "CEO_PHOTO_URL", type: "image_url", required: false },
    ],
    financial_table: [
      { name: "TABLE_TITLE", type: "text", required: true },
      { name: "TABLE_SUBTITLE", type: "text", required: false },
      { name: "TABLE_DATA", type: "table", required: true },
      { name: "TABLE_FOOTNOTE", type: "text", required: false },
    ],
    multi_chart: [
      { name: "SECTION_TITLE", type: "text", required: true },
      { name: "CHART_1", type: "svg_chart", required: true },
      { name: "CHART_2", type: "svg_chart", required: false },
      { name: "CHART_3", type: "svg_chart", required: false },
      { name: "CHART_4", type: "svg_chart", required: false },
    ],
    portfolio_page: [
      { name: "SECTION_TITLE", type: "text", required: true },
      { name: "MAP_CHART", type: "svg_chart", required: false },
      { name: "PORTFOLIO_TABLE", type: "table", required: true },
      { name: "DONUT_CHARTS", type: "list", required: false },
    ],
    esg_page: [
      { name: "SECTION_TITLE", type: "text", required: true },
      { name: "ESG_PILLARS", type: "list", required: true },
    ],
    stock_page: [
      { name: "TICKER", type: "text", required: true },
      { name: "PRICE_VOLUME_CHART", type: "svg_chart", required: true },
      { name: "NAV_CHART", type: "svg_chart", required: false },
    ],
    closing: [
      { name: "OFFICES", type: "list", required: true },
      { name: "PHONE", type: "text", required: false },
      { name: "WEBSITE", type: "text", required: false },
      { name: "EMAIL", type: "text", required: false },
    ],
  };

  return tokenSets[pageType] || [];
}

// ── Main analysis function ─────────────────────────────────────────────────

/**
 * Analyze a PDF buffer and produce a content-schema.
 *
 * @param {Buffer} pdfBuffer - PDF file content
 * @param {object} [options] - Analysis options
 * @returns {Promise<object>} ContentSchema object
 */
export async function analyzeContent(pdfBuffer, options = {}) {
  // Extract text from PDF
  const pdf = await getPdfParser();
  if (!pdf) throw new Error("pdf-parse not available — install pdf-parse dependency");
  const pdfData = await pdf(pdfBuffer);
  const totalPages = pdfData.numpages || 1;

  // pdf-parse gives us full text; we split by form feed or heuristic
  // For more accurate per-page text, we re-parse with page render
  const fullText = pdfData.text || "";

  // Try to split text by pages using form feed characters
  let pageTexts = fullText.split("\f").filter((t) => t.trim());

  // If form feed split didn't work well, try splitting by line count
  if (pageTexts.length < totalPages * 0.5) {
    const lines = fullText.split("\n");
    const linesPerPage = Math.ceil(lines.length / totalPages);
    pageTexts = [];
    for (let i = 0; i < totalPages; i++) {
      pageTexts.push(lines.slice(i * linesPerPage, (i + 1) * linesPerPage).join("\n"));
    }
  }

  // Pad if we have fewer text chunks than pages
  while (pageTexts.length < totalPages) {
    pageTexts.push("");
  }

  // Classify each page
  const pageClassifications = pageTexts.map((text, i) => ({
    pageIndex: i,
    pageNumber: i + 1,
    text: text.trim(),
    pageType: classifyPage(text, i, totalPages),
  }));

  // Build page_type_map
  const pageTypeMap = {};
  const pagePlan = [];
  const pageTypeCounts = {};

  for (const page of pageClassifications) {
    const { pageType, pageNumber, text } = page;
    pageTypeCounts[pageType] = (pageTypeCounts[pageType] || 0) + 1;

    const typeDef = PAGE_TYPES[pageType] || { layout_name: `page-${pageType}`, design_components: [] };
    const tokens = getTokensForPageType(pageType);
    const instanceId = inferInstanceId(text, pageType, page.pageIndex);

    // Add to page_type_map if not already there
    if (!pageTypeMap[pageType]) {
      pageTypeMap[pageType] = {
        page_type: pageType,
        design_components: typeDef.design_components,
        layout_name: typeDef.layout_name,
        token_list: tokens.map((t) => t.name),
        repeatable: typeDef.repeatable || false,
        required_fields: tokens.filter((t) => t.required).map((t) => t.name),
      };
    }

    pagePlan.push({
      position: pageNumber,
      type: pageType,
      instance_id: instanceId,
      layout_name: typeDef.layout_name,
    });
  }

  // Build content-schema
  const contentSchema = {
    source: {
      file: options.filename || "source.pdf",
      report_type: inferReportType(fullText),
      pages: totalPages,
    },
    global: {
      company_name: { type: "text", required: true, note: "Fullt legalt namn" },
      company_short: { type: "text", required: true, note: "Kortnamn / loggatext" },
      report_type: { type: "text", required: true, values: ["bokslutskommunike", "delarsrapport_q1", "delarsrapport_q2", "delarsrapport_q3", "arsredovisning"] },
      quarter: { type: "text", required: true, example: "Q4" },
      period_label: { type: "text", required: true, example: "1 JANUARI – 31 DECEMBER 2025" },
      fiscal_year: { type: "number", required: true, example: 2025 },
    },
    page_types: Object.fromEntries(
      Object.entries(pageTypeMap).map(([key, val]) => [
        key,
        {
          design_component: val.design_components.length === 1 ? val.design_components[0] : val.design_components,
          required_fields: Object.fromEntries(
            getTokensForPageType(key).map((t) => [t.name, { type: t.type, required: t.required }])
          ),
          note: val.repeatable ? `Kan upprepas (${pageTypeCounts[key]} instans(er) i käll-PDF)` : undefined,
        },
      ])
    ),
    page_plan_pattern: pagePlan,
    scalability: {
      max_pages: "unlimited",
      repeatable_types: Object.entries(pageTypeMap)
        .filter(([_, v]) => v.repeatable)
        .map(([k]) => k),
      note: `Käll-PDF hade ${totalPages} sidor med ${Object.keys(pageTypeMap).length} unika sidtyper.`,
    },
  };

  // Component inventory
  const componentInventory = {};
  for (const [type, count] of Object.entries(pageTypeCounts)) {
    componentInventory[type] = count;
  }

  return {
    contentSchema,
    pageTypeMap,
    pagePlan,
    componentInventory,
    pageCount: totalPages,
    extractedText: fullText.slice(0, 2000), // First 2000 chars for debugging
  };
}

/** Infer report type from full text */
function inferReportType(text) {
  const lower = text.toLowerCase();
  if (lower.includes("bokslutskommuniké") || lower.includes("bokslutskommunike")) return "bokslutskommunike";
  if (lower.includes("årsredovisning")) return "arsredovisning";
  if (lower.includes("delårsrapport") || lower.includes("delarsrapport")) {
    if (lower.includes("q1") || lower.includes("kvartal 1")) return "delarsrapport_q1";
    if (lower.includes("q2") || lower.includes("kvartal 2")) return "delarsrapport_q2";
    if (lower.includes("q3") || lower.includes("kvartal 3")) return "delarsrapport_q3";
    return "delarsrapport_q1";
  }
  if (lower.includes("hållbarhetsrapport") || lower.includes("sustainability")) return "hallbarhetsrapport";
  return "kvartalsrapport";
}
