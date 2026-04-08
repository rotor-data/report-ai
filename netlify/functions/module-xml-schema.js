/**
 * Module XML Schema — Canonical intermediate format for report modules.
 *
 * Provides bidirectional conversion between the JSON content format
 * (used by save_module_content) and an XML representation suitable
 * for feeding into IDML, DOCX, and HTML converters.
 *
 * The XML format is self-describing: each <module> element carries its
 * type and id, and nested elements map 1:1 to the JSON schema fields
 * defined in module-renderers.js.
 */

// ─── Helpers ───────────────────────────────────────────────────────────────

function escXml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escAttr(str) {
  return escXml(str);
}

function indent(level) {
  return "  ".repeat(level);
}

/**
 * Convert plain text with **bold** and *italic* markers to inline XML.
 * Paragraphs separated by \n\n become <p> elements.
 */
function textToBodyXml(text, level) {
  if (!text) return "";
  const pad = indent(level);
  const paragraphs = String(text).split(/\n\n+/);
  return paragraphs
    .map((p) => {
      const inner = p
        .trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
      return `${pad}<p>${inner}</p>`;
    })
    .join("\n");
}

/**
 * Parse a <body> element back to plain text with markdown-style markers.
 */
function bodyXmlToText(bodyEl) {
  if (!bodyEl) return "";
  const paragraphs = findAll(bodyEl, "p");
  if (paragraphs.length === 0) return getTextContent(bodyEl);
  return paragraphs
    .map((p) => {
      return getInnerContent(p)
        .replace(/<strong>(.*?)<\/strong>/g, "**$1**")
        .replace(/<em>(.*?)<\/em>/g, "*$1*");
    })
    .join("\n\n");
}

// ─── Minimal XML Parser ───────────────────────────────────────────────────
// A lightweight DOM-like parser. No external dependencies.

class XmlNode {
  constructor(tag, attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.text = "";
  }
}

/**
 * Parse an XML string into a tree of XmlNode objects.
 * Handles self-closing tags, attributes, text nodes, and nested elements.
 * Does NOT handle CDATA, processing instructions, or DTDs.
 */
function parseXmlString(xml) {
  const str = xml.trim();
  let pos = 0;

  function skipWhitespace() {
    while (pos < str.length && /\s/.test(str[pos])) pos++;
  }

  function parseAttrs() {
    const attrs = {};
    while (pos < str.length) {
      skipWhitespace();
      if (str[pos] === ">" || str[pos] === "/" || pos >= str.length) break;
      // attribute name
      let name = "";
      while (pos < str.length && /[a-zA-Z0-9_\-:]/.test(str[pos])) {
        name += str[pos++];
      }
      if (!name) break;
      skipWhitespace();
      if (str[pos] === "=") {
        pos++; // skip =
        skipWhitespace();
        const quote = str[pos];
        if (quote === '"' || quote === "'") {
          pos++; // skip opening quote
          let val = "";
          while (pos < str.length && str[pos] !== quote) {
            if (str[pos] === "&") {
              val += parseEntity();
            } else {
              val += str[pos++];
            }
          }
          pos++; // skip closing quote
          attrs[name] = val;
        }
      } else {
        attrs[name] = "true";
      }
    }
    return attrs;
  }

  function parseEntity() {
    let entity = "";
    const start = pos;
    pos++; // skip &
    while (pos < str.length && str[pos] !== ";") entity += str[pos++];
    pos++; // skip ;
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: return str.slice(start, pos);
    }
  }

  function parseNode() {
    skipWhitespace();
    if (pos >= str.length) return null;

    // Skip comments
    if (str.slice(pos, pos + 4) === "<!--") {
      const end = str.indexOf("-->", pos + 4);
      pos = end === -1 ? str.length : end + 3;
      return parseNode();
    }

    // Skip XML declaration
    if (str.slice(pos, pos + 5) === "<?xml") {
      const end = str.indexOf("?>", pos + 5);
      pos = end === -1 ? str.length : end + 2;
      return parseNode();
    }

    if (str[pos] !== "<") return null;

    pos++; // skip <

    // closing tag — should not reach here normally
    if (str[pos] === "/") return null;

    // tag name
    let tag = "";
    while (pos < str.length && /[a-zA-Z0-9_\-:]/.test(str[pos])) {
      tag += str[pos++];
    }

    const attrs = parseAttrs();
    skipWhitespace();

    // self-closing
    if (str[pos] === "/") {
      pos++; // skip /
      if (str[pos] === ">") pos++; // skip >
      return new XmlNode(tag, attrs);
    }

    pos++; // skip >

    const node = new XmlNode(tag, attrs);

    // Parse children and text
    while (pos < str.length) {
      skipWhitespace();
      if (pos >= str.length) break;

      // Check for closing tag
      if (str[pos] === "<" && str[pos + 1] === "/") {
        // Skip </tagname>
        const closeEnd = str.indexOf(">", pos);
        pos = closeEnd + 1;
        break;
      }

      // Check for child element
      if (str[pos] === "<") {
        // Could be comment
        if (str.slice(pos, pos + 4) === "<!--") {
          const end = str.indexOf("-->", pos + 4);
          pos = end === -1 ? str.length : end + 3;
          continue;
        }
        const child = parseNode();
        if (child) node.children.push(child);
        else break;
      } else {
        // Text content — collect until next <
        let text = "";
        while (pos < str.length && str[pos] !== "<") {
          if (str[pos] === "&") {
            text += parseEntity();
          } else {
            text += str[pos++];
          }
        }
        node.text += text;
      }
    }

    return node;
  }

  return parseNode();
}

