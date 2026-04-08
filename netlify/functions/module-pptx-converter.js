/**
 * Module PPTX Converter — JSON → PowerPoint PPTX
 *
 * PPTX (Office Open XML Presentation) is a ZIP package of XML files.
 * This converter creates a valid .pptx file that PowerPoint can open,
 * mapping report module content to slides with styled text, tables, and shapes.
 *
 * Minimum PPTX structure:
 *   [Content_Types].xml                         — content type declarations
 *   _rels/.rels                                 — package relationships
 *   ppt/presentation.xml                        — main presentation
 *   ppt/_rels/presentation.xml.rels             — presentation relationships
 *   ppt/slideMasters/slideMaster1.xml           — slide master
 *   ppt/slideMasters/_rels/slideMaster1.xml.rels
 *   ppt/slideLayouts/slideLayout1.xml           — title layout
 *   ppt/slideLayouts/slideLayout2.xml           — content layout
 *   ppt/slideLayouts/_rels/slideLayout1.xml.rels
 *   ppt/slideLayouts/_rels/slideLayout2.xml.rels
 *   ppt/slides/slide1.xml ... slideN.xml        — one per module
 *   ppt/slides/_rels/slide1.xml.rels ...
 *   ppt/theme/theme1.xml                        — color + font theme
 */

import { Buffer } from "node:buffer";
import { escXml } from "./module-xml-schema.js";

// ─── ZIP creation (same pattern as DOCX converter) ──────────────────────

class ZipBuilder {
  constructor() {
    this.files = [];
  }

  addFile(path, content) {
    const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    this.files.push({ path, data });
  }

  build() {
    const entries = [];
    let offset = 0;

    const localParts = [];
    for (const file of this.files) {
      const pathBuf = Buffer.from(file.path, "utf-8");
      const crc = crc32(file.data);
      const size = file.data.length;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(size, 18);
      header.writeUInt32LE(size, 22);
      header.writeUInt16LE(pathBuf.length, 26);
      header.writeUInt16LE(0, 28);

      entries.push({ offset, pathBuf, crc, size });
      localParts.push(header, pathBuf, file.data);
      offset += 30 + pathBuf.length + size;
    }

    const centralStart = offset;
    const centralParts = [];
    for (let i = 0; i < this.files.length; i++) {
      const { pathBuf, crc, size, offset: localOffset } = entries[i];
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);
      cdh.writeUInt16LE(20, 6);
      cdh.writeUInt16LE(0, 8);
      cdh.writeUInt16LE(0, 10);
      cdh.writeUInt16LE(0, 12);
      cdh.writeUInt16LE(0, 14);
      cdh.writeUInt32LE(crc, 16);
      cdh.writeUInt32LE(size, 20);
      cdh.writeUInt32LE(size, 24);
      cdh.writeUInt16LE(pathBuf.length, 28);
      cdh.writeUInt16LE(0, 30);
      cdh.writeUInt16LE(0, 32);
      cdh.writeUInt16LE(0, 34);
      cdh.writeUInt16LE(0, 36);
      cdh.writeUInt32LE(0, 38);
      cdh.writeUInt32LE(localOffset, 42);
      centralParts.push(cdh, pathBuf);
      offset += 46 + pathBuf.length;
    }

    const centralSize = offset - centralStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.files.length, 8);
    eocd.writeUInt16LE(this.files.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, eocd]);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── OOXML Namespaces ─────────────────────────────────────────────────────

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

// ─── Slide dimensions (16:9 standard) ─────────────────────────────────────

const SLIDE_W = 12192000; // 33.867 cm in EMU
const SLIDE_H = 6858000;  // 19.05 cm in EMU

// Margins
const MARGIN_L = 457200;  // ~1.27 cm
const MARGIN_T = 365760;  // ~1.02 cm
const MARGIN_R = 457200;
const MARGIN_B = 365760;

const CONTENT_W = SLIDE_W - MARGIN_L - MARGIN_R; // usable width
const CONTENT_H = SLIDE_H - MARGIN_T - MARGIN_B;

// Unit conversions
function ptToEmu(pt) { return Math.round(pt * 12700); }
function cmToEmu(cm) { return Math.round(cm * 360000); }

