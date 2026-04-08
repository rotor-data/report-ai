/**
 * Module DOCX Converter — XML/JSON → Word DOCX
 *
 * DOCX (Office Open XML) is a ZIP package of XML files.
 * This converter creates a valid .docx file that Word can open,
 * mapping report module content to Word paragraphs, tables, and styles.
 *
 * Minimum DOCX structure:
 *   [Content_Types].xml          — content type declarations
 *   _rels/.rels                  — package relationships
 *   word/document.xml            — main document content
 *   word/styles.xml              — paragraph and character styles
 *   word/_rels/document.xml.rels — document relationships
 *   word/theme/theme1.xml        — color theme
 */

import { Buffer } from "node:buffer";
import { escXml } from "./module-xml-schema.js";

// ─── ZIP creation (shared with IDML converter) ───────────────────────────

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

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const THEME_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

// Word units: EMU (English Metric Units), 1 inch = 914400 EMU
// A4: 210mm x 297mm = 11906 x 16838 twips (1 twip = 1/20 pt)
const PAGE_W_TWIPS = 11906;
const PAGE_H_TWIPS = 16838;
const MARGIN_TWIPS = 1134; // ~20mm

// Half-point sizes (Word uses half-points for font sizes)
function ptToHalfPt(pt) { return Math.round(pt * 2); }
// Twips (1/20 pt) for spacing
function ptToTwips(pt) { return Math.round(pt * 20); }

// ─── Hex color conversion ─────────────────────────────────────────────────

function hexToRgb(hex) {
  if (!hex) return "000000";
  return hex.replace("#", "").toUpperCase();
}

// ─── Content Types ────────────────────────────────────────────────────────

function generateContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;
}

// ─── Relationships ────────────────────────────────────────────────────────

function generateRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function generateDocRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;
}

// ─── Settings ─────────────────────────────────────────────────────────────

function generateSettings() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}">
  <w:defaultTabStop w:val="720"/>
  <w:characterSpacingControl w:val="doNotCompress"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
  </w:compat>
