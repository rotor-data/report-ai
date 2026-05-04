/**
 * Content-units substitution for the editor preview.
 *
 * Walks page HTML composed by Claude (text-bearing elements carry
 * `data-unit="<id>"` attributes with empty bodies), looks each unit up in
 * the supplied `units` array, and replaces the element's inner content with
 * the rendered unit body. The wrapper element + its other attributes are
 * preserved; only `data-unit` is stripped.
 *
 * Pure function. Idempotent — running twice over the same HTML is safe.
 *
 * Mirrors smyra-render/units_substitute.py. The Python version uses
 * BeautifulSoup + lxml; this version uses the browser's `<template>` element
 * via `DOMParser` (or falls back if `document` is unavailable in test env).
 */

import { parseInlineMarkdown } from './inline-md.js';

// Set of unit types whose body is inline-markdown of `unit.text`.
const INLINE_TEXT_TYPES = new Set([
  'paragraph', 'lead', 'kicker', 'attribution', 'eyebrow',
  'heading',
  'blockquote', 'pull_quote', 'callout',
  'info_box', 'warning_box', 'success_box', 'highlight',
  'caption', 'footnote', 'sidenote', 'citation',
  'toc_entry',
]);

function md(text) {
  return parseInlineMarkdown(text || '');
}

function fallback(unitId, reason) {
  // eslint-disable-next-line no-console
  console.warn(`units_substitute: ${reason} for unit ${unitId}`);
  return `<em>(missing data for ${unitId})</em>`;
}

// --- Per-type renderers ---------------------------------------------------

function renderList(unit) {
  const items = ((unit.metadata || {}).items) || [];
  if (!Array.isArray(items)) {
    return fallback(unit.unit_id || '?', 'list metadata.items not a list');
  }
  return items.map((i) => `<li>${md(String(i))}</li>`).join('');
}

function renderDefinitionList(unit) {
  const pairs = ((unit.metadata || {}).item_definitions) || [];
  if (!Array.isArray(pairs)) {
    return fallback(unit.unit_id || '?', 'definition_list item_definitions not a list');
  }
  const out = [];
  for (const p of pairs) {
    if (!p || typeof p !== 'object') continue;
    out.push(`<dt>${md(p.term)}</dt><dd>${md(p.definition)}</dd>`);
  }
  return out.join('');
}

function renderKpiInner(kpi) {
  const value = md(kpi.value);
  const label = md(kpi.label);
  const parts = [
    `<span class="kpi-value">${value}</span>`,
    `<span class="kpi-label">${label}</span>`,
  ];
  if (kpi.change) {
    parts.push(`<span class="kpi-change">${md(kpi.change)}</span>`);
  }
  return parts.join('');
}

function renderKpi(unit) {
  const kpi = (unit.metadata || {}).kpi;
  if (!kpi || typeof kpi !== 'object') {
    return fallback(unit.unit_id || '?', 'kpi missing metadata.kpi');
  }
  return renderKpiInner(kpi);
}

function renderKpiGroup(unit) {
  const kpis = (unit.metadata || {}).kpis;
  if (!Array.isArray(kpis)) {
    return fallback(unit.unit_id || '?', 'kpi_group missing metadata.kpis');
  }
  const out = [];
  for (const k of kpis) {
    if (!k || typeof k !== 'object') continue;
    out.push(`<div class="kpi">${renderKpiInner(k)}</div>`);
  }
  return out.join('');
}

function renderStatHero(unit) {
  const stat = (unit.metadata || {}).stat;
  if (!stat || typeof stat !== 'object') {
    return fallback(unit.unit_id || '?', 'stat_hero missing metadata.stat');
  }
  const parts = [
    `<div class="stat-value">${md(stat.value)}</div>`,
    `<div class="stat-label">${md(stat.label)}</div>`,
  ];
  if (stat.context) {
    parts.push(`<div class="stat-context">${md(stat.context)}</div>`);
  }
  return parts.join('');
}

function renderTable(unit) {
  const table = (unit.metadata || {}).table;
  if (!table || typeof table !== 'object' || !Array.isArray(table.rows)) {
    return fallback(unit.unit_id || '?', 'table missing metadata.table.rows');
  }
  const out = [];
  if (table.caption) {
    out.push(`<caption>${md(table.caption)}</caption>`);
  }
  if (Array.isArray(table.header) && table.header.length) {
    const cells = table.header.map((c) => `<th>${md(String(c))}</th>`).join('');
    out.push(`<thead><tr>${cells}</tr></thead>`);
  }
  const bodyRows = [];
  for (const row of table.rows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => `<td>${md(String(c))}</td>`).join('');
    bodyRows.push(`<tr>${cells}</tr>`);
  }
  out.push(`<tbody>${bodyRows.join('')}</tbody>`);
  return out.join('');
}

function renderComparison(unit) {
  const cmp = (unit.metadata || {}).comparison;
  if (!cmp || typeof cmp !== 'object') {
    return fallback(unit.unit_id || '?', 'comparison missing metadata.comparison');
  }
  const left = cmp.left || [];
  const right = cmp.right || [];
  const leftLabel = md(cmp.left_label);
  const rightLabel = md(cmp.right_label);
  const leftItems = Array.isArray(left)
    ? left.map((i) => `<li>${md(String(i))}</li>`).join('')
    : '';
  const rightItems = Array.isArray(right)
    ? right.map((i) => `<li>${md(String(i))}</li>`).join('')
    : '';
  return (
    `<div class="comparison-col comparison-left">` +
    `<h4>${leftLabel}</h4><ul>${leftItems}</ul></div>` +
    `<div class="comparison-col comparison-right">` +
    `<h4>${rightLabel}</h4><ul>${rightItems}</ul></div>`
  );
}