// Font sizes in hundredths of a point
function ptToHundredths(pt) { return Math.round(pt * 100); }

// ─── Color helper ─────────────────────────────────────────────────────────

function hexColor(hex) {
  if (!hex) return "000000";
  return hex.replace("#", "").toUpperCase();
}

// ─── Text run helpers ─────────────────────────────────────────────────────

function aRun(text, opts = {}) {
  const { bold, italic, size, color, font } = opts;
  let rPr = "";
  const rPrAttrs = [];
  if (size) rPrAttrs.push(`sz="${ptToHundredths(size)}"`);
  if (bold) rPrAttrs.push('b="1"');
  if (italic) rPrAttrs.push('i="1"');
  const rPrChildren = [];
  if (color) rPrChildren.push(`<a:solidFill><a:srgbClr val="${hexColor(color)}"/></a:solidFill>`);
  if (font) rPrChildren.push(`<a:latin typeface="${escXml(font)}"/><a:cs typeface="${escXml(font)}"/>`);

  if (rPrAttrs.length || rPrChildren.length) {
    rPr = `<a:rPr lang="sv-SE" ${rPrAttrs.join(" ")} dirty="0">${rPrChildren.join("")}</a:rPr>`;
  }

  return `<a:r>${rPr}<a:t>${escXml(text)}</a:t></a:r>`;
}

function aPara(runs, opts = {}) {
  const { align, spaceAfter, spaceBefore, lineSpacing } = opts;
  const pPrParts = [];
  if (align) pPrParts.push(`algn="${align}"`);

  const spcParts = [];
  if (spaceBefore != null) spcParts.push(`<a:spcBef><a:spcPts val="${Math.round(spaceBefore * 100)}"/></a:spcBef>`);
  if (spaceAfter != null) spcParts.push(`<a:spcAft><a:spcPts val="${Math.round(spaceAfter * 100)}"/></a:spcAft>`);
  if (lineSpacing != null) spcParts.push(`<a:lnSpc><a:spcPct val="${Math.round(lineSpacing * 1000)}"/></a:lnSpc>`);

  const pPr = (pPrParts.length || spcParts.length)
    ? `<a:pPr ${pPrParts.join(" ")}>${spcParts.join("")}</a:pPr>`
    : "";

  return `<a:p>${pPr}${runs.join("")}</a:p>`;
}

/** Parse markdown bold/italic into runs */
function textRuns(text, baseOpts = {}) {
  if (!text) return [aRun("", baseOpts)];
  const runs = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(aRun(text.slice(lastIndex, match.index), baseOpts));
    }
    if (match[1]) {
      runs.push(aRun(match[1], { ...baseOpts, bold: true }));
    } else if (match[2]) {
      runs.push(aRun(match[2], { ...baseOpts, italic: true }));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push(aRun(text.slice(lastIndex), baseOpts));
  }
  if (runs.length === 0) runs.push(aRun(text, baseOpts));
  return runs;
}

/** Convert body text (with double-newline paragraphs) into <a:p> elements */
function bodyParas(text, baseOpts = {}) {
  if (!text) return [];
  return String(text).split(/\n\n+/).map((p) =>
    aPara(textRuns(p.trim(), baseOpts), { spaceAfter: 6, lineSpacing: 115 })
  );
}

// ─── Shape (text box) helper ──────────────────────────────────────────────

function textBox(x, y, w, h, paragraphs, opts = {}) {
  const { anchor = "t", wrap = "square" } = opts;
  return `<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="0" name=""/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:noFill/>
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="${wrap}" anchor="${anchor}" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/>
    <a:lstStyle/>
    ${paragraphs.join("\n    ")}
  </p:txBody>
</p:sp>`;
}

/** Filled rectangle shape (for backgrounds, cards, etc.) */
function filledRect(x, y, w, h, fillColor) {
  return `<p:sp>
  <p:nvSpPr>
    <p:cNvPr id="0" name=""/>
    <p:cNvSpPr/>
    <p:nvPr/>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="${hexColor(fillColor)}"/></a:solidFill>
    <a:ln><a:noFill/></a:ln>
  </p:spPr>
</p:sp>`;
}

// ─── Table helper ─────────────────────────────────────────────────────────