</w:settings>`;
}

// ─── Theme ────────────────────────────────────────────────────────────────

function generateTheme(designSystem) {
  const colors = designSystem?.colors || {};
  const primary = hexToRgb(colors.primary || "#1a365d");
  const secondary = hexToRgb(colors.secondary || "#2d3748");
  const accent = hexToRgb(colors.accent || "#e53e3e");
  const text = hexToRgb(colors.text || "#1a202c");
  const background = hexToRgb(colors.background || "#ffffff");

  const headingFont = designSystem?.typography?.heading_family || "Calibri";
  const bodyFont = designSystem?.typography?.body_family || "Cambria";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${THEME_NS}" name="Report Theme">
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

// ─── Styles ───────────────────────────────────────────────────────────────

function generateStyles(designSystem) {
  const typo = designSystem?.typography || {};
  const colors = designSystem?.colors || {};
  const headingFont = typo.heading_family || "Calibri";
  const bodyFont = typo.body_family || "Cambria";
  const baseSize = typo.base_size_pt || 10;
  const scaleRatio = typo.scale_ratio || 1.25;
  const leading = typo.line_height || 1.5;

  const h1Size = Math.round(baseSize * scaleRatio * scaleRatio * scaleRatio);
  const h2Size = Math.round(baseSize * scaleRatio * scaleRatio);
  const h3Size = Math.round(baseSize * scaleRatio);
  const captionSize = Math.round(baseSize * 0.8);

  const primaryColor = hexToRgb(colors.primary || "#1a365d");
  const textColor = hexToRgb(colors.text || "#1a202c");
  const textLightColor = hexToRgb(colors.text_light || "#718096");
  const surfaceColor = hexToRgb(colors.surface || "#f7fafc");

  const bodySpaceAfter = ptToTwips(baseSize * 0.5);
  const bodyLeading = ptToTwips(baseSize * leading);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}" xmlns:r="${R}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${escXml(bodyFont)}" w:hAnsi="${escXml(bodyFont)}" w:eastAsia="${escXml(bodyFont)}" w:cs="${escXml(bodyFont)}"/>
        <w:sz w:val="${ptToHalfPt(baseSize)}"/>
        <w:szCs w:val="${ptToHalfPt(baseSize)}"/>
        <w:color w:val="${textColor}"/>
        <w:lang w:val="sv-SE"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="${bodySpaceAfter}" w:line="${bodyLeading}" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:keepLines/>
      <w:spacing w:before="0" w:after="${ptToTwips(h1Size * 0.4)}" w:line="${ptToTwips(h1Size * 1.1)}" w:lineRule="exact"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${escXml(headingFont)}" w:hAnsi="${escXml(headingFont)}" w:eastAsia="${escXml(headingFont)}" w:cs="${escXml(headingFont)}"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="${ptToHalfPt(h1Size)}"/>
      <w:szCs w:val="${ptToHalfPt(h1Size)}"/>
      <w:color w:val="${textColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:keepLines/>
      <w:spacing w:before="${ptToTwips(h2Size * 0.6)}" w:after="${ptToTwips(h2Size * 0.3)}" w:line="${ptToTwips(h2Size * 1.15)}" w:lineRule="exact"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${escXml(headingFont)}" w:hAnsi="${escXml(headingFont)}" w:eastAsia="${escXml(headingFont)}" w:cs="${escXml(headingFont)}"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="${ptToHalfPt(h2Size)}"/>
      <w:szCs w:val="${ptToHalfPt(h2Size)}"/>
      <w:color w:val="${textColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:keepLines/>
      <w:spacing w:before="${ptToTwips(h3Size * 0.5)}" w:after="${ptToTwips(h3Size * 0.25)}" w:line="${ptToTwips(h3Size * 1.2)}" w:lineRule="exact"/>
      <w:outlineLvl w:val="2"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${escXml(headingFont)}" w:hAnsi="${escXml(headingFont)}" w:eastAsia="${escXml(headingFont)}" w:cs="${escXml(headingFont)}"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="${ptToHalfPt(h3Size)}"/>
      <w:szCs w:val="${ptToHalfPt(h3Size)}"/>
      <w:color w:val="${textColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="0" w:after="${ptToTwips(baseSize)}"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${escXml(headingFont)}" w:hAnsi="${escXml(headingFont)}" w:eastAsia="${escXml(headingFont)}" w:cs="${escXml(headingFont)}"/>
      <w:sz w:val="${ptToHalfPt(h3Size)}"/>
      <w:szCs w:val="${ptToHalfPt(h3Size)}"/>
      <w:color w:val="${textLightColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Caption">
    <w:name w:val="caption"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:i/>
      <w:iCs/>
      <w:sz w:val="${ptToHalfPt(captionSize)}"/>
      <w:szCs w:val="${ptToHalfPt(captionSize)}"/>
      <w:color w:val="${textLightColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="720"/>
      <w:spacing w:before="${ptToTwips(baseSize)}" w:after="${ptToTwips(baseSize)}"/>
    </w:pPr>
    <w:rPr>
      <w:i/>
      <w:iCs/>
      <w:sz w:val="${ptToHalfPt(h3Size)}"/>
      <w:szCs w:val="${ptToHalfPt(h3Size)}"/>
      <w:color w:val="${primaryColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="KpiValue">
    <w:name w:val="KPI Value"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="0" w:after="0"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${escXml(headingFont)}" w:hAnsi="${escXml(headingFont)}" w:eastAsia="${escXml(headingFont)}" w:cs="${escXml(headingFont)}"/>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="${ptToHalfPt(Math.round(h1Size * 1.2))}"/>
      <w:szCs w:val="${ptToHalfPt(Math.round(h1Size * 1.2))}"/>
      <w:color w:val="${primaryColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="KpiLabel">
    <w:name w:val="KPI Label"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:spacing w:before="0" w:after="${ptToTwips(baseSize)}"/>
    </w:pPr>
    <w:rPr>
      <w:sz w:val="${ptToHalfPt(captionSize)}"/>
      <w:szCs w:val="${ptToHalfPt(captionSize)}"/>
      <w:color w:val="${textLightColor}"/>
    </w:rPr>
  </w:style>

  <w:style w:type="character" w:styleId="Bold">
    <w:name w:val="Bold"/>
    <w:rPr><w:b/><w:bCs/></w:rPr>
  </w:style>

  <w:style w:type="character" w:styleId="Italic">
    <w:name w:val="Italic"/>
    <w:rPr><w:i/><w:iCs/></w:rPr>
  </w:style>

  <w:style w:type="table" w:styleId="ReportTable" w:default="1">
    <w:name w:val="Report Table"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="${textLightColor}"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="${textLightColor}"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="40" w:type="dxa"/>
        <w:start w:w="80" w:type="dxa"/>
        <w:bottom w:w="40" w:type="dxa"/>
        <w:end w:w="80" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
    <w:tblStylePr w:type="firstRow">
      <w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF"/></w:rPr>
      <w:tcPr>
        <w:shd w:val="clear" w:color="auto" w:fill="${primaryColor}"/>
      </w:tcPr>
    </w:tblStylePr>
    <w:tblStylePr w:type="lastRow">
      <w:rPr><w:b/><w:bCs/></w:rPr>
      <w:tcPr>
        <w:tcBorders>
          <w:top w:val="single" w:sz="8" w:space="0" w:color="${textColor}"/>
        </w:tcBorders>
      </w:tcPr>
    </w:tblStylePr>
  </w:style>
</w:styles>`;
}

