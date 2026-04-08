/**
 * Module IDML Converter — XML/JSON → InDesign IDML
 *
 * IDML (InDesign Markup Language) is a ZIP package of XML files.
 * This converter creates a valid .idml file that InDesign can open,
 * mapping report module content to IDML spreads, stories, and styles.
 *
 * Key IDML structure:
 *   mimetype                          — plain text MIME type
 *   designmap.xml                     — master document manifest
 *   Resources/Fonts.xml               — font declarations
 *   Resources/Styles/Root*Group.xml   — paragraph/character styles
 *   Resources/Graphic.xml             — color swatches
 *   Stories/Story_*.xml               — text content
 *   Spreads/Spread_*.xml              — page layouts with frames
 *   MasterSpreads/MasterSpread_*.xml  — master page templates
 */

import { Buffer } from "node:buffer";
import { serializeModuleXml, escXml } from "./module-xml-schema.js";

// ─── ZIP creation ─────────────────────────────────────────────────────────
// Minimal ZIP builder — creates valid ZIP files without external dependencies.
// Uses STORE method (no compression) for maximum compatibility.

class ZipBuilder {
  constructor() {
    this.files = [];
  }

  addFile(path, content, { store = false } = {}) {
    const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    this.files.push({ path, data, store });
  }

  build() {
    const entries = [];
    let offset = 0;

    // Local file headers + data
    const localParts = [];
    for (const file of this.files) {
      const pathBuf = Buffer.from(file.path, "utf-8");
      const crc = crc32(file.data);
      const size = file.data.length;

      // Local file header (30 bytes + path + data)
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);  // signature
      header.writeUInt16LE(20, 4);           // version needed
      header.writeUInt16LE(0, 6);            // flags
      header.writeUInt16LE(0, 8);            // compression: STORE
      header.writeUInt16LE(0, 10);           // mod time
      header.writeUInt16LE(0, 12);           // mod date
      header.writeUInt32LE(crc, 14);         // CRC-32
      header.writeUInt32LE(size, 18);        // compressed size
      header.writeUInt32LE(size, 22);        // uncompressed size
      header.writeUInt16LE(pathBuf.length, 26); // filename length
      header.writeUInt16LE(0, 28);           // extra field length

      entries.push({ offset, pathBuf, crc, size });
      localParts.push(header, pathBuf, file.data);
      offset += 30 + pathBuf.length + size;
    }

    // Central directory
    const centralStart = offset;
    const centralParts = [];
    for (let i = 0; i < this.files.length; i++) {
      const { pathBuf, crc, size, offset: localOffset } = entries[i];
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);   // signature
      cdh.writeUInt16LE(20, 4);            // version made by
      cdh.writeUInt16LE(20, 6);            // version needed
      cdh.writeUInt16LE(0, 8);             // flags
      cdh.writeUInt16LE(0, 10);            // compression
      cdh.writeUInt16LE(0, 12);            // mod time
      cdh.writeUInt16LE(0, 14);            // mod date
      cdh.writeUInt32LE(crc, 16);          // CRC-32
      cdh.writeUInt32LE(size, 20);         // compressed size
      cdh.writeUInt32LE(size, 24);         // uncompressed size
      cdh.writeUInt16LE(pathBuf.length, 28); // filename length
      cdh.writeUInt16LE(0, 30);            // extra field length
      cdh.writeUInt16LE(0, 32);            // comment length
      cdh.writeUInt16LE(0, 34);            // disk number start
      cdh.writeUInt16LE(0, 36);            // internal file attributes
      cdh.writeUInt32LE(0, 38);            // external file attributes
      cdh.writeUInt32LE(localOffset, 42);  // local header offset
      centralParts.push(cdh, pathBuf);
      offset += 46 + pathBuf.length;
    }

    const centralSize = offset - centralStart;

    // End of central directory
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);           // signature
    eocd.writeUInt16LE(0, 4);                     // disk number
    eocd.writeUInt16LE(0, 6);                     // central dir disk
    eocd.writeUInt16LE(this.files.length, 8);     // entries on disk
    eocd.writeUInt16LE(this.files.length, 10);    // total entries
    eocd.writeUInt32LE(centralSize, 12);          // central dir size
    eocd.writeUInt32LE(centralStart, 16);         // central dir offset
    eocd.writeUInt16LE(0, 20);                    // comment length

    return Buffer.concat([...localParts, ...centralParts, eocd]);
  }
}

// CRC-32 lookup table
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

// ─── IDML Helpers ─────────────────────────────────────────────────────────

const IDML_NS = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";

// A4 in IDML points (1pt = 1/72 inch): 595.276 x 841.89
const PAGE_W = 595.276;
const PAGE_H = 841.89;
const MARGIN = 42.52; // ~15mm in points
const CONTENT_W = PAGE_W - 2 * MARGIN;
const CONTENT_H = PAGE_H - 2 * MARGIN;