function slideTable(x, y, w, columns, rows, opts = {}) {
  const { headerBg, headerFg = "FFFFFF", bodySize = 10, headerSize = 10, totalRow } = opts;
  const numCols = columns.length;
  const colW = Math.floor(w / numCols);

  const gridCols = columns.map(() => `<a:gridCol w="${colW}"/>`).join("");

  // Header row
  const headerCells = columns.map((col) => {
    const align = col.align === "right" ? "r" : "l";
    return `<a:tc>
      <a:txBody>
        <a:bodyPr/>
        <a:lstStyle/>
        ${aPara([aRun(col.header || "", { bold: true, size: headerSize, color: headerFg })], { align })}
      </a:txBody>
      <a:tcPr>
        <a:solidFill><a:srgbClr val="${hexColor(headerBg)}"/></a:solidFill>
      </a:tcPr>
    </a:tc>`;
  }).join("");

  const headerRowH = ptToEmu(headerSize * 2.5);

  // Data rows
  const dataRowH = ptToEmu(bodySize * 2.5);
  const dataRows = (rows || []).map((row) => {
    const cells = columns.map((col, i) => {
      const val = (row && row[i] != null) ? String(row[i]) : "";
      const align = col.align === "right" ? "r" : "l";
      return `<a:tc>
        <a:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${aPara([aRun(val, { size: bodySize })], { align })}
        </a:txBody>
        <a:tcPr/>
      </a:tc>`;
    }).join("");
    return `<a:tr h="${dataRowH}">${cells}</a:tr>`;
  }).join("\n");

  // Total row
  let totalRowXml = "";
  if (totalRow) {
    const totalCells = columns.map((col, i) => {
      const val = (totalRow[i] != null) ? String(totalRow[i]) : "";
      const align = col.align === "right" ? "r" : "l";
      return `<a:tc>
        <a:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${aPara([aRun(val, { bold: true, size: bodySize })], { align })}
        </a:txBody>
        <a:tcPr>
          <a:lnT w="19050" cap="flat" cmpd="sng"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnT>
        </a:tcPr>
      </a:tc>`;
    }).join("");
    totalRowXml = `<a:tr h="${dataRowH}">${totalCells}</a:tr>`;
  }

  const totalH = headerRowH + dataRowH * (rows || []).length + (totalRow ? dataRowH : 0);

  return `<p:graphicFrame>
  <p:nvGraphicFramePr>
    <p:cNvPr id="0" name="Table"/>
    <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
    <p:nvPr/>
  </p:nvGraphicFramePr>
  <p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${totalH}"/></p:xfrm>
  <a:graphic>
    <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
      <a:tbl>
        <a:tblPr firstRow="1" bandRow="1">
          <a:noFill/>
        </a:tblPr>
        <a:tblGrid>${gridCols}</a:tblGrid>
        <a:tr h="${headerRowH}">${headerCells}</a:tr>
        ${dataRows}
        ${totalRowXml}
      </a:tbl>
    </a:graphicData>
  </a:graphic>
</p:graphicFrame>`;
}

// ─── Module → Slide renderers ─────────────────────────────────────────────