// ─── Document body builders ───────────────────────────────────────────────

function para(styleId, runs) {
  const runsXml = runs.map((r) => {
    let rPr = "";
    if (r.bold) rPr += "<w:b/><w:bCs/>";
    if (r.italic) rPr += "<w:i/><w:iCs/>";
    if (r.color) rPr += `<w:color w:val="${r.color}"/>`;
    if (r.size) rPr += `<w:sz w:val="${ptToHalfPt(r.size)}"/><w:szCs w:val="${ptToHalfPt(r.size)}"/>`;
    const rPrXml = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";
    return `      <w:r>${rPrXml}<w:t xml:space="preserve">${escXml(r.text)}</w:t></w:r>`;
  }).join("\n");

  return `    <w:p>
      <w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>
${runsXml}
    </w:p>`;
}

function textRuns(text) {
  if (!text) return [{ text: "" }];
  const runs = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      runs.push({ text: match[1], bold: true });
    } else if (match[2]) {
      runs.push({ text: match[2], italic: true });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex) });
  }
  if (runs.length === 0) runs.push({ text });
  return runs;
}

function bodyTextToParas(text, styleId) {
  if (!text) return [];
  return String(text).split(/\n\n+/).map((p) => para(styleId || "Normal", textRuns(p.trim())));
}