let _storyCounter = 0;
let _frameCounter = 0;
let _spreadCounter = 0;

function resetCounters() {
  _storyCounter = 0;
  _frameCounter = 0;
  _spreadCounter = 0;
}

function nextStoryId() { return `story_${++_storyCounter}`; }
function nextFrameId() { return `frame_${++_frameCounter}`; }
function nextSpreadId() { return `spread_${++_spreadCounter}`; }

function hexToIdmlColor(hex) {
  if (!hex) return "Color/Black";
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return { r, g, b, name: `Color_${h}` };
}

function colorToIdmlSwatch(color) {
  return `    <Color Self="Color/${color.name}" Model="Process" Space="RGB" ColorValue="${color.r} ${color.g} ${color.b}" />`;
}

// ─── IDML XML Generators ──────────────────────────────────────────────────

function generateDesignmap(spreadIds, storyIds, masterSpreadId) {
  const spreadRefs = spreadIds.map((id) => `  <idPkg:Spread src="Spreads/${id}.xml" />`).join("\n");
  const storyRefs = storyIds.map((id) => `  <idPkg:Story src="Stories/${id}.xml" />`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document DOMVersion="19.0" Self="d"
  xmlns:idPkg="${IDPKG}">
  <Language Self="Language/$ID/Swedish" Name="$ID/Swedish" SingleQuoted="&apos;" DoubleQuoted="&quot;"
    ICULocaleName="sv_SE" />
  <idPkg:Graphic src="Resources/Graphic.xml" />
  <idPkg:Styles src="Resources/Styles/RootParagraphStyleGroup.xml" />
  <idPkg:Styles src="Resources/Styles/RootCharacterStyleGroup.xml" />
  <idPkg:Fonts src="Resources/Fonts.xml" />
  <idPkg:MasterSpread src="MasterSpreads/${masterSpreadId}.xml" />
${spreadRefs}
${storyRefs}
  <Section Self="section_1" PageNumberStart="1" Name="" />
  <DocumentPreference PageWidth="${PAGE_W}" PageHeight="${PAGE_H}"
    FacingPages="false" ColumnCount="1" DocumentBleedTopOffset="0"
    DocumentBleedBottomOffset="0" DocumentBleedInsideOrLeftOffset="0"
    DocumentBleedOutsideOrRightOffset="0" />
  <MarginPreference Top="${MARGIN}" Bottom="${MARGIN}" Left="${MARGIN}" Right="${MARGIN}" ColumnCount="1" ColumnGutter="12" />
</Document>`;
}

function generateFonts(designSystem) {
  const headingFamily = designSystem?.typography?.heading_family || "Helvetica Neue";
  const bodyFamily = designSystem?.typography?.body_family || "Georgia";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Fonts xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <FontFamily Self="FontFamily/${escXml(headingFamily)}" Name="${escXml(headingFamily)}">
    <Font Self="FontFamily/${escXml(headingFamily)}/Regular" FontFamily="${escXml(headingFamily)}" Name="Regular" PostScriptName="${escXml(headingFamily)}-Regular" FontStyleName="Regular" FontType="OpenTypeCFF" WritingScript="0" />
    <Font Self="FontFamily/${escXml(headingFamily)}/Bold" FontFamily="${escXml(headingFamily)}" Name="Bold" PostScriptName="${escXml(headingFamily)}-Bold" FontStyleName="Bold" FontType="OpenTypeCFF" WritingScript="0" />
  </FontFamily>
  <FontFamily Self="FontFamily/${escXml(bodyFamily)}" Name="${escXml(bodyFamily)}">
    <Font Self="FontFamily/${escXml(bodyFamily)}/Regular" FontFamily="${escXml(bodyFamily)}" Name="Regular" PostScriptName="${escXml(bodyFamily)}-Regular" FontStyleName="Regular" FontType="OpenTypeCFF" WritingScript="0" />
    <Font Self="FontFamily/${escXml(bodyFamily)}/Italic" FontFamily="${escXml(bodyFamily)}" Name="Italic" PostScriptName="${escXml(bodyFamily)}-Italic" FontStyleName="Italic" FontType="OpenTypeCFF" WritingScript="0" />
    <Font Self="FontFamily/${escXml(bodyFamily)}/Bold" FontFamily="${escXml(bodyFamily)}" Name="Bold" PostScriptName="${escXml(bodyFamily)}-Bold" FontStyleName="Bold" FontType="OpenTypeCFF" WritingScript="0" />
  </FontFamily>
</idPkg:Fonts>`;
}

function generateGraphic(designSystem) {
  const colors = designSystem?.colors || {};
  const swatches = [];
  const colorMap = {
    primary: colors.primary || "#1a365d",
    secondary: colors.secondary || "#2d3748",
    accent: colors.accent || "#e53e3e",
    text: colors.text || "#1a202c",
    text_light: colors.text_light || "#718096",
    background: colors.background || "#ffffff",
    surface: colors.surface || "#f7fafc",
  };

  for (const [name, hex] of Object.entries(colorMap)) {
    const c = hexToIdmlColor(hex);
    c.name = name;
    swatches.push(colorToIdmlSwatch(c));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Graphic xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <Color Self="Color/Black" Model="Process" Space="RGB" ColorValue="0 0 0" />
  <Color Self="Color/White" Model="Process" Space="RGB" ColorValue="255 255 255" />
${swatches.join("\n")}
  <Swatch Self="Swatch/None" Name="None" />
  <Swatch Self="Swatch/Paper" Name="Paper" />
  <Swatch Self="Swatch/Black" Name="Black" />
  <Swatch Self="Swatch/Registration" Name="Registration" />
</idPkg:Graphic>`;
}

function generateParagraphStyles(designSystem) {
  const typo = designSystem?.typography || {};
  const headingFamily = typo.heading_family || "Helvetica Neue";
  const bodyFamily = typo.body_family || "Georgia";
  const baseSize = typo.base_size_pt || 10;
  const scaleRatio = typo.scale_ratio || 1.25;
  const leading = typo.line_height || 1.5;

  const h1Size = Math.round(baseSize * scaleRatio * scaleRatio * scaleRatio);
  const h2Size = Math.round(baseSize * scaleRatio * scaleRatio);
  const h3Size = Math.round(baseSize * scaleRatio);
  const captionSize = Math.round(baseSize * 0.8);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <RootParagraphStyleGroup Self="RootParagraphStyleGroup">
    <ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Regular" PointSize="${baseSize}"
      AutoLeading="120%" SpaceBefore="0" SpaceAfter="${Math.round(baseSize * 0.5)}"
      Justification="LeftAlign" HyphenateCapitalizedWords="false" />
    <ParagraphStyle Self="ParagraphStyle/Heading1" Name="Heading1"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Bold" PointSize="${h1Size}"
      Leading="${Math.round(h1Size * 1.1)}" SpaceBefore="0" SpaceAfter="${Math.round(h1Size * 0.4)}"
      Justification="LeftAlign" />
    <ParagraphStyle Self="ParagraphStyle/Heading2" Name="Heading2"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Bold" PointSize="${h2Size}"
      Leading="${Math.round(h2Size * 1.15)}" SpaceBefore="${Math.round(h2Size * 0.6)}" SpaceAfter="${Math.round(h2Size * 0.3)}"
      Justification="LeftAlign" />
    <ParagraphStyle Self="ParagraphStyle/Heading3" Name="Heading3"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Bold" PointSize="${h3Size}"
      Leading="${Math.round(h3Size * 1.2)}" SpaceBefore="${Math.round(h3Size * 0.5)}" SpaceAfter="${Math.round(h3Size * 0.25)}"
      Justification="LeftAlign" />
    <ParagraphStyle Self="ParagraphStyle/Body" Name="Body"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Regular" PointSize="${baseSize}"
      Leading="${Math.round(baseSize * leading)}" SpaceBefore="0" SpaceAfter="${Math.round(baseSize * 0.5)}" />
    <ParagraphStyle Self="ParagraphStyle/Caption" Name="Caption"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Italic" PointSize="${captionSize}"
      FillColor="Color/text_light" />
    <ParagraphStyle Self="ParagraphStyle/KpiValue" Name="KpiValue"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Bold" PointSize="${Math.round(h1Size * 1.2)}"
      Leading="${Math.round(h1Size * 1.3)}" Justification="LeftAlign" FillColor="Color/primary" />
    <ParagraphStyle Self="ParagraphStyle/KpiLabel" Name="KpiLabel"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Regular" PointSize="${captionSize}"
      FillColor="Color/text_light" />
    <ParagraphStyle Self="ParagraphStyle/Quote" Name="Quote"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Italic" PointSize="${h3Size}"
      Leading="${Math.round(h3Size * 1.4)}" FillColor="Color/primary" LeftIndent="24" />
    <ParagraphStyle Self="ParagraphStyle/TableHeader" Name="TableHeader"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Bold" PointSize="${baseSize}"
      FillColor="Color/White" />
    <ParagraphStyle Self="ParagraphStyle/TableCell" Name="TableCell"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Regular" PointSize="${baseSize}" />
    <ParagraphStyle Self="ParagraphStyle/TableTotal" Name="TableTotal"
      BasedOn="ParagraphStyle/TableCell"
      AppliedFont="${escXml(bodyFamily)}" FontStyle="Bold" PointSize="${baseSize}" />
    <ParagraphStyle Self="ParagraphStyle/Subtitle" Name="Subtitle"
      BasedOn="ParagraphStyle/$ID/NormalParagraphStyle"
      AppliedFont="${escXml(headingFamily)}" FontStyle="Regular" PointSize="${h3Size}"
      FillColor="Color/text_light" />
  </RootParagraphStyleGroup>
</idPkg:Styles>`;
}

function generateCharacterStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <RootCharacterStyleGroup Self="RootCharacterStyleGroup">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]" />
    <CharacterStyle Self="CharacterStyle/Bold" Name="Bold" FontStyle="Bold" />
    <CharacterStyle Self="CharacterStyle/Italic" Name="Italic" FontStyle="Italic" />
    <CharacterStyle Self="CharacterStyle/BoldItalic" Name="BoldItalic" FontStyle="Bold Italic" />
  </RootCharacterStyleGroup>
</idPkg:Styles>`;
}

function generateMasterSpread(masterSpreadId) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:MasterSpread xmlns:idPkg="${IDPKG}" DOMVersion="19.0"
  Self="${masterSpreadId}" NamePrefix="A" BaseName="Master">
  <Page Self="${masterSpreadId}_page" Name="A-Master"
    AppliedMaster="${masterSpreadId}"
    GeometricBounds="0 0 ${PAGE_H} ${PAGE_W}"
    ItemTransform="1 0 0 1 0 0" />
  <MarginPreference Top="${MARGIN}" Bottom="${MARGIN}" Left="${MARGIN}" Right="${MARGIN}" ColumnCount="1" ColumnGutter="12" />
</idPkg:MasterSpread>`;
}