const slideRenderers = {
  cover(content, ds) {
    const primary = ds.colors?.primary || "#1a365d";
    const bg = content.background_color || primary;
    const headingFont = ds.typography?.heading_family || "Calibri";
    const shapes = [];

    // Full-slide background
    shapes.push(filledRect(0, 0, SLIDE_W, SLIDE_H, bg));

    // Title — centered
    const titleParas = [];
    if (content.subtitle) {
      titleParas.push(aPara([aRun(content.subtitle, { size: 16, color: "FFFFFF", font: headingFont })], { align: "ctr", spaceAfter: 8 }));
    }
    if (content.title) {
      titleParas.push(aPara([aRun(content.title, { size: 36, bold: true, color: "FFFFFF", font: headingFont })], { align: "ctr", spaceAfter: 12 }));
    }
    if (content.date) {
      titleParas.push(aPara([aRun(content.date, { size: 14, color: "FFFFFF" })], { align: "ctr", spaceAfter: 4 }));
    }
    if (content.author) {
      titleParas.push(aPara([aRun(content.author, { size: 12, color: "FFFFFF" })], { align: "ctr" }));
    }
    if (titleParas.length === 0) titleParas.push(aPara([aRun("")]));

    shapes.push(textBox(MARGIN_L, cmToEmu(5), CONTENT_W, cmToEmu(10), titleParas, { anchor: "ctr" }));

    return shapes.join("\n");
  },

  chapter_break(content, ds) {
    const primary = ds.colors?.primary || "#1a365d";
    const headingFont = ds.typography?.heading_family || "Calibri";
    const shapes = [];

    shapes.push(filledRect(0, 0, SLIDE_W, SLIDE_H, primary));

    const paras = [];
    if (content.chapter_number != null) {
      paras.push(aPara([aRun(String(content.chapter_number), { size: 48, bold: true, color: "FFFFFF", font: headingFont })], { align: "l", spaceAfter: 8 }));
    }
    if (content.title) {
      paras.push(aPara([aRun(content.title, { size: 32, bold: true, color: "FFFFFF", font: headingFont })], { align: "l", spaceAfter: 8 }));
    }
    if (content.subtitle) {
      paras.push(aPara([aRun(content.subtitle, { size: 18, color: "FFFFFF" })], { align: "l" }));
    }
    if (paras.length === 0) paras.push(aPara([aRun("")]));

    shapes.push(textBox(MARGIN_L, cmToEmu(5), CONTENT_W, cmToEmu(10), paras, { anchor: "ctr" }));

    return shapes.join("\n");
  },

  text_spread(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const bodyFont = ds.typography?.body_family || "Cambria";
    const textColor = ds.colors?.text || "#1a202c";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    const paras = [];
    if (content.heading) {
      paras.push(aPara([aRun(content.heading, { size: 24, bold: true, color: textColor, font: headingFont })], { spaceAfter: 12 }));
    }
    paras.push(...bodyParas(content.body, { size: baseSize, color: textColor, font: bodyFont }));

    if (content.aside) {
      const primary = ds.colors?.primary || "#1a365d";
      if (content.aside.text) {
        paras.push(aPara([aRun("")])); // spacer
        paras.push(aPara([aRun(`\u201C${content.aside.text}\u201D`, { size: 14, italic: true, color: primary, font: headingFont })], { spaceAfter: 4 }));
      }
      if (content.aside.attribution) {
        paras.push(aPara([aRun(`\u2014 ${content.aside.attribution}`, { size: 10, color: textColor })], {}));
      }
    }

    if (paras.length === 0) paras.push(aPara([aRun("")]));
    shapes.push(textBox(MARGIN_L, MARGIN_T, CONTENT_W, CONTENT_H, paras));

    return shapes.join("\n");
  },

  kpi_grid(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const primary = ds.colors?.primary || "#1a365d";
    const textColor = ds.colors?.text || "#1a202c";
    const textLight = ds.colors?.text_light || "#718096";
    const surface = ds.colors?.surface || "#f7fafc";
    const shapes = [];

    let yPos = MARGIN_T;

    if (content.heading) {
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(36), [
        aPara([aRun(content.heading, { size: 24, bold: true, color: textColor, font: headingFont })]),
      ]));
      yPos += ptToEmu(44);
    }

    const kpis = content.kpis || [];
    if (kpis.length > 0) {
      const cols = Math.min(kpis.length, 4);
      const cardW = Math.floor((CONTENT_W - cmToEmu(0.5) * (cols - 1)) / cols);
      const cardH = cmToEmu(4);
      const gap = cmToEmu(0.5);

      for (let i = 0; i < kpis.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = MARGIN_L + col * (cardW + gap);
        const y = yPos + row * (cardH + gap);

        // Card background
        shapes.push(filledRect(x, y, cardW, cardH, surface));

        // KPI content
        const kpiParas = [];
        const valueText = `${kpis[i].value}${kpis[i].unit ? ` ${kpis[i].unit}` : ""}`;
        kpiParas.push(aPara([aRun(valueText, { size: 28, bold: true, color: primary, font: headingFont })], { align: "ctr", spaceAfter: 4 }));
        kpiParas.push(aPara([aRun(kpis[i].label || "", { size: 10, color: textLight })], { align: "ctr", spaceAfter: 2 }));
        if (kpis[i].change) {
          kpiParas.push(aPara([aRun(kpis[i].change, { size: 9, color: textLight })], { align: "ctr" }));
        }

        shapes.push(textBox(x, y, cardW, cardH, kpiParas, { anchor: "ctr" }));
      }
    }

    return shapes.join("\n");
  },

  table(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const primary = ds.colors?.primary || "#1a365d";
    const textColor = ds.colors?.text || "#1a202c";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    let yPos = MARGIN_T;

    if (content.heading) {
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(36), [
        aPara([aRun(content.heading, { size: 24, bold: true, color: textColor, font: headingFont })]),
      ]));
      yPos += ptToEmu(44);
    }

    if (content.columns && content.rows) {
      shapes.push(slideTable(
        MARGIN_L, yPos, CONTENT_W,
        content.columns, content.rows,
        { headerBg: primary, bodySize: baseSize, headerSize: baseSize, totalRow: content.total_row }
      ));
    }

    if (content.caption) {
      const tableH = ptToEmu(baseSize * 2.5) * ((content.rows || []).length + 1 + (content.total_row ? 1 : 0));
      shapes.push(textBox(MARGIN_L, yPos + tableH + ptToEmu(8), CONTENT_W, ptToEmu(20), [
        aPara([aRun(content.caption, { size: 8, italic: true, color: ds.colors?.text_light || "#718096" })]),
      ]));
    }

    return shapes.join("\n");
  },

  data_chart(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const primary = ds.colors?.primary || "#1a365d";
    const textColor = ds.colors?.text || "#1a202c";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    let yPos = MARGIN_T;

    if (content.title) {
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(36), [
        aPara([aRun(content.title, { size: 24, bold: true, color: textColor, font: headingFont })]),
      ]));
      yPos += ptToEmu(44);
    }

    // Render chart data as a table (real charts need PowerPoint's built-in chart engine)
    const series = content.series || [];
    if (series.length > 0) {
      const columns = [
        { header: content.x_label || "Label", align: "left" },
        { header: content.y_label || "Value", align: "right" },
      ];
      const rows = series.map((s) => [s.label, String(s.value)]);

      shapes.push(slideTable(
        MARGIN_L, yPos, CONTENT_W,
        columns, rows,
        { headerBg: primary, bodySize: baseSize, headerSize: baseSize }
      ));

      const tableH = ptToEmu(baseSize * 2.5) * (rows.length + 1);
      yPos += tableH + ptToEmu(12);
    }

    const chartNote = `[${content.chart_type || "bar"} chart \u2014 data shown as table; convert to chart in PowerPoint]`;
    shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(20), [
      aPara([aRun(chartNote, { size: 8, italic: true, color: ds.colors?.text_light || "#718096" })]),
    ]));

    if (content.caption) {
      yPos += ptToEmu(24);
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(20), [
        aPara([aRun(content.caption, { size: 8, italic: true, color: ds.colors?.text_light || "#718096" })]),
      ]));
    }

    return shapes.join("\n");
  },

  quote_callout(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const primary = ds.colors?.primary || "#1a365d";
    const textColor = ds.colors?.text || "#1a202c";
    const shapes = [];

    const paras = [];
    if (content.quote) {
      paras.push(aPara([aRun(`\u201C${content.quote}\u201D`, { size: 28, italic: true, color: primary, font: headingFont })], { align: "ctr", spaceAfter: 16 }));
    }
    if (content.attribution) {
      const attrText = content.role ? `${content.attribution}, ${content.role}` : content.attribution;
      paras.push(aPara([aRun(`\u2014 ${attrText}`, { size: 14, color: textColor })], { align: "ctr" }));
    }
    if (paras.length === 0) paras.push(aPara([aRun("")]));

    shapes.push(textBox(cmToEmu(3), cmToEmu(3), SLIDE_W - cmToEmu(6), SLIDE_H - cmToEmu(6), paras, { anchor: "ctr" }));

    return shapes.join("\n");
  },

  image_text(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const bodyFont = ds.typography?.body_family || "Cambria";
    const textColor = ds.colors?.text || "#1a202c";
    const surface = ds.colors?.surface || "#f7fafc";
    const textLight = ds.colors?.text_light || "#718096";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    const halfW = Math.floor(CONTENT_W / 2) - cmToEmu(0.25);

    // Left: image placeholder
    shapes.push(filledRect(MARGIN_L, MARGIN_T, halfW, CONTENT_H, surface));
    shapes.push(textBox(MARGIN_L, MARGIN_T, halfW, CONTENT_H, [
      aPara([aRun(`[Image: ${content.image_alt || "Image"}]`, { size: 12, color: textLight })], { align: "ctr" }),
    ], { anchor: "ctr" }));

    // Right: text
    const rightX = MARGIN_L + halfW + cmToEmu(0.5);
    const paras = [];
    if (content.heading) {
      paras.push(aPara([aRun(content.heading, { size: 20, bold: true, color: textColor, font: headingFont })], { spaceAfter: 8 }));
    }
    paras.push(...bodyParas(content.body, { size: baseSize, color: textColor, font: bodyFont }));
    if (paras.length === 0) paras.push(aPara([aRun("")]));

    shapes.push(textBox(rightX, MARGIN_T, halfW, CONTENT_H, paras));

    return shapes.join("\n");
  },

  two_col_text(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const bodyFont = ds.typography?.body_family || "Cambria";
    const textColor = ds.colors?.text || "#1a202c";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    let yPos = MARGIN_T;

    if (content.heading) {
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(36), [
        aPara([aRun(content.heading, { size: 24, bold: true, color: textColor, font: headingFont })]),
      ]));
      yPos += ptToEmu(44);
    }

    // Split body text into two columns
    const bodyText = content.body || "";
    const paragraphs = bodyText.split(/\n\n+/).filter(Boolean);
    const midPoint = Math.ceil(paragraphs.length / 2);
    const leftParas = paragraphs.slice(0, midPoint);
    const rightParas = paragraphs.slice(midPoint);

    const halfW = Math.floor(CONTENT_W / 2) - cmToEmu(0.25);
    const colH = SLIDE_H - yPos - MARGIN_B;

    // Left column
    const leftRunParas = leftParas.map((p) =>
      aPara(textRuns(p.trim(), { size: baseSize, color: textColor, font: bodyFont }), { spaceAfter: 6, lineSpacing: 115 })
    );
    if (leftRunParas.length > 0) {
      shapes.push(textBox(MARGIN_L, yPos, halfW, colH, leftRunParas));
    }

    // Right column
    const rightX = MARGIN_L + halfW + cmToEmu(0.5);
    const rightRunParas = rightParas.map((p) =>
      aPara(textRuns(p.trim(), { size: baseSize, color: textColor, font: bodyFont }), { spaceAfter: 6, lineSpacing: 115 })
    );
    if (rightRunParas.length > 0) {
      shapes.push(textBox(rightX, yPos, halfW, colH, rightRunParas));
    }

    return shapes.join("\n");
  },

  financial_summary(content, ds) {
    const headingFont = ds.typography?.heading_family || "Calibri";
    const primary = ds.colors?.primary || "#1a365d";
    const textColor = ds.colors?.text || "#1a202c";
    const textLight = ds.colors?.text_light || "#718096";
    const baseSize = ds.typography?.base_size_pt || 10;
    const shapes = [];

    let yPos = MARGIN_T;

    if (content.heading) {
      shapes.push(textBox(MARGIN_L, yPos, CONTENT_W, ptToEmu(36), [
        aPara([aRun(content.heading, { size: 24, bold: true, color: textColor, font: headingFont })]),
      ]));
      yPos += ptToEmu(44);
    }

    // Hero numbers
    const heroes = content.hero_numbers || [];
    if (heroes.length > 0) {
      const cols = Math.min(heroes.length, 4);
      const cardW = Math.floor((CONTENT_W - cmToEmu(0.5) * (cols - 1)) / cols);
      const cardH = cmToEmu(2.5);
      const gap = cmToEmu(0.5);

      for (let i = 0; i < heroes.length; i++) {
        const col = i % cols;
        const x = MARGIN_L + col * (cardW + gap);

        const heroParas = [];
        const valueText = `${heroes[i].value}${heroes[i].unit ? ` ${heroes[i].unit}` : ""}`;
        heroParas.push(aPara([aRun(valueText, { size: 28, bold: true, color: primary, font: headingFont })], { align: "ctr", spaceAfter: 4 }));
        heroParas.push(aPara([aRun(heroes[i].label || "", { size: 10, color: textLight })], { align: "ctr" }));

        shapes.push(textBox(x, yPos, cardW, cardH, heroParas, { anchor: "ctr" }));
      }

      yPos += cardH + cmToEmu(0.5);
    }

    // Table
    if (content.table?.columns && content.table?.rows) {
      shapes.push(slideTable(
        MARGIN_L, yPos, CONTENT_W,
        content.table.columns, content.table.rows,
        { headerBg: primary, bodySize: baseSize, headerSize: baseSize, totalRow: content.table.total_row }
      ));
    }

    return shapes.join("\n");
  },

  back_cover(content, ds) {
    const primary = ds.colors?.primary || "#1a365d";
    const headingFont = ds.typography?.heading_family || "Calibri";
    const shapes = [];

    shapes.push(filledRect(0, 0, SLIDE_W, SLIDE_H, primary));

    const paras = [];
    if (content.company_name) {
      paras.push(aPara([aRun(content.company_name, { size: 28, bold: true, color: "FFFFFF", font: headingFont })], { align: "ctr", spaceAfter: 8 }));
    }
    if (content.tagline) {
      paras.push(aPara([aRun(content.tagline, { size: 16, italic: true, color: "FFFFFF" })], { align: "ctr", spaceAfter: 16 }));
    }

    const contactParts = [content.address, content.phone, content.email, content.website].filter(Boolean);
    for (const line of contactParts) {
      paras.push(aPara([aRun(line, { size: 12, color: "FFFFFF" })], { align: "ctr", spaceAfter: 4 }));
    }

    if (content.disclaimer) {
      paras.push(aPara([aRun("")])); // spacer
      paras.push(aPara([aRun(content.disclaimer, { size: 8, italic: true, color: "FFFFFF" })], { align: "ctr" }));
    }

    if (paras.length === 0) paras.push(aPara([aRun("")]));

    shapes.push(textBox(cmToEmu(3), cmToEmu(3), SLIDE_W - cmToEmu(6), SLIDE_H - cmToEmu(6), paras, { anchor: "ctr" }));

    return shapes.join("\n");
  },
};