function findChild(node, tag) {
  if (!node || !node.children) return null;
  return node.children.find((c) => c.tag === tag) || null;
}

function findAll(node, tag) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.tag === tag);
}

function getTextContent(node) {
  if (!node) return "";
  let text = node.text || "";
  for (const child of node.children || []) {
    text += getTextContent(child);
  }
  return text.trim();
}

/**
 * Get inner content of a node as raw XML string (for inline markup like <p>text <strong>bold</strong></p>).
 * Reconstructs children as XML strings.
 */
function getInnerContent(node) {
  if (!node) return "";
  let result = node.text || "";
  for (const child of node.children || []) {
    if (child.tag === "strong" || child.tag === "em") {
      result += `<${child.tag}>${getTextContent(child)}</${child.tag}>`;
    } else {
      result += getTextContent(child);
    }
  }
  return result.trim();
}

// ─── Serializers (JSON → XML) ─────────────────────────────────────────────

const serializers = {
  cover(content, moduleId) {
    const lines = [`<module type="cover" id="${escAttr(moduleId)}">`];
    if (content.title) lines.push(`  <title>${escXml(content.title)}</title>`);
    if (content.subtitle) lines.push(`  <subtitle>${escXml(content.subtitle)}</subtitle>`);
    if (content.date) lines.push(`  <date>${escXml(content.date)}</date>`);
    if (content.author) lines.push(`  <author>${escXml(content.author)}</author>`);
    if (content.background_color) lines.push(`  <background_color>${escXml(content.background_color)}</background_color>`);
    lines.push("</module>");
    return lines.join("\n");
  },

  chapter_break(content, moduleId) {
    const lines = [`<module type="chapter_break" id="${escAttr(moduleId)}">`];
    if (content.chapter_number != null) lines.push(`  <chapter_number>${escXml(String(content.chapter_number))}</chapter_number>`);
    if (content.title) lines.push(`  <title>${escXml(content.title)}</title>`);
    if (content.subtitle) lines.push(`  <subtitle>${escXml(content.subtitle)}</subtitle>`);
    lines.push("</module>");
    return lines.join("\n");
  },

  text_spread(content, moduleId) {
    const lines = [`<module type="text_spread" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    if (content.body) {
      lines.push("  <body>");
      lines.push(textToBodyXml(content.body, 2));
      lines.push("  </body>");
    }
    if (content.aside) {
      lines.push("  <aside>");
      if (content.aside.text) lines.push(`    <quote>${escXml(content.aside.text)}</quote>`);
      if (content.aside.attribution) lines.push(`    <attribution>${escXml(content.aside.attribution)}</attribution>`);
      lines.push("  </aside>");
    }
    lines.push("</module>");
    return lines.join("\n");
  },

  kpi_grid(content, moduleId) {
    const lines = [`<module type="kpi_grid" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    for (const kpi of content.kpis || []) {
      const attrs = [`label="${escAttr(kpi.label)}"`, `value="${escAttr(kpi.value)}"`];
      if (kpi.unit) attrs.push(`unit="${escAttr(kpi.unit)}"`);
      if (kpi.change) attrs.push(`change="${escAttr(kpi.change)}"`);
      lines.push(`  <kpi ${attrs.join(" ")}/>`);
    }
    lines.push("</module>");
    return lines.join("\n");
  },

  table(content, moduleId) {
    const lines = [`<module type="table" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    if (content.caption) lines.push(`  <caption>${escXml(content.caption)}</caption>`);
    if (content.columns) {
      lines.push("  <columns>");
      for (const col of content.columns) {
        const attrs = [`header="${escAttr(col.header)}"`];
        if (col.align) attrs.push(`align="${escAttr(col.align)}"`);
        lines.push(`    <col ${attrs.join(" ")}/>`);
      }
      lines.push("  </columns>");
    }
    if (content.rows) {
      lines.push("  <rows>");
      for (const row of content.rows) {
        const cells = (row || []).map((v) => `<cell>${escXml(String(v ?? ""))}</cell>`).join("");
        lines.push(`    <row>${cells}</row>`);
      }
      lines.push("  </rows>");
    }
    if (content.total_row) {
      const cells = content.total_row.map((v) => `<cell>${escXml(String(v ?? ""))}</cell>`).join("");
      lines.push(`  <total>${cells}</total>`);
    }
    lines.push("</module>");
    return lines.join("\n");
  },

  data_chart(content, moduleId) {
    const lines = [`<module type="data_chart" id="${escAttr(moduleId)}">`];
    if (content.title) lines.push(`  <title>${escXml(content.title)}</title>`);
    if (content.caption) lines.push(`  <caption>${escXml(content.caption)}</caption>`);
    const chartType = content.chart_type || "bar";
    lines.push(`  <chart type="${escAttr(chartType)}">`);
    for (const s of content.series || []) {
      lines.push(`    <series label="${escAttr(s.label)}" value="${escAttr(String(s.value))}"/>`);
    }
    lines.push("  </chart>");
    if (content.x_label) lines.push(`  <x_label>${escXml(content.x_label)}</x_label>`);
    if (content.y_label) lines.push(`  <y_label>${escXml(content.y_label)}</y_label>`);
    lines.push("</module>");
    return lines.join("\n");
  },

  quote_callout(content, moduleId) {
    const lines = [`<module type="quote_callout" id="${escAttr(moduleId)}">`];
    if (content.quote) lines.push(`  <quote>${escXml(content.quote)}</quote>`);
    if (content.attribution) lines.push(`  <attribution>${escXml(content.attribution)}</attribution>`);
    if (content.role) lines.push(`  <role>${escXml(content.role)}</role>`);
    lines.push("</module>");
    return lines.join("\n");
  },

  image_text(content, moduleId) {
    const lines = [`<module type="image_text" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    if (content.body) {
      lines.push("  <body>");
      lines.push(textToBodyXml(content.body, 2));
      lines.push("  </body>");
    }
    const imgAttrs = [];
    if (content.image_alt) imgAttrs.push(`alt="${escAttr(content.image_alt)}"`);
    const pos = content.image_position || "left";
    imgAttrs.push(`position="${escAttr(pos)}"`);
    lines.push(`  <image ${imgAttrs.join(" ")}/>`);
    lines.push("</module>");
    return lines.join("\n");
  },

  two_col_text(content, moduleId) {
    const lines = [`<module type="two_col_text" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    if (content.body) {
      lines.push("  <body>");
      lines.push(textToBodyXml(content.body, 2));
      lines.push("  </body>");
    }
    lines.push("</module>");
    return lines.join("\n");
  },

  financial_summary(content, moduleId) {
    const lines = [`<module type="financial_summary" id="${escAttr(moduleId)}">`];
    if (content.heading) lines.push(`  <heading>${escXml(content.heading)}</heading>`);
    for (const h of content.hero_numbers || []) {
      const attrs = [`label="${escAttr(h.label)}"`, `value="${escAttr(h.value)}"`];
      if (h.unit) attrs.push(`unit="${escAttr(h.unit)}"`);
      lines.push(`  <hero ${attrs.join(" ")}/>`);
    }
    if (content.table) {
      lines.push("  <table>");
      if (content.table.columns) {
        lines.push("    <columns>");
        for (const col of content.table.columns) {
          const attrs = [`header="${escAttr(col.header)}"`];
          if (col.align) attrs.push(`align="${escAttr(col.align)}"`);
          lines.push(`      <col ${attrs.join(" ")}/>`);
        }
        lines.push("    </columns>");
      }
      if (content.table.rows) {
        lines.push("    <rows>");
        for (const row of content.table.rows) {
          const cells = (row || []).map((v) => `<cell>${escXml(String(v ?? ""))}</cell>`).join("");
          lines.push(`      <row>${cells}</row>`);
        }
        lines.push("    </rows>");
      }
      if (content.table.total_row) {
        const cells = content.table.total_row.map((v) => `<cell>${escXml(String(v ?? ""))}</cell>`).join("");
        lines.push(`    <total>${cells}</total>`);
      }
      lines.push("  </table>");
    }
    lines.push("</module>");
    return lines.join("\n");
  },

  back_cover(content, moduleId) {
    const lines = [`<module type="back_cover" id="${escAttr(moduleId)}">`];
    if (content.company_name) lines.push(`  <company_name>${escXml(content.company_name)}</company_name>`);
    if (content.tagline) lines.push(`  <tagline>${escXml(content.tagline)}</tagline>`);
    if (content.address) lines.push(`  <address>${escXml(content.address)}</address>`);
    if (content.phone) lines.push(`  <phone>${escXml(content.phone)}</phone>`);
    if (content.email) lines.push(`  <email>${escXml(content.email)}</email>`);
    if (content.website) lines.push(`  <website>${escXml(content.website)}</website>`);
    if (content.disclaimer) lines.push(`  <disclaimer>${escXml(content.disclaimer)}</disclaimer>`);
    lines.push("</module>");
    return lines.join("\n");
  },
};

// ─── Parsers (XML → JSON) ─────────────────────────────────────────────────

function parseTableNode(tableNode) {
  if (!tableNode) return null;
  const result = {};
  const columnsNode = findChild(tableNode, "columns");
  if (columnsNode) {
    result.columns = findAll(columnsNode, "col").map((c) => {
      const col = { header: c.attrs.header || "" };
      if (c.attrs.align) col.align = c.attrs.align;
      return col;
    });
  }
  const rowsNode = findChild(tableNode, "rows");
  if (rowsNode) {
    result.rows = findAll(rowsNode, "row").map((r) =>
      findAll(r, "cell").map((c) => getTextContent(c))
    );
  }
  const totalNode = findChild(tableNode, "total");
  if (totalNode) {
    result.total_row = findAll(totalNode, "cell").map((c) => getTextContent(c));
  }
  return result;
}

const parsers = {
  cover(node) {
    const result = {};
    const title = findChild(node, "title");
    if (title) result.title = getTextContent(title);
    const subtitle = findChild(node, "subtitle");
    if (subtitle) result.subtitle = getTextContent(subtitle);
    const date = findChild(node, "date");
    if (date) result.date = getTextContent(date);
    const author = findChild(node, "author");
    if (author) result.author = getTextContent(author);
    const bg = findChild(node, "background_color");
    if (bg) result.background_color = getTextContent(bg);
    return result;
  },

  chapter_break(node) {
    const result = {};
    const num = findChild(node, "chapter_number");
    if (num) result.chapter_number = parseInt(getTextContent(num), 10) || 0;
    const title = findChild(node, "title");
    if (title) result.title = getTextContent(title);
    const subtitle = findChild(node, "subtitle");
    if (subtitle) result.subtitle = getTextContent(subtitle);
    return result;
  },

  text_spread(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    const body = findChild(node, "body");
    if (body) result.body = bodyXmlToText(body);
    const aside = findChild(node, "aside");
    if (aside) {
      result.aside = {};
      const quote = findChild(aside, "quote");
      if (quote) result.aside.text = getTextContent(quote);
      const attr = findChild(aside, "attribution");
      if (attr) result.aside.attribution = getTextContent(attr);
    }
    return result;
  },

  kpi_grid(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    result.kpis = findAll(node, "kpi").map((k) => {
      const kpi = { label: k.attrs.label || "", value: k.attrs.value || "" };
      if (k.attrs.unit) kpi.unit = k.attrs.unit;
      if (k.attrs.change) kpi.change = k.attrs.change;
      return kpi;
    });
    return result;
  },

  table(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    const caption = findChild(node, "caption");
    if (caption) result.caption = getTextContent(caption);
    const tableData = parseTableNode(node);
    if (tableData) Object.assign(result, tableData);
    return result;
  },

  data_chart(node) {
    const result = {};
    const title = findChild(node, "title");
    if (title) result.title = getTextContent(title);
    const caption = findChild(node, "caption");
    if (caption) result.caption = getTextContent(caption);
    const chart = findChild(node, "chart");
    if (chart) {
      result.chart_type = chart.attrs.type || "bar";
      result.series = findAll(chart, "series").map((s) => ({
        label: s.attrs.label || "",
        value: parseFloat(s.attrs.value) || 0,
      }));
    }
    const xLabel = findChild(node, "x_label");
    if (xLabel) result.x_label = getTextContent(xLabel);
    const yLabel = findChild(node, "y_label");
    if (yLabel) result.y_label = getTextContent(yLabel);
    return result;
  },

  quote_callout(node) {
    const result = {};
    const quote = findChild(node, "quote");
    if (quote) result.quote = getTextContent(quote);
    const attr = findChild(node, "attribution");
    if (attr) result.attribution = getTextContent(attr);
    const role = findChild(node, "role");
    if (role) result.role = getTextContent(role);
    return result;
  },

  image_text(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    const body = findChild(node, "body");
    if (body) result.body = bodyXmlToText(body);
    const image = findChild(node, "image");
    if (image) {
      if (image.attrs.alt) result.image_alt = image.attrs.alt;
      if (image.attrs.position) result.image_position = image.attrs.position;
    }
    return result;
  },

  two_col_text(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    const body = findChild(node, "body");
    if (body) result.body = bodyXmlToText(body);
    return result;
  },

  financial_summary(node) {
    const result = {};
    const heading = findChild(node, "heading");
    if (heading) result.heading = getTextContent(heading);
    result.hero_numbers = findAll(node, "hero").map((h) => {
      const hero = { label: h.attrs.label || "", value: h.attrs.value || "" };
      if (h.attrs.unit) hero.unit = h.attrs.unit;
      return hero;
    });
    const tableNode = findChild(node, "table");
    if (tableNode) {
      result.table = parseTableNode(tableNode);
    }
    return result;
  },

  back_cover(node) {
    const result = {};
    const fields = ["company_name", "tagline", "address", "phone", "email", "website", "disclaimer"];
    for (const f of fields) {
      const child = findChild(node, f);
      if (child) result[f] = getTextContent(child);
    }
    return result;
  },
};

// ─── Validation ───────────────────────────────────────────────────────────

const VALID_MODULE_TYPES = new Set([
  "cover", "chapter_break", "text_spread", "kpi_grid", "table",
  "data_chart", "quote_callout", "image_text", "two_col_text",
  "financial_summary", "back_cover",
]);

const REQUIRED_FIELDS = {
  cover: ["title"],
  chapter_break: ["title"],
  text_spread: ["body"],
  kpi_grid: ["kpis"],
  table: ["columns", "rows"],
  data_chart: ["chart_type", "series"],
  quote_callout: ["quote"],
  image_text: ["body"],
  two_col_text: ["body"],
  financial_summary: ["hero_numbers"],
  back_cover: ["company_name"],
};

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Parse a module XML string into a JSON object compatible with save_module_content.
 *
 * @param {string} xmlString — XML string containing a single <module> element
 * @returns {{ type: string, id: string, content: object }}
 */
export function parseModuleXml(xmlString) {
  const root = parseXmlString(xmlString);
  if (!root || root.tag !== "module") {
    throw new Error("XML must have a root <module> element");
  }

  const type = root.attrs.type;
  const id = root.attrs.id || "";

  if (!type || !VALID_MODULE_TYPES.has(type)) {
    throw new Error(`Invalid module type: "${type}". Must be one of: ${[...VALID_MODULE_TYPES].join(", ")}`);
  }

  const parser = parsers[type];
  if (!parser) {
    throw new Error(`No parser for module type: ${type}`);
  }

  return { type, id, content: parser(root) };
}

/**
 * Serialize a JSON content object to module XML.
 *
 * @param {object} jsonContent — Content object matching module schema
 * @param {string} moduleType — One of the 11 module types
 * @param {string} moduleId — Module ID
 * @returns {string} XML string
 */
export function serializeModuleXml(jsonContent, moduleType, moduleId) {
  if (!VALID_MODULE_TYPES.has(moduleType)) {
    throw new Error(`Invalid module type: "${moduleType}"`);
  }

  const serializer = serializers[moduleType];
  if (!serializer) {
    throw new Error(`No serializer for module type: ${moduleType}`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializer(jsonContent || {}, moduleId || "unknown")}`;
}

/**
 * Validate a module XML string without fully parsing it.
 *
 * @param {string} xmlString
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateModuleXml(xmlString) {
  const errors = [];

  if (!xmlString || typeof xmlString !== "string") {
    return { valid: false, errors: ["Input must be a non-empty string"] };
  }

  let root;
  try {
    root = parseXmlString(xmlString);
  } catch (e) {
    return { valid: false, errors: [`XML parse error: ${e.message}`] };
  }

  if (!root) {
    errors.push("Could not parse any XML element");
    return { valid: false, errors };
  }

  if (root.tag !== "module") {
    errors.push(`Root element must be <module>, got <${root.tag}>`);
  }

  const type = root.attrs.type;
  if (!type) {
    errors.push('Missing required attribute: type on <module>');
  } else if (!VALID_MODULE_TYPES.has(type)) {
    errors.push(`Invalid module type: "${type}". Must be one of: ${[...VALID_MODULE_TYPES].join(", ")}`);
  }

  if (!root.attrs.id) {
    errors.push('Missing recommended attribute: id on <module>');
  }

  // Validate required fields if type is known
  if (type && VALID_MODULE_TYPES.has(type)) {
    const requiredFields = REQUIRED_FIELDS[type] || [];
    try {
      const parsed = parsers[type](root);
      for (const field of requiredFields) {
        const val = parsed[field];
        if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) {
          errors.push(`Missing required field for ${type}: ${field}`);
        }
      }
    } catch (e) {
      errors.push(`Parse error for ${type}: ${e.message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse multiple modules from a document XML wrapper.
 *
 * @param {string} xmlString — XML with <document> root containing <module> children
 * @returns {Array<{ type: string, id: string, content: object }>}
 */
export function parseDocumentXml(xmlString) {
  const root = parseXmlString(xmlString);
  if (!root) throw new Error("Could not parse XML");

  // If root is a single module, return it as an array
  if (root.tag === "module") {
    return [parseModuleXml(xmlString)];
  }

  // Otherwise expect a wrapper element with module children
  const modules = findAll(root, "module");
  return modules.map((moduleNode) => {
    const type = moduleNode.attrs.type;
    const id = moduleNode.attrs.id || "";
    if (!type || !VALID_MODULE_TYPES.has(type)) {
      throw new Error(`Invalid module type: "${type}"`);
    }
    return { type, id, content: parsers[type](moduleNode) };
  });
}

/**
 * Serialize an array of modules into a complete document XML string.
 *
 * @param {Array<{ type: string, id: string, content: object }>} modules
 * @returns {string}
 */
export function serializeDocumentXml(modules) {
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<document>`];
  for (const mod of modules) {
    const serializer = serializers[mod.type];
    if (!serializer) continue;
    const xml = serializer(mod.content || {}, mod.id || "unknown");
    // Indent each line of the module XML
    lines.push(xml.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  lines.push("</document>");
  return lines.join("\n");
}

// Re-export the internal parser for use by converters
export { parseXmlString, findChild, findAll, getTextContent, escXml, escAttr, VALID_MODULE_TYPES };