// ─── Story XML generation ─────────────────────────────────────────────────

function storyXml(storyId, paragraphs) {
  const parasXml = paragraphs.map((p) => {
    const style = p.style || "Body";
    let content = "";

    if (p.runs) {
      // Multiple runs with different character styles
      content = p.runs.map((run) => {
        const charStyle = run.style ? `AppliedCharacterStyle="CharacterStyle/${run.style}"` : 'AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"';
        return `      <CharacterStyleRange ${charStyle}>
        <Content>${escXml(run.text)}</Content>
      </CharacterStyleRange>`;
      }).join("\n");
    } else {
      content = `      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>${escXml(p.text || "")}</Content>
      </CharacterStyleRange>`;
    }

    return `    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/${style}">
${content}
    </ParagraphStyleRange>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <Story Self="${storyId}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="">
${parasXml}
  </Story>
</idPkg:Story>`;
}

function storyXmlWithTable(storyId, headingText, columns, rows, totalRow, captionText) {
  const numCols = columns.length;
  const numRows = rows.length + 1 + (totalRow ? 1 : 0); // +1 for header
  const colWidth = CONTENT_W / numCols;
  const rowHeight = 20;

  let parasXml = "";

  if (headingText) {
    parasXml += `    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Heading2">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>${escXml(headingText)}</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>\n`;
  }

  // Build table XML
  let cellIdx = 0;
  let cellsXml = "";

  // Header row
  for (let c = 0; c < numCols; c++) {
    cellsXml += `      <Cell Self="${storyId}_cell_${cellIdx}" Name="${cellIdx}" RowSpan="1" ColumnSpan="1" CellType="TextTypeCell" AppliedCellStyle="CellStyle/$ID/[None]">
        <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/TableHeader">
          <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
            <Content>${escXml(columns[c].header)}</Content>
          </CharacterStyleRange>
        </ParagraphStyleRange>
      </Cell>\n`;
    cellIdx++;
  }

  // Data rows
  for (const row of rows) {
    for (let c = 0; c < numCols; c++) {
      const val = (row && row[c] != null) ? String(row[c]) : "";
      cellsXml += `      <Cell Self="${storyId}_cell_${cellIdx}" Name="${cellIdx}" RowSpan="1" ColumnSpan="1" CellType="TextTypeCell" AppliedCellStyle="CellStyle/$ID/[None]">
        <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/TableCell">
          <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
            <Content>${escXml(val)}</Content>
          </CharacterStyleRange>
        </ParagraphStyleRange>
      </Cell>\n`;
      cellIdx++;
    }
  }

  // Total row
  if (totalRow) {
    for (let c = 0; c < numCols; c++) {
      const val = (totalRow[c] != null) ? String(totalRow[c]) : "";
      cellsXml += `      <Cell Self="${storyId}_cell_${cellIdx}" Name="${cellIdx}" RowSpan="1" ColumnSpan="1" CellType="TextTypeCell" AppliedCellStyle="CellStyle/$ID/[None]">
        <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/TableTotal">
          <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
            <Content>${escXml(val)}</Content>
          </CharacterStyleRange>
        </ParagraphStyleRange>
      </Cell>\n`;
      cellIdx++;
    }
  }

  // Column definitions
  const colsXml = Array.from({ length: numCols }, (_, i) =>
    `      <Column Self="${storyId}_col_${i}" SingleColumnWidth="${colWidth}" />`
  ).join("\n");

  // Row definitions
  const rowDefs = Array.from({ length: numRows }, (_, i) =>
    `      <Row Self="${storyId}_row_${i}" SingleRowHeight="${rowHeight}" />`
  ).join("\n");

  parasXml += `    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Table Self="${storyId}_table" HeaderRowCount="1" FooterRowCount="0" BodyRowCount="${rows.length + (totalRow ? 1 : 0)}" ColumnCount="${numCols}" AppliedTableStyle="TableStyle/$ID/[Basic Table]" TableDirection="LeftToRightDirection">
${colsXml}
${rowDefs}
${cellsXml}
        </Table>
      </CharacterStyleRange>
    </ParagraphStyleRange>`;

  if (captionText) {
    parasXml += `\n    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Caption">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>${escXml(captionText)}</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="${IDPKG}" DOMVersion="19.0">
  <Story Self="${storyId}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="">
${parasXml}
  </Story>
</idPkg:Story>`;
}

// ─── Spread XML generation ────────────────────────────────────────────────

function textFrame(frameId, storyId, x, y, w, h) {
  const x2 = x + w;
  const y2 = y + h;
  return `    <TextFrame Self="${frameId}" ParentStory="${storyId}"
      ContentType="TextType"
      GeometricBounds="${y} ${x} ${y2} ${x2}"
      ItemTransform="1 0 0 1 0 0"
      TextColumnCount="1">
      <TextFramePreference AutoSizingDimension="HeightOnly" AutoSizingType="HeightOnly" />
    </TextFrame>`;
}

function coloredRect(frameId, x, y, w, h, fillColor) {
  const x2 = x + w;
  const y2 = y + h;
  return `    <Rectangle Self="${frameId}"
      GeometricBounds="${y} ${x} ${y2} ${x2}"
      ItemTransform="1 0 0 1 0 0"
      ContentType="Unassigned"
      FillColor="Color/${fillColor}" StrokeColor="Swatch/None" />`;
}

function spreadXml(spreadId, pageIndex, frames) {
  const framesStr = frames.join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="${IDPKG}" DOMVersion="19.0"
  Self="${spreadId}" PageCount="1" FlattenerOverride="Default">
  <Page Self="${spreadId}_page" Name="${pageIndex}"
    GeometricBounds="0 0 ${PAGE_H} ${PAGE_W}"
    ItemTransform="1 0 0 1 0 0"
    AppliedMaster="MasterSpread_1" />
${framesStr}
</idPkg:Spread>`;
}

// ─── Module → IDML Story/Spread builders ──────────────────────────────────

function textWithMarkdown(text) {
  if (!text) return [{ text: "", style: null }];
  // Split into paragraphs, then runs within each paragraph
  const runs = [];
  let remaining = String(text);

  // Process bold and italic markers into runs
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(remaining)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: remaining.slice(lastIndex, match.index), style: null });
    }
    if (match[1]) {
      runs.push({ text: match[1], style: "Bold" });
    } else if (match[2]) {
      runs.push({ text: match[2], style: "Italic" });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < remaining.length) {
    runs.push({ text: remaining.slice(lastIndex), style: null });
  }
  if (runs.length === 0) runs.push({ text: remaining, style: null });
  return runs;
}

function bodyTextToParagraphs(text, style) {
  if (!text) return [];
  return String(text).split(/\n\n+/).map((p) => {
    const runs = textWithMarkdown(p.trim());
    return { style: style || "Body", runs: runs.map((r) => ({ text: r.text, style: r.style })) };
  });
}

const moduleBuilders = {
  cover(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const bgFrameId = nextFrameId();
    const textFrameId = nextFrameId();

    const paragraphs = [];
    if (content.subtitle) paragraphs.push({ style: "Subtitle", text: content.subtitle });
    if (content.title) paragraphs.push({ style: "Heading1", text: content.title });
    if (content.date) paragraphs.push({ style: "Subtitle", text: content.date });
    if (content.author) paragraphs.push({ style: "Caption", text: content.author });

    const story = storyXml(storyId, paragraphs);
    const frames = [
      coloredRect(bgFrameId, 0, 0, PAGE_W, PAGE_H, "primary"),
      textFrame(textFrameId, storyId, MARGIN, PAGE_H * 0.35, CONTENT_W, PAGE_H * 0.4),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },

  chapter_break(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const bgFrameId = nextFrameId();
    const textFrameId = nextFrameId();

    const paragraphs = [];
    if (content.chapter_number != null) paragraphs.push({ style: "KpiValue", text: String(content.chapter_number) });
    if (content.title) paragraphs.push({ style: "Heading1", text: content.title });
    if (content.subtitle) paragraphs.push({ style: "Subtitle", text: content.subtitle });

    const story = storyXml(storyId, paragraphs);
    const frames = [
      coloredRect(bgFrameId, 0, 0, PAGE_W, PAGE_H, "surface"),
      textFrame(textFrameId, storyId, MARGIN, PAGE_H * 0.35, CONTENT_W, PAGE_H * 0.3),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },

  text_spread(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const mainFrameId = nextFrameId();

    const paragraphs = [];
    if (content.heading) paragraphs.push({ style: "Heading2", text: content.heading });
    paragraphs.push(...bodyTextToParagraphs(content.body));

    const frames = [textFrame(mainFrameId, storyId, MARGIN, MARGIN, CONTENT_W, CONTENT_H)];

    // Add aside/quote as a separate story in a sidebar frame
    let asideStory = null;
    let asideStoryId = null;
    if (content.aside) {
      asideStoryId = nextStoryId();
      const asideFrameId = nextFrameId();
      const asideParas = [];
      if (content.aside.text) asideParas.push({ style: "Quote", text: `\u201C${content.aside.text}\u201D` });
      if (content.aside.attribution) asideParas.push({ style: "Caption", text: `\u2014 ${content.aside.attribution}` });
      asideStory = storyXml(asideStoryId, asideParas);
      // Position aside in right column
      frames.push(textFrame(asideFrameId, asideStoryId, PAGE_W - MARGIN - 150, MARGIN + 80, 130, 200));
      // Narrow main frame to leave room for aside
      frames[0] = textFrame(mainFrameId, storyId, MARGIN, MARGIN, CONTENT_W - 170, CONTENT_H);
    }

    const story = storyXml(storyId, paragraphs);
    const spread = spreadXml(spreadId, 1, frames);

    const result = { storyId, spreadId, story, spread };
    if (asideStory) {
      result.extraStories = [{ id: asideStoryId, xml: asideStory }];
    }
    return result;
  },

  kpi_grid(content, ds) {
    const spreadId = nextSpreadId();
    const kpis = content.kpis || [];
    const stories = [];
    const frames = [];

    // Heading story
    if (content.heading) {
      const hStoryId = nextStoryId();
      stories.push({ id: hStoryId, xml: storyXml(hStoryId, [{ style: "Heading2", text: content.heading }]) });
      frames.push(textFrame(nextFrameId(), hStoryId, MARGIN, MARGIN, CONTENT_W, 30));
    }

    // KPI cards in a grid (2-3 columns)
    const cols = Math.min(kpis.length, 3);
    const cardW = (CONTENT_W - (cols - 1) * 12) / cols;
    const startY = content.heading ? MARGIN + 50 : MARGIN;

    kpis.forEach((kpi, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = MARGIN + col * (cardW + 12);
      const y = startY + row * 100;

      const sId = nextStoryId();
      const paragraphs = [
        { style: "KpiValue", text: `${kpi.value}${kpi.unit ? ` ${kpi.unit}` : ""}` },
        { style: "KpiLabel", text: kpi.label },
      ];
      if (kpi.change) paragraphs.push({ style: "Caption", text: kpi.change });

      stories.push({ id: sId, xml: storyXml(sId, paragraphs) });
      frames.push(textFrame(nextFrameId(), sId, x, y, cardW, 80));
    });

    const spread = spreadXml(spreadId, 1, frames);
    return { spreadId, stories, spread };
  },

  table(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const frameId = nextFrameId();

    const story = storyXmlWithTable(
      storyId,
      content.heading || null,
      content.columns || [],
      content.rows || [],
      content.total_row || null,
      content.caption || null
    );

    const tableHeight = Math.min(CONTENT_H, 20 * ((content.rows?.length || 0) + 2) + (content.heading ? 40 : 0));
    const frames = [textFrame(frameId, storyId, MARGIN, MARGIN, CONTENT_W, tableHeight)];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },

  data_chart(content, ds) {
    // Charts cannot be natively represented in IDML without scripting.
    // We create a placeholder text frame with chart data as a table.
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const frameId = nextFrameId();

    const paragraphs = [];
    if (content.title) paragraphs.push({ style: "Heading2", text: content.title });
    paragraphs.push({ style: "Caption", text: `[Chart placeholder: ${content.chart_type || "bar"} chart]` });

    // Add data as text for reference
    for (const s of content.series || []) {
      paragraphs.push({ style: "Body", text: `${s.label}: ${s.value}` });
    }
    if (content.caption) paragraphs.push({ style: "Caption", text: content.caption });

    const story = storyXml(storyId, paragraphs);
    const frames = [
      coloredRect(nextFrameId(), MARGIN, MARGIN + 40, CONTENT_W, 250, "surface"),
      textFrame(frameId, storyId, MARGIN, MARGIN, CONTENT_W, 300),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },

  quote_callout(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const frameId = nextFrameId();

    const paragraphs = [];
    if (content.quote) paragraphs.push({ style: "Quote", text: `\u201C${content.quote}\u201D` });
    if (content.attribution) {
      const attrText = content.role ? `${content.attribution}, ${content.role}` : content.attribution;
      paragraphs.push({ style: "Caption", text: `\u2014 ${attrText}` });
    }

    const story = storyXml(storyId, paragraphs);
    const frames = [
      coloredRect(nextFrameId(), MARGIN - 10, PAGE_H * 0.3, CONTENT_W + 20, 150, "surface"),
      textFrame(frameId, storyId, MARGIN + 40, PAGE_H * 0.35, CONTENT_W - 80, 100),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },

  image_text(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const textFrameId = nextFrameId();
    const imageFrameId = nextFrameId();
    const imgPlaceholderId = nextStoryId();

    const halfW = (CONTENT_W - 12) / 2;
    const isLeft = content.image_position !== "right";

    const paragraphs = [];
    if (content.heading) paragraphs.push({ style: "Heading2", text: content.heading });
    paragraphs.push(...bodyTextToParagraphs(content.body));

    const imgParagraphs = [{ style: "Caption", text: `[Image: ${content.image_alt || "Placeholder"}]` }];

    const textX = isLeft ? MARGIN + halfW + 12 : MARGIN;
    const imgX = isLeft ? MARGIN : MARGIN + halfW + 12;

    const story = storyXml(storyId, paragraphs);
    const imgStory = storyXml(imgPlaceholderId, imgParagraphs);

    const frames = [
      coloredRect(imageFrameId, imgX, MARGIN, halfW, CONTENT_H * 0.5, "surface"),
      textFrame(nextFrameId(), imgPlaceholderId, imgX + 10, MARGIN + 10, halfW - 20, 30),
      textFrame(textFrameId, storyId, textX, MARGIN, halfW, CONTENT_H * 0.6),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread, extraStories: [{ id: imgPlaceholderId, xml: imgStory }] };
  },

  two_col_text(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();

    const paragraphs = [];
    if (content.heading) paragraphs.push({ style: "Heading2", text: content.heading });
    paragraphs.push(...bodyTextToParagraphs(content.body));

    const story = storyXml(storyId, paragraphs);

    // Use a two-column text frame
    const frameId = nextFrameId();
    const x2 = MARGIN + CONTENT_W;
    const y2 = MARGIN + CONTENT_H;
    const frameXml = `    <TextFrame Self="${frameId}" ParentStory="${storyId}"
      ContentType="TextType"
      GeometricBounds="${MARGIN} ${MARGIN} ${y2} ${x2}"
      ItemTransform="1 0 0 1 0 0"
      TextColumnCount="2" TextColumnGutter="12">
      <TextFramePreference AutoSizingDimension="HeightOnly" AutoSizingType="HeightOnly" TextColumnCount="2" TextColumnGutter="12" />
    </TextFrame>`;

    const spread = spreadXml(spreadId, 1, [frameXml]);
    return { storyId, spreadId, story, spread };
  },

  financial_summary(content, ds) {
    const spreadId = nextSpreadId();
    const stories = [];
    const frames = [];
    let yPos = MARGIN;

    // Heading
    if (content.heading) {
      const hStoryId = nextStoryId();
      stories.push({ id: hStoryId, xml: storyXml(hStoryId, [{ style: "Heading2", text: content.heading }]) });
      frames.push(textFrame(nextFrameId(), hStoryId, MARGIN, yPos, CONTENT_W, 30));
      yPos += 40;
    }

    // Hero numbers
    const heroes = content.hero_numbers || [];
    const heroCols = Math.min(heroes.length, 4);
    const heroW = (CONTENT_W - (heroCols - 1) * 12) / heroCols;

    heroes.forEach((h, i) => {
      const sId = nextStoryId();
      const paragraphs = [
        { style: "KpiValue", text: `${h.value}${h.unit ? ` ${h.unit}` : ""}` },
        { style: "KpiLabel", text: h.label },
      ];
      stories.push({ id: sId, xml: storyXml(sId, paragraphs) });
      frames.push(textFrame(nextFrameId(), sId, MARGIN + i * (heroW + 12), yPos, heroW, 80));
    });
    yPos += 100;

    // Supporting table
    if (content.table?.columns && content.table?.rows) {
      const tStoryId = nextStoryId();
      const tStory = storyXmlWithTable(
        tStoryId, null,
        content.table.columns, content.table.rows,
        content.table.total_row || null, null
      );
      stories.push({ id: tStoryId, xml: tStory });
      const tableH = Math.min(CONTENT_H - yPos + MARGIN, 20 * (content.table.rows.length + 2));
      frames.push(textFrame(nextFrameId(), tStoryId, MARGIN, yPos, CONTENT_W, tableH));
    }

    const spread = spreadXml(spreadId, 1, frames);
    return { spreadId, stories, spread };
  },

  back_cover(content, ds) {
    const storyId = nextStoryId();
    const spreadId = nextSpreadId();
    const bgFrameId = nextFrameId();
    const textFrameId = nextFrameId();

    const paragraphs = [];
    if (content.company_name) paragraphs.push({ style: "Heading2", text: content.company_name });
    if (content.tagline) paragraphs.push({ style: "Subtitle", text: content.tagline });
    const contactParts = [content.address, content.phone, content.email, content.website].filter(Boolean);
    if (contactParts.length) paragraphs.push({ style: "Body", text: contactParts.join("\n") });
    if (content.disclaimer) paragraphs.push({ style: "Caption", text: content.disclaimer });

    const story = storyXml(storyId, paragraphs);
    const frames = [
      coloredRect(bgFrameId, 0, 0, PAGE_W, PAGE_H, "primary"),
      textFrame(textFrameId, storyId, MARGIN + 60, PAGE_H * 0.3, CONTENT_W - 120, PAGE_H * 0.4),
    ];
    const spread = spreadXml(spreadId, 1, frames);

    return { storyId, spreadId, story, spread };
  },
};

// ─── Main export function ─────────────────────────────────────────────────

/**
 * Convert an array of modules to an IDML package (ZIP buffer).
 *
 * @param {Array<{ type: string, id: string, content: object }>} modules
 * @param {object} designSystem — Design system tokens (colors, typography, spacing)
 * @returns {Buffer} — ZIP file buffer (.idml)
 */
export function convertToIdml(modules, designSystem) {
  const ds = designSystem || {};
  resetCounters();

  const zip = new ZipBuilder();

  // mimetype (must be first entry, uncompressed)
  zip.addFile("mimetype", "application/vnd.adobe.indesign-idml-package+xml", { store: true });

  // Resources
  zip.addFile("Resources/Fonts.xml", generateFonts(ds));
  zip.addFile("Resources/Styles/RootParagraphStyleGroup.xml", generateParagraphStyles(ds));
  zip.addFile("Resources/Styles/RootCharacterStyleGroup.xml", generateCharacterStyles());
  zip.addFile("Resources/Graphic.xml", generateGraphic(ds));

  // Master spread
  const masterSpreadId = "MasterSpread_1";
  zip.addFile(`MasterSpreads/${masterSpreadId}.xml`, generateMasterSpread(masterSpreadId));

  // Process each module
  const spreadIds = [];
  const storyIds = [];
  const storyFiles = [];
  const spreadFiles = [];

  let pageIndex = 1;

  for (const mod of modules) {
    const builder = moduleBuilders[mod.type];
    if (!builder) {
      // Fallback: create a placeholder text frame
      const storyId = nextStoryId();
      const spreadId = nextSpreadId();
      const frameId = nextFrameId();
      const story = storyXml(storyId, [
        { style: "Heading2", text: `[${mod.type}]` },
        { style: "Caption", text: "Module type not supported in IDML export" },
      ]);
      const spread = spreadXml(spreadId, pageIndex, [
        textFrame(frameId, storyId, MARGIN, MARGIN, CONTENT_W, 100),
      ]);
      storyIds.push(storyId);
      storyFiles.push({ id: storyId, xml: story });
      spreadIds.push(spreadId);
      spreadFiles.push({ id: spreadId, xml: spread });
      pageIndex++;
      continue;
    }

    const result = builder(mod.content || {}, ds);

    // Handle stories
    if (result.stories) {
      // Multiple stories (e.g., kpi_grid, financial_summary)
      for (const s of result.stories) {
        storyIds.push(s.id);
        storyFiles.push(s);
      }
    } else if (result.storyId && result.story) {
      storyIds.push(result.storyId);
      storyFiles.push({ id: result.storyId, xml: result.story });
    }

    // Handle extra stories (e.g., aside in text_spread)
    if (result.extraStories) {
      for (const s of result.extraStories) {
        storyIds.push(s.id);
        storyFiles.push(s);
      }
    }

    // Handle spread
    if (result.spreadId && result.spread) {
      spreadIds.push(result.spreadId);
      spreadFiles.push({ id: result.spreadId, xml: result.spread });
    }

    pageIndex++;
  }

  // Write story files
  for (const s of storyFiles) {
    zip.addFile(`Stories/${s.id}.xml`, s.xml);
  }

  // Write spread files
  for (const s of spreadFiles) {
    zip.addFile(`Spreads/${s.id}.xml`, s.xml);
  }

  // designmap.xml (must reference all spreads and stories)
  zip.addFile("designmap.xml", generateDesignmap(spreadIds, storyIds, masterSpreadId));

  return zip.build();
}
