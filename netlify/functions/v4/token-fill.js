import { escapeHtml, formatTableValue, renderTableModule } from "../html-helpers.js";

const TOKEN_REGEX = /\[\[([A-Z0-9_]+)\]\]/g;

function formatDate(value) {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function renderTableToken(tokenName, value) {
  const module = {
    module_type: "table",
    title: tokenName.replaceAll("_", " "),
    data: value,
  };
  return renderTableModule(module);
}

function resolveSvgGenerator(tokenValue, svgGenerators = {}) {
  if (!tokenValue || typeof tokenValue !== "object") return null;

  const chartType = tokenValue.chart_type || tokenValue.type || tokenValue.generator;
  if (!chartType) return null;

  const direct = svgGenerators[chartType];
  if (typeof direct === "function") return direct;

  const aliases = {
    bar_chart: "generateBarChart",
    bar_chart__bar_line_dual: "generateBarChart",
    donut_chart: "generateDonutChart",
    map_bubble: "generateMapBubble",
    stock_chart: "generateStockChart",
    stock_chart__price_volume: "generateStockChart",
    stock_chart__nav_vs_price: "generateNavVsPrice",
    nav_vs_price: "generateNavVsPrice",
  };

  const aliasName = aliases[chartType];
  if (aliasName && typeof svgGenerators[aliasName] === "function") return svgGenerators[aliasName];

  return null;
}

function normalizeTokenDefs(tokenDefs = []) {
  if (!Array.isArray(tokenDefs)) return {};
  const map = {};
  for (const def of tokenDefs) {
    if (!def || !def.name) continue;
    map[String(def.name).toUpperCase()] = def;
  }
  return map;
}

export function extractTokens(templateHtml = "") {
  const tokens = new Set();
  const input = String(templateHtml || "");
  let match;
  while ((match = TOKEN_REGEX.exec(input)) !== null) {
    tokens.add(match[1]);
  }
  TOKEN_REGEX.lastIndex = 0;
  return [...tokens];
}

export function fillTokens(templateHtml, schemaData = {}, tokenDefs = [], designColors = {}, svgGenerators = {}) {
  const source = String(templateHtml || "");
  const values = schemaData && typeof schemaData === "object" ? schemaData : {};
  const defs = normalizeTokenDefs(tokenDefs);
  const unfilled = new Set();

  const html = source.replace(TOKEN_REGEX, (_full, rawTokenName) => {
    const tokenName = String(rawTokenName).toUpperCase();
    const value = values[tokenName] ?? values[tokenName.toLowerCase()];
    const def = defs[tokenName] || { type: "text", required: false };

    if (value == null || value === "") {
      unfilled.add(tokenName);
      return "";
    }

    if (typeof value === "object" && value && Array.isArray(value.columns) && Array.isArray(value.rows)) {
      return renderTableToken(tokenName, value);
    }

    switch (def.type) {
      case "number":
        return escapeHtml(formatTableValue(value, { type: "number" }));
      case "currency": {
        const currency = typeof def.currency_code === "string" ? def.currency_code : "SEK";
        return escapeHtml(formatTableValue(value, { type: "currency", currency_code: currency }));
      }
      case "percent":
        return escapeHtml(formatTableValue(value, { type: "percent" }));
      case "date":
        return escapeHtml(formatDate(value));
      case "image_url":
        return escapeHtml(String(value));
      case "svg_chart": {
        const generator = resolveSvgGenerator(value, svgGenerators);
        if (!generator) {
          unfilled.add(tokenName);
          return "";
        }
        try {
          return generator(value, designColors);
        } catch {
          unfilled.add(tokenName);
          return "";
        }
      }
      case "text":
      default:
        return escapeHtml(String(value));
    }
  });

  TOKEN_REGEX.lastIndex = 0;

  return {
    html,
    unfilled_tokens: [...unfilled],
  };
}