// ─── PPTX package generators ──────────────────────────────────────────────

function generateContentTypes(slideCount) {
  const slideOverrides = [];
  for (let i = 1; i <= slideCount; i++) {
    slideOverrides.push(`  <Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slideOverrides.join("\n")}
</Types>`;
}

function generateRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
}

function generatePresentation(slideCount) {
  // rId1 = slideMaster, rId2 = theme, rId3..rId(2+slideCount) = slides
  const slideIdEntries = [];
  for (let i = 0; i < slideCount; i++) {
    const slideId = 256 + i; // slide IDs start at 256
    const rId = `rId${3 + i}`;
    slideIdEntries.push(`    <p:sldId id="${slideId}" r:id="${rId}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
${slideIdEntries.join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="custom"/>
  <p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>
</p:presentation>`;
}

function generatePresentationRels(slideCount) {
  const rels = [
    `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    `  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`,
  ];
  for (let i = 0; i < slideCount; i++) {
    const rId = `rId${3 + i}`;
    rels.push(`  <Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
${rels.join("\n")}
</Relationships>`;
}

function generateSlideMaster() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
  <p:cSld>
    <p:bg>
      <p:bgRef idx="1001">
        <a:schemeClr val="bg1"/>
      </p:bgRef>
    </p:bg>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
    <p:sldLayoutId id="2147483650" r:id="rId2"/>
  </p:sldLayoutIdLst>
</p:sldMaster>`;
}

function generateSlideMasterRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function generateSlideLayout(name) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="${name === "title" ? "title" : "obj"}" preserve="1">
  <p:cSld name="${escXml(name)}">
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function generateSlideLayoutRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function generateSlide(shapeTreeContent) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>
      </p:grpSpPr>
      ${shapeTreeContent}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function generateSlideRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>
</Relationships>`;
}

function generateTheme(designSystem) {
  const colors = designSystem?.colors || {};
  const primary = hexColor(colors.primary || "#1a365d");
  const secondary = hexColor(colors.secondary || "#2d3748");
  const accent = hexColor(colors.accent || "#e53e3e");
  const text = hexColor(colors.text || "#1a202c");
  const background = hexColor(colors.background || "#ffffff");

  const headingFont = designSystem?.typography?.heading_family || "Calibri";
  const bodyFont = designSystem?.typography?.body_family || "Cambria";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS_A}" name="Report Theme">
  <a:themeElements>
    <a:clrScheme name="Report Colors">
      <a:dk1><a:srgbClr val="${text}"/></a:dk1>
      <a:lt1><a:srgbClr val="${background}"/></a:lt1>
      <a:dk2><a:srgbClr val="${secondary}"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="${primary}"/></a:accent1>
      <a:accent2><a:srgbClr val="${accent}"/></a:accent2>
      <a:accent3><a:srgbClr val="${secondary}"/></a:accent3>
      <a:accent4><a:srgbClr val="${primary}"/></a:accent4>
      <a:accent5><a:srgbClr val="${accent}"/></a:accent5>
      <a:accent6><a:srgbClr val="${secondary}"/></a:accent6>
      <a:hlink><a:srgbClr val="${primary}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${secondary}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Report Fonts">
      <a:majorFont>
        <a:latin typeface="${escXml(headingFont)}"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="${escXml(bodyFont)}"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
}

// ─── Main export function ─────────────────────────────────────────────────

/**
 * Convert an array of modules to a PPTX package (ZIP buffer).
 *
 * @param {Array<{ type: string, id: string, content: object }>} modules
 * @param {object} designSystem — Design system tokens (colors, typography)
 * @returns {Buffer} — ZIP file buffer (.pptx)
 */
export function convertToPptx(modules, designSystem) {
  const ds = designSystem || {};

  // Generate slide content for each module
  const slides = [];
  for (const mod of modules) {
    const renderer = slideRenderers[mod.type];
    let shapeContent;

    if (renderer) {
      shapeContent = renderer(mod.content || {}, ds);
    } else {
      // Fallback for unknown module types
      const headingFont = ds.typography?.heading_family || "Calibri";
      const textColor = ds.colors?.text || "#1a202c";
      shapeContent = textBox(MARGIN_L, MARGIN_T, CONTENT_W, CONTENT_H, [
        aPara([aRun(`[${mod.type}]`, { size: 24, bold: true, color: textColor, font: headingFont })], { spaceAfter: 8 }),
        aPara([aRun("Module type not supported in PPTX export", { size: 12, color: "#718096" })]),
      ]);
    }

    slides.push(generateSlide(shapeContent));
  }

  // Ensure at least one slide
  if (slides.length === 0) {
    slides.push(generateSlide(textBox(MARGIN_L, MARGIN_T, CONTENT_W, CONTENT_H, [
      aPara([aRun("Empty presentation", { size: 24 })]),
    ])));
  }

  const slideCount = slides.length;
  const zip = new ZipBuilder();

  // Package structure
  zip.addFile("[Content_Types].xml", generateContentTypes(slideCount));
  zip.addFile("_rels/.rels", generateRootRels());

  // Presentation
  zip.addFile("ppt/presentation.xml", generatePresentation(slideCount));
  zip.addFile("ppt/_rels/presentation.xml.rels", generatePresentationRels(slideCount));

  // Slide master + layouts
  zip.addFile("ppt/slideMasters/slideMaster1.xml", generateSlideMaster());
  zip.addFile("ppt/slideMasters/_rels/slideMaster1.xml.rels", generateSlideMasterRels());
  zip.addFile("ppt/slideLayouts/slideLayout1.xml", generateSlideLayout("title"));
  zip.addFile("ppt/slideLayouts/slideLayout2.xml", generateSlideLayout("content"));
  zip.addFile("ppt/slideLayouts/_rels/slideLayout1.xml.rels", generateSlideLayoutRels());
  zip.addFile("ppt/slideLayouts/_rels/slideLayout2.xml.rels", generateSlideLayoutRels());

  // Theme
  zip.addFile("ppt/theme/theme1.xml", generateTheme(ds));

  // Slides
  for (let i = 0; i < slideCount; i++) {
    zip.addFile(`ppt/slides/slide${i + 1}.xml`, slides[i]);
    zip.addFile(`ppt/slides/_rels/slide${i + 1}.xml.rels`, generateSlideRels());
  }

  return zip.build();
}
