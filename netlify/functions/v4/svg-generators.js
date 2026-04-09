/**
 * V4 Pipeline — SVG chart generators.
 * Pure functions: (data, colors) => svgString
 *
 * Follows the moodboard SVG pattern from mcp.js:1085-1130:
 *   viewBox-based, CSS custom properties via template strings, print-safe.
 *
 * colors = design_system.colors: { primary, secondary, accent, text, text_light, bg, bg_alt, surface }
 */

// ── Shared helpers ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Generate "nice" axis ticks for a range */
function niceScale(min, max, maxTicks = 5) {
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const roughStep = range / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / mag;
  let niceStep;
  if (residual <= 1.5) niceStep = 1 * mag;
  else if (residual <= 3) niceStep = 2 * mag;
  else if (residual <= 7) niceStep = 5 * mag;
  else niceStep = 10 * mag;

  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + niceStep * 0.5; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { min: niceMin, max: niceMax, step: niceStep, ticks };
}

/** Format number for axis labels (Swedish locale) */
function fmtNum(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + " M";
  if (Math.abs(n) >= 1e3) return new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 }).format(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1).replace(".", ",");
}

/** Color palette from design tokens */
function palette(colors) {
  return [
    colors.primary || "#1A2B5C",
    colors.secondary || "#4A7C9E",
    colors.accent || "#E8A838",
    colors.text_light || "#666666",
    colors.surface || "#E8E4DE",
    colors.bg_alt || "#F5F5F0",
  ];
}

const FONT = "system-ui, sans-serif";

// ── Bar Chart (with optional line overlay — bar_chart__bar_line_dual) ──────