function pageBreak() {
  return `    <w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

function sectionSeparator() {
  return `    <w:p>
      <w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr>
      <w:r><w:t xml:space="preserve"> </w:t></w:r>
    </w:p>`;
}

function tableXml(columns, rows, totalRow, primaryColor) {
  const numCols = columns.length;
  const colWidth = Math.floor((PAGE_W_TWIPS - 2 * MARGIN_TWIPS) / numCols);

  const gridCols = columns.map(() => `      <w:gridCol w:w="${colWidth}"/>`).join("\n");

  // Header row
  const headerCells = columns.map((col) => {
    const jc = col.align === "right" ? '<w:jc w:val="right"/>' : "";
    return `        <w:tc>
          <w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr><w:pStyle w:val="Normal"/>${jc}<w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF"/></w:rPr></w:pPr>
            <w:r><w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${escXml(col.header)}</w:t></w:r>
          </w:p>
        </w:tc>`;
  }).join("\n");

  // Data rows
  const dataRows = (rows || []).map((row) => {
    const cells = columns.map((col, i) => {
      const val = (row && row[i] != null) ? String(row[i]) : "";
      const jc = col.align === "right" ? '<w:jc w:val="right"/>' : "";
      return `        <w:tc>
          <w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>
          <w:p><w:pPr>${jc}</w:pPr><w:r><w:t xml:space="preserve">${escXml(val)}</w:t></w:r></w:p>
        </w:tc>`;
    }).join("\n");
    return `      <w:tr>\n${cells}\n      </w:tr>`;
  }).join("\n");

  // Total row
  let totalRowXml = "";
  if (totalRow) {
    const totalCells = columns.map((col, i) => {
      const val = (totalRow[i] != null) ? String(totalRow[i]) : "";
      const jc = col.align === "right" ? '<w:jc w:val="right"/>' : "";
      return `        <w:tc>
          <w:tcPr>
            <w:tcW w:w="${colWidth}" w:type="dxa"/>
            <w:tcBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/></w:tcBorders>
          </w:tcPr>
          <w:p><w:pPr>${jc}<w:rPr><w:b/><w:bCs/></w:rPr></w:pPr>
            <w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">${escXml(val)}</w:t></w:r>
          </w:p>
        </w:tc>`;
    }).join("\n");
    totalRowXml = `\n      <w:tr>\n${totalCells}\n      </w:tr>`;
  }

  return `    <w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="ReportTable"/>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="${totalRow ? "1" : "0"}" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>
      </w:tblPr>
      <w:tblGrid>
${gridCols}
      </w:tblGrid>
      <w:tr>
${headerCells}
      </w:tr>
${dataRows}${totalRowXml}
    </w:tbl>`;
}

// ─── Module → DOCX paragraph builders ─────────────────────────────────────

const moduleRenderers = {
  cover(content, ds) {
    const parts = [];
    // Add some spacing to push content down
    parts.push(para("Normal", [{ text: " " }]));
    parts.push(para("Normal", [{ text: " " }]));
    parts.push(para("Normal", [{ text: " " }]));
    if (content.subtitle) parts.push(para("Subtitle", [{ text: content.subtitle }]));
    if (content.title) parts.push(para("Heading1", [{ text: content.title }]));
    if (content.date) parts.push(para("Subtitle", [{ text: content.date }]));
    if (content.author) parts.push(para("Caption", [{ text: content.author }]));
    parts.push(pageBreak());
    return parts.join("\n");
  },

  chapter_break(content, ds) {
    const parts = [];
    parts.push(para("Normal", [{ text: " " }]));
    if (content.chapter_number != null) parts.push(para("KpiValue", [{ text: String(content.chapter_number) }]));
    if (content.title) parts.push(para("Heading1", [{ text: content.title }]));
    if (content.subtitle) parts.push(para("Subtitle", [{ text: content.subtitle }]));
    parts.push(pageBreak());
    return parts.join("\n");
  },

  text_spread(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));
    parts.push(...bodyTextToParas(content.body));
    if (content.aside) {
      parts.push(sectionSeparator());
      if (content.aside.text) parts.push(para("Quote", [{ text: `\u201C${content.aside.text}\u201D` }]));
      if (content.aside.attribution) parts.push(para("Caption", [{ text: `\u2014 ${content.aside.attribution}` }]));
    }
    return parts.join("\n");
  },

  kpi_grid(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));

    // Render KPIs as a simple table
    const kpis = content.kpis || [];
    if (kpis.length > 0) {
      const columns = kpis.map((k) => ({ header: k.label, align: "left" }));
      const valueRow = kpis.map((k) => `${k.value}${k.unit ? ` ${k.unit}` : ""}`);
      const changeRow = kpis.some((k) => k.change) ? kpis.map((k) => k.change || "") : null;

      const rows = [valueRow];
      if (changeRow) rows.push(changeRow);

      parts.push(tableXml(columns, rows, null, hexToRgb(ds?.colors?.primary || "#1a365d")));
    }
    return parts.join("\n");
  },

  table(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));
    if (content.columns && content.rows) {
      parts.push(tableXml(
        content.columns, content.rows, content.total_row || null,
        hexToRgb(ds?.colors?.primary || "#1a365d")
      ));
    }
    if (content.caption) parts.push(para("Caption", [{ text: content.caption }]));
    return parts.join("\n");
  },

  data_chart(content, ds) {
    const parts = [];
    if (content.title) parts.push(para("Heading2", [{ text: content.title }]));
    // Charts as a data table since Word XML chart embedding is extremely complex
    const series = content.series || [];
    if (series.length > 0) {
      const columns = [
        { header: "Label", align: "left" },
        { header: "Value", align: "right" },
      ];
      const rows = series.map((s) => [s.label, String(s.value)]);
      parts.push(tableXml(columns, rows, null, hexToRgb(ds?.colors?.primary || "#1a365d")));
    }
    parts.push(para("Caption", [{ text: `[${content.chart_type || "bar"} chart \u2014 render as chart in Word]` }]));
    if (content.caption) parts.push(para("Caption", [{ text: content.caption }]));
    return parts.join("\n");
  },

  quote_callout(content, ds) {
    const parts = [];
    if (content.quote) parts.push(para("Quote", [{ text: `\u201C${content.quote}\u201D` }]));
    if (content.attribution) {
      const attrText = content.role ? `${content.attribution}, ${content.role}` : content.attribution;
      parts.push(para("Caption", [{ text: `\u2014 ${attrText}` }]));
    }
    return parts.join("\n");
  },

  image_text(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));
    parts.push(para("Caption", [{ text: `[Image placeholder: ${content.image_alt || "Image"}]` }]));
    parts.push(...bodyTextToParas(content.body));
    return parts.join("\n");
  },

  two_col_text(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));
    // Word column sections require section properties — add as normal text with a note
    parts.push(...bodyTextToParas(content.body));
    return parts.join("\n");
  },

  financial_summary(content, ds) {
    const parts = [];
    if (content.heading) parts.push(para("Heading2", [{ text: content.heading }]));

    // Hero numbers as styled paragraphs
    for (const h of content.hero_numbers || []) {
      parts.push(para("KpiValue", [{ text: `${h.value}${h.unit ? ` ${h.unit}` : ""}` }]));
      parts.push(para("KpiLabel", [{ text: h.label }]));
    }

    // Supporting table
    if (content.table?.columns && content.table?.rows) {
      parts.push(sectionSeparator());
      parts.push(tableXml(
        content.table.columns, content.table.rows, content.table.total_row || null,
        hexToRgb(ds?.colors?.primary || "#1a365d")
      ));
    }
    return parts.join("\n");
  },

  back_cover(content, ds) {
    const parts = [];
    parts.push(pageBreak());
    parts.push(para("Normal", [{ text: " " }]));
    parts.push(para("Normal", [{ text: " " }]));
    if (content.company_name) parts.push(para("Heading2", [{ text: content.company_name }]));
    if (content.tagline) parts.push(para("Subtitle", [{ text: content.tagline }]));
    const contactParts = [content.address, content.phone, content.email, content.website].filter(Boolean);
    for (const line of contactParts) {
      parts.push(para("Normal", [{ text: line }]));
    }
    if (content.disclaimer) parts.push(para("Caption", [{ text: content.disclaimer }]));
    return parts.join("\n");
  },
};

// ─── Document XML assembly ────────────────────────────────────────────────

function generateDocumentXml(modules, designSystem) {
  const ds = designSystem || {};
  const bodyParts = [];

  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    const renderer = moduleRenderers[mod.type];

    if (renderer) {
      bodyParts.push(renderer(mod.content || {}, ds));
    } else {
      // Fallback for unknown module types
      bodyParts.push(para("Heading2", [{ text: `[${mod.type}]` }]));
      bodyParts.push(para("Caption", [{ text: "Module type not supported in DOCX export" }]));
    }

    // Add spacing between modules (except after page-breaking ones)
    const pageBreakers = new Set(["cover", "chapter_break"]);
    if (i < modules.length - 1 && !pageBreakers.has(mod.type) && mod.type !== "back_cover") {
      bodyParts.push(sectionSeparator());
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}">
  <w:body>
${bodyParts.join("\n")}
    <w:sectPr>
      <w:pgSz w:w="${PAGE_W_TWIPS}" w:h="${PAGE_H_TWIPS}"/>
      <w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/>
      <w:cols w:space="708"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

// ─── Main export function ─────────────────────────────────────────────────

/**
 * Convert an array of modules to a DOCX package (ZIP buffer).
 *
 * @param {Array<{ type: string, id: string, content: object }>} modules
 * @param {object} designSystem — Design system tokens (colors, typography, spacing)
 * @returns {Buffer} — ZIP file buffer (.docx)
 */
export function convertToDocx(modules, designSystem) {
  const ds = designSystem || {};
  const zip = new ZipBuilder();

  zip.addFile("[Content_Types].xml", generateContentTypes());
  zip.addFile("_rels/.rels", generateRootRels());
  zip.addFile("word/_rels/document.xml.rels", generateDocRels());
  zip.addFile("word/document.xml", generateDocumentXml(modules, ds));
  zip.addFile("word/styles.xml", generateStyles(ds));
  zip.addFile("word/theme/theme1.xml", generateTheme(ds));
  zip.addFile("word/settings.xml", generateSettings());

  return zip.build();
}