function renderTimelineEvent(unit) {
  const tl = (unit.metadata || {}).timeline;
  if (!tl || typeof tl !== 'object') {
    return fallback(unit.unit_id || '?', 'timeline_event missing metadata.timeline');
  }
  const parts = [
    `<div class="event-date">${md(tl.date)}</div>`,
    `<div class="event-title">${md(tl.title)}</div>`,
  ];
  if (tl.body) {
    parts.push(`<p>${md(tl.body)}</p>`);
  }
  return parts.join('');
}

function renderStep(unit) {
  const st = (unit.metadata || {}).step;
  if (!st || typeof st !== 'object') {
    return fallback(unit.unit_id || '?', 'step missing metadata.step');
  }
  const number = st.number !== undefined && st.number !== null ? st.number : '';
  const parts = [
    `<div class="step-num">${md(String(number))}</div>`,
    `<div class="step-title">${md(st.title)}</div>`,
  ];
  if (st.body) {
    parts.push(`<p>${md(st.body)}</p>`);
  }
  return parts.join('');
}

function renderTestimonial(unit) {
  const t = (unit.metadata || {}).testimonial;
  if (!t || typeof t !== 'object') {
    return fallback(unit.unit_id || '?', 'testimonial missing metadata.testimonial');
  }
  const out = [];
  if (t.photo_asset_ref) {
    out.push(`<img data-asset-ref="${t.photo_asset_ref}">`);
  }
  out.push(`<blockquote>${md(t.quote)}</blockquote>`);
  const person = md(t.person);
  if (t.role) {
    out.push(`<figcaption>${person}, ${md(t.role)}</figcaption>`);
  } else {
    out.push(`<figcaption>${person}</figcaption>`);
  }
  return out.join('');
}

function renderGlossaryItem(unit) {
  const g = (unit.metadata || {}).glossary;
  if (!g || typeof g !== 'object') {
    return fallback(unit.unit_id || '?', 'glossary_item missing metadata.glossary');
  }
  return `<dt>${md(g.term)}</dt><dd>${md(g.definition)}</dd>`;
}

function renderBibliographyEntry(unit) {
  const bib = (unit.metadata || {}).bib;
  if (!bib || typeof bib !== 'object') {
    return md(unit.text);
  }
  const parts = [];
  if (bib.authors) parts.push(`${md(bib.authors)}.`);
  if (bib.title) parts.push(`<em>${md(bib.title)}</em>.`);
  if (bib.publisher && bib.year) {
    parts.push(`${md(bib.publisher)}, ${md(String(bib.year))}.`);
  } else if (bib.publisher) {
    parts.push(`${md(bib.publisher)}.`);
  } else if (bib.year) {
    parts.push(`${md(String(bib.year))}.`);
  }
  if (bib.url) {
    parts.push(md(`[${bib.url}](${bib.url})`));
  }
  return parts.join(' ');
}

function renderEmpty() {
  return '';
}

const RENDERERS = {
  bullet_list: renderList,
  numbered_list: renderList,
  check_list: renderList,
  definition_list: renderDefinitionList,
  kpi: renderKpi,
  kpi_group: renderKpiGroup,
  stat_hero: renderStatHero,
  table: renderTable,
  comparison: renderComparison,
  timeline_event: renderTimelineEvent,
  step: renderStep,
  testimonial: renderTestimonial,
  glossary_item: renderGlossaryItem,
  bibliography_entry: renderBibliographyEntry,
  divider: renderEmpty,
  spacer: renderEmpty,
  page_break: renderEmpty,
};

function renderUnitInner(unit) {
  const unitType = unit.type;
  if (typeof unitType !== 'string') {
    return fallback(unit.unit_id || '?', 'unit missing type');
  }
  if (INLINE_TEXT_TYPES.has(unitType)) {
    return md(unit.text);
  }
  const renderer = RENDERERS[unitType];
  if (!renderer) {
    return fallback(unit.unit_id || '?', `unknown unit type '${unitType}'`);
  }
  return renderer(unit);
}

// --- DOM helpers ----------------------------------------------------------

/**
 * Parse an HTML fragment into a DocumentFragment without `<html><body>`
 * wrappers. Uses `<template>` element (works in all modern browsers + jsdom).
 */
function parseFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

function serializeFragment(frag) {
  // Container div lets us read innerHTML cleanly without an outer wrapper.
  const div = document.createElement('div');
  div.appendChild(frag.cloneNode(true));
  return div.innerHTML;
}

/**
 * Substitute `data-unit` placeholders in `html` with rendered unit bodies.
 *
 * @param {string} html
 * @param {Array<object>} units
 * @returns {string}
 */
export function substituteUnits(html, units) {
  if (!html) return html || '';

  const byId = {};
  for (const u of units || []) {
    if (u && typeof u === 'object' && typeof u.unit_id === 'string') {
      byId[u.unit_id] = u;
    }
  }

  const frag = parseFragment(html);
  const placeholders = frag.querySelectorAll('[data-unit]');

  for (const el of placeholders) {
    const unitId = el.getAttribute('data-unit') || '';
    const unit = byId[unitId];
    if (!unit) {
      // eslint-disable-next-line no-console
      console.warn(`units_substitute: unit ${unitId} not found`);
      while (el.firstChild) el.removeChild(el.firstChild);
      el.removeAttribute('data-unit');
      continue;
    }
    const inner = renderUnitInner(unit);
    while (el.firstChild) el.removeChild(el.firstChild);
    if (inner) {
      const innerFrag = parseFragment(inner);
      el.appendChild(innerFrag);
    }
    el.removeAttribute('data-unit');
  }

  return serializeFragment(frag);
}