export function generateBarChart(data, colors) {
  const c = colors || {};
  const pal = palette(c);
  const cats = data.categories || [];
  const series = data.series || [];
  if (!cats.length || !series.length) {
    return `<svg viewBox="0 0 500 300" xmlns="http://www.w3.org/2000/svg"><text x="250" y="150" text-anchor="middle" font-size="12" fill="${c.text_light || "#666"}" font-family="${FONT}">Ingen data</text></svg>`;
  }

  const W = 500, H = 300;
  const pad = { top: 30, right: 20, bottom: 50, left: 60 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  // Separate bar and line series
  const barSeries = series.filter((s) => (s.type || "bar") === "bar");
  const lineSeries = series.filter((s) => s.type === "line");

  // Find value range across all series
  const allVals = series.flatMap((s) => s.values || []).filter(Number.isFinite);
  const dataMin = Math.min(0, ...allVals);
  const dataMax = Math.max(...allVals);
  const scale = niceScale(dataMin, dataMax);

  const yScale = (v) => pad.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const catWidth = plotW / cats.length;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:240px;">`;

  // Title
  if (data.title) {
    svg += `<text x="${pad.left}" y="18" font-size="12" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.title)}</text>`;
  }

  // Grid lines + Y axis labels
  for (const tick of scale.ticks) {
    const y = yScale(tick);
    svg += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="${c.surface || "#E8E4DE"}" stroke-width="${tick === 0 ? 1 : 0.5}" ${tick !== 0 ? 'stroke-dasharray="4,4"' : ""}/>`;
    svg += `<text x="${pad.left - 6}" y="${y + 3}" text-anchor="end" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">${fmtNum(tick)}${data.y_unit ? " " + esc(data.y_unit) : ""}</text>`;
  }

  // Bars
  const barCount = barSeries.length || 1;
  const barGroupWidth = catWidth * 0.7;
  const barW = barGroupWidth / barCount;
  const barOffset = (catWidth - barGroupWidth) / 2;

  barSeries.forEach((s, si) => {
    const color = pal[si % pal.length];
    cats.forEach((cat, ci) => {
      const val = s.values[ci] ?? 0;
      const x = pad.left + ci * catWidth + barOffset + si * barW;
      const yTop = yScale(val);
      const yBase = yScale(0);
      const h = Math.abs(yBase - yTop);
      const yStart = val >= 0 ? yTop : yBase;
      svg += `<rect x="${x}" y="${yStart}" width="${barW - 1}" height="${h}" fill="${color}" rx="1"/>`;
      if (data.show_values !== false) {
        svg += `<text x="${x + barW / 2}" y="${yStart - 3}" text-anchor="middle" font-size="7" font-weight="600" fill="${c.text || "#1A1A1A"}" font-family="${FONT}">${fmtNum(val)}</text>`;
      }
    });
  });

  // Line overlays
  lineSeries.forEach((s, si) => {
    const color = pal[(barSeries.length + si) % pal.length];
    const points = cats.map((_, ci) => {
      const x = pad.left + ci * catWidth + catWidth / 2;
      const y = yScale(s.values[ci] ?? 0);
      return `${x},${y}`;
    }).join(" ");
    svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    cats.forEach((_, ci) => {
      const x = pad.left + ci * catWidth + catWidth / 2;
      const y = yScale(s.values[ci] ?? 0);
      svg += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
    });
  });

  // X axis labels
  cats.forEach((cat, ci) => {
    const x = pad.left + ci * catWidth + catWidth / 2;
    svg += `<text x="${x}" y="${H - pad.bottom + 16}" text-anchor="middle" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(cat)}</text>`;
  });

  // Legend
  if (data.show_legend !== false && series.length > 1) {
    let lx = pad.left;
    const ly = H - 8;
    series.forEach((s, si) => {
      const color = pal[si % pal.length];
      if ((s.type || "bar") === "bar") {
        svg += `<rect x="${lx}" y="${ly - 6}" width="12" height="8" fill="${color}" rx="1"/>`;
      } else {
        svg += `<line x1="${lx}" y1="${ly - 2}" x2="${lx + 12}" y2="${ly - 2}" stroke="${color}" stroke-width="2"/>`;
      }
      svg += `<text x="${lx + 16}" y="${ly + 2}" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(s.name)}</text>`;
      lx += 16 + (s.name || "").length * 5 + 12;
    });
  }

  svg += "</svg>";
  return svg;
}

// ── Donut Chart ────────────────────────────────────────────────────────────

export function generateDonutChart(data, colors) {
  const c = colors || {};
  const pal = palette(c);
  const segments = data.segments || [];
  if (!segments.length) {
    return `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><text x="150" y="150" text-anchor="middle" font-size="12" fill="${c.text_light || "#666"}" font-family="${FONT}">Ingen data</text></svg>`;
  }

  const W = 300, H = 300;
  const cx = 150, cy = 140;
  const outerR = 100, innerR = 55;
  const total = segments.reduce((sum, s) => sum + (s.value || 0), 0);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:260px;">`;

  if (data.title) {
    svg += `<text x="${cx}" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.title)}</text>`;
  }

  let angle = -Math.PI / 2;
  segments.forEach((seg, i) => {
    const pct = total > 0 ? seg.value / total : 0;
    const sweep = pct * 2 * Math.PI;
    const startAngle = angle;
    const endAngle = angle + sweep;

    const x1o = cx + outerR * Math.cos(startAngle);
    const y1o = cy + outerR * Math.sin(startAngle);
    const x2o = cx + outerR * Math.cos(endAngle);
    const y2o = cy + outerR * Math.sin(endAngle);
    const x1i = cx + innerR * Math.cos(endAngle);
    const y1i = cy + innerR * Math.sin(endAngle);
    const x2i = cx + innerR * Math.cos(startAngle);
    const y2i = cy + innerR * Math.sin(startAngle);

    const largeArc = sweep > Math.PI ? 1 : 0;
    const segColor = seg.color_override || pal[i % pal.length];

    svg += `<path d="M ${x1o} ${y1o} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o} L ${x1i} ${y1i} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i} ${y2i} Z" fill="${segColor}"/>`;

    // Percentage label on arc midpoint
    if (data.show_percentages !== false && pct > 0.04) {
      const midAngle = startAngle + sweep / 2;
      const labelR = (outerR + innerR) / 2;
      const lx = cx + labelR * Math.cos(midAngle);
      const ly = cy + labelR * Math.sin(midAngle);
      svg += `<text x="${lx}" y="${ly + 3}" text-anchor="middle" font-size="8" font-weight="600" fill="white" font-family="${FONT}">${Math.round(pct * 100)}%</text>`;
    }

    angle = endAngle;
  });

  // Center label
  if (data.inner_label) {
    svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.inner_label)}</text>`;
  }

  // Legend below
  if (data.show_legend !== false) {
    const cols = Math.min(segments.length, 3);
    const colW = W / cols;
    segments.forEach((seg, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const lx = col * colW + 10;
      const ly = 260 + row * 14;
      const segColor = seg.color_override || pal[i % pal.length];
      svg += `<rect x="${lx}" y="${ly - 7}" width="8" height="8" fill="${segColor}" rx="1"/>`;
      svg += `<text x="${lx + 12}" y="${ly}" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(seg.label)}</text>`;
    });
  }

  svg += "</svg>";
  return svg;
}

// ── Map Bubble ─────────────────────────────────────────────────────────────

// Simplified Sweden map outline as SVG path
const SWEDEN_PATH = "M 230 20 C 225 25 220 30 218 40 C 215 55 220 65 225 75 C 228 82 230 90 228 100 C 225 115 218 125 215 140 C 212 155 215 165 218 175 C 220 182 222 190 220 200 C 218 215 210 225 205 240 C 200 255 195 265 192 275 C 190 280 188 285 185 288 C 180 292 175 290 172 285 C 168 278 170 270 175 262 C 178 255 180 248 178 240 C 175 228 168 220 165 210 C 162 200 165 190 170 182 C 175 175 180 168 182 158 C 185 145 180 135 175 125 C 170 115 168 105 172 95 C 175 88 180 82 182 75 C 185 65 182 55 178 48 C 175 42 180 35 188 30 C 195 25 205 22 215 20 Z";

export function generateMapBubble(data, colors) {
  const c = colors || {};
  const pal = palette(c);
  const bubbles = data.bubbles || [];

  const W = 400, H = 350;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:300px;">`;

  if (data.title) {
    svg += `<text x="20" y="20" font-size="12" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.title)}</text>`;
  }

  // Map outline
  svg += `<path d="${SWEDEN_PATH}" fill="${c.bg_alt || "#F5F5F0"}" stroke="${c.surface || "#E8E4DE"}" stroke-width="1.5" transform="translate(70, 20) scale(0.9)"/>`;

  if (!bubbles.length) {
    svg += "</svg>";
    return svg;
  }

  // Convert lat/lon to approximate SVG coordinates (Sweden: lat ~55-69, lon ~11-24)
  const maxVal = Math.max(...bubbles.map((b) => b.value || 0));
  const minBubble = 8, maxBubble = 35;

  bubbles.forEach((b, i) => {
    // Map Sweden lat/lon to SVG coords
    const lonNorm = ((b.lon || 15) - 11) / 13;    // 0..1 across Sweden
    const latNorm = 1 - ((b.lat || 60) - 55) / 14; // 0..1 top to bottom
    const x = 100 + lonNorm * 200;
    const y = 30 + latNorm * 280;
    const r = maxVal > 0
      ? minBubble + ((b.value || 0) / maxVal) * (maxBubble - minBubble)
      : minBubble;

    const roleColor = b.color_role === "second" ? pal[1]
      : b.color_role === "smaller" ? pal[2]
      : pal[0];

    svg += `<circle cx="${x}" cy="${y}" r="${r}" fill="${roleColor}" opacity="0.7" stroke="white" stroke-width="1.5"/>`;
    svg += `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="7" font-weight="600" fill="white" font-family="${FONT}">${fmtNum(b.value || 0)}</text>`;
    svg += `<text x="${x}" y="${y + r + 12}" text-anchor="middle" font-size="7" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(b.name)}</text>`;
  });

  // Legend
  if (data.show_legend !== false) {
    let lx = W - 120;
    const roles = [
      { label: "Dominant", color: pal[0] },
      { label: "Sekundär", color: pal[1] },
      { label: "Mindre", color: pal[2] },
    ];
    roles.forEach((r, i) => {
      const ly = 30 + i * 16;
      svg += `<circle cx="${lx + 5}" cy="${ly}" r="5" fill="${r.color}" opacity="0.7"/>`;
      svg += `<text x="${lx + 14}" y="${ly + 3}" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(r.label)}</text>`;
    });
  }

  svg += "</svg>";
  return svg;
}

// ── Stock Chart (price + volume) ───────────────────────────────────────────

export function generateStockChart(data, colors) {
  const c = colors || {};
  const entries = data.data || [];
  if (!entries.length) {
    return `<svg viewBox="0 0 500 300" xmlns="http://www.w3.org/2000/svg"><text x="250" y="150" text-anchor="middle" font-size="12" fill="${c.text_light || "#666"}" font-family="${FONT}">Ingen data</text></svg>`;
  }

  const W = 500, H = 300;
  const pad = { top: 30, right: 20, bottom: 40, left: 55 };
  const priceH = data.show_volume !== false ? 180 : H - pad.top - pad.bottom;
  const volH = data.show_volume !== false ? 50 : 0;
  const volTop = pad.top + priceH + 10;

  const prices = entries.map((e) => e.price).filter(Number.isFinite);
  const priceScale = niceScale(Math.min(...prices) * 0.95, Math.max(...prices) * 1.05);

  const xStep = (W - pad.left - pad.right) / Math.max(entries.length - 1, 1);
  const priceY = (v) => pad.top + priceH - ((v - priceScale.min) / (priceScale.max - priceScale.min)) * priceH;
  const xPos = (i) => pad.left + i * xStep;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:260px;">`;

  if (data.title) {
    svg += `<text x="${pad.left}" y="18" font-size="12" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.title)}</text>`;
  }

  // Price grid
  for (const tick of priceScale.ticks) {
    const y = priceY(tick);
    svg += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="${c.surface || "#E8E4DE"}" stroke-width="0.5" stroke-dasharray="4,4"/>`;
    svg += `<text x="${pad.left - 6}" y="${y + 3}" text-anchor="end" font-size="7" fill="${c.text_light || "#666"}" font-family="${FONT}">${fmtNum(tick)}</text>`;
  }

  // Price line
  const pricePoints = entries.map((e, i) => `${xPos(i)},${priceY(e.price)}`).join(" ");
  // Area fill
  svg += `<polygon points="${xPos(0)},${priceY(entries[0].price)} ${pricePoints} ${xPos(entries.length - 1)},${pad.top + priceH} ${xPos(0)},${pad.top + priceH}" fill="${c.primary || "#1A2B5C"}" opacity="0.06"/>`;
  svg += `<polyline points="${pricePoints}" fill="none" stroke="${c.primary || "#1A2B5C"}" stroke-width="2" stroke-linejoin="round"/>`;

  // Moving average
  if (data.show_moving_avg && entries.length > (data.moving_avg_period || 20)) {
    const period = data.moving_avg_period || 20;
    const maPoints = [];
    for (let i = period - 1; i < entries.length; i++) {
      const slice = entries.slice(i - period + 1, i + 1);
      const avg = slice.reduce((s, e) => s + e.price, 0) / period;
      maPoints.push(`${xPos(i)},${priceY(avg)}`);
    }
    svg += `<polyline points="${maPoints.join(" ")}" fill="none" stroke="${c.secondary || "#4A7C9E"}" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  }

  // Last price highlight
  const lastIdx = entries.length - 1;
  svg += `<circle cx="${xPos(lastIdx)}" cy="${priceY(entries[lastIdx].price)}" r="4" fill="${c.accent || "#E8A838"}"/>`;
  svg += `<text x="${xPos(lastIdx)}" y="${priceY(entries[lastIdx].price) - 7}" text-anchor="middle" font-size="8" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${fmtNum(entries[lastIdx].price)}</text>`;

  // Volume bars
  if (data.show_volume !== false && volH > 0) {
    const volumes = entries.map((e) => e.volume || 0);
    const maxVol = Math.max(...volumes, 1);
    const barW = Math.max(xStep * 0.6, 1);

    entries.forEach((e, i) => {
      const vol = e.volume || 0;
      const h = (vol / maxVol) * volH;
      const x = xPos(i) - barW / 2;
      svg += `<rect x="${x}" y="${volTop + volH - h}" width="${barW}" height="${h}" fill="${c.secondary || "#4A7C9E"}" opacity="0.4"/>`;
    });
  }

  // X axis: show ~6 date labels
  const labelInterval = Math.max(1, Math.floor(entries.length / 6));
  entries.forEach((e, i) => {
    if (i % labelInterval === 0 || i === lastIdx) {
      const label = e.date?.slice(0, 7) || "";  // YYYY-MM
      svg += `<text x="${xPos(i)}" y="${H - 5}" text-anchor="middle" font-size="7" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(label)}</text>`;
    }
  });

  svg += "</svg>";
  return svg;
}

// ── NAV vs Price chart ─────────────────────────────────────────────────────

export function generateNavVsPrice(data, colors) {
  const c = colors || {};
  const entries = data.data || [];
  if (!entries.length) {
    return `<svg viewBox="0 0 500 260" xmlns="http://www.w3.org/2000/svg"><text x="250" y="130" text-anchor="middle" font-size="12" fill="${c.text_light || "#666"}" font-family="${FONT}">Ingen data</text></svg>`;
  }

  const W = 500, H = 260;
  const pad = { top: 30, right: 20, bottom: 40, left: 55 };
  const plotH = H - pad.top - pad.bottom;

  const allVals = entries.flatMap((e) => [e.nav_per_share, e.price]).filter(Number.isFinite);
  const scale = niceScale(Math.min(...allVals) * 0.95, Math.max(...allVals) * 1.05);

  const xStep = (W - pad.left - pad.right) / Math.max(entries.length - 1, 1);
  const yPos = (v) => pad.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const xPos = (i) => pad.left + i * xStep;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-height:220px;">`;

  if (data.title) {
    svg += `<text x="${pad.left}" y="18" font-size="12" font-weight="700" fill="${c.primary || "#1A2B5C"}" font-family="${FONT}">${esc(data.title)}</text>`;
  }

  // Grid
  for (const tick of scale.ticks) {
    const y = yPos(tick);
    svg += `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="${c.surface || "#E8E4DE"}" stroke-width="0.5" stroke-dasharray="4,4"/>`;
    svg += `<text x="${pad.left - 6}" y="${y + 3}" text-anchor="end" font-size="7" fill="${c.text_light || "#666"}" font-family="${FONT}">${fmtNum(tick)}</text>`;
  }

  // NAV line
  const navPoints = entries.map((e, i) => `${xPos(i)},${yPos(e.nav_per_share)}`).join(" ");
  svg += `<polyline points="${navPoints}" fill="none" stroke="${c.primary || "#1A2B5C"}" stroke-width="2.5" stroke-linejoin="round"/>`;

  // Price line
  const pricePoints = entries.map((e, i) => `${xPos(i)},${yPos(e.price)}`).join(" ");
  svg += `<polyline points="${pricePoints}" fill="none" stroke="${c.secondary || "#4A7C9E"}" stroke-width="1.5" stroke-dasharray="6,3" stroke-linejoin="round"/>`;

  // Discount/premium fill between lines
  for (let i = 0; i < entries.length - 1; i++) {
    const e1 = entries[i], e2 = entries[i + 1];
    const discount = e1.price < e1.nav_per_share;
    const fillColor = discount ? c.accent || "#E8A838" : c.secondary || "#4A7C9E";
    svg += `<polygon points="${xPos(i)},${yPos(e1.nav_per_share)} ${xPos(i + 1)},${yPos(e2.nav_per_share)} ${xPos(i + 1)},${yPos(e2.price)} ${xPos(i)},${yPos(e1.price)}" fill="${fillColor}" opacity="0.08"/>`;
  }

  // X axis labels
  const labelInterval = Math.max(1, Math.floor(entries.length / 6));
  entries.forEach((e, i) => {
    if (i % labelInterval === 0 || i === entries.length - 1) {
      const label = e.date?.slice(0, 7) || "";
      svg += `<text x="${xPos(i)}" y="${H - 8}" text-anchor="middle" font-size="7" fill="${c.text_light || "#666"}" font-family="${FONT}">${esc(label)}</text>`;
    }
  });

  // Legend
  const ly = H - 5;
  svg += `<line x1="${pad.left}" y1="${ly}" x2="${pad.left + 15}" y2="${ly}" stroke="${c.primary || "#1A2B5C"}" stroke-width="2.5"/>`;
  svg += `<text x="${pad.left + 20}" y="${ly + 3}" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">NAV/aktie</text>`;
  svg += `<line x1="${pad.left + 90}" y1="${ly}" x2="${pad.left + 105}" y2="${ly}" stroke="${c.secondary || "#4A7C9E"}" stroke-width="1.5" stroke-dasharray="4,2"/>`;
  svg += `<text x="${pad.left + 110}" y="${ly + 3}" font-size="8" fill="${c.text_light || "#666"}" font-family="${FONT}">Aktiekurs</text>`;

  svg += "</svg>";
  return svg;
}

// ── Export map for dynamic lookup ──────────────────────────────────────────

export const SVG_GENERATORS = {
  bar_chart: generateBarChart,
  bar_chart__bar_line_dual: generateBarChart,
  donut_chart: generateDonutChart,
  map_bubble: generateMapBubble,
  stock_chart: generateStockChart,
  stock_chart__price_volume: generateStockChart,
  nav_vs_price: generateNavVsPrice,
  stock_chart__nav_vs_price: generateNavVsPrice,
};

/**
 * Generate an SVG chart by type.
 * @param {string} chartType - e.g. "bar_chart", "donut_chart"
 * @param {object} data - chart-specific data
 * @param {object} colors - design_system.colors
 * @returns {string} SVG string, or placeholder if unknown type
 */
export function generateChart(chartType, data, colors) {
  const gen = SVG_GENERATORS[chartType];
  if (!gen) {
    return `<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg"><text x="150" y="50" text-anchor="middle" font-size="10" fill="${(colors || {}).text_light || "#666"}" font-family="${FONT}">Okänd diagramtyp: ${esc(chartType)}</text></svg>`;
  }
  return gen(data, colors);
}
