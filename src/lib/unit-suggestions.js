/**
 * Heuristic type-correction suggestions for alpha-v3 content units.
 *
 * Given a parsed unit (likely classified as `paragraph` by the input.collect
 * heuristics), inspect the text and propose a more accurate type. Pure
 * function, no I/O — safe to import lazily from endpoint handlers.
 *
 * Returned suggestions:
 *   [{ suggested_type, confidence, reasoning, level? }]
 * Sorted by confidence DESC. Empty array = "looks correctly classified".
 *
 * The caller decides whether to filter by confidence (the
 * /api/v2/units/suggestions endpoint drops < 0.6 to keep the list
 * actionable).
 */

const BULLET_LINE_RE = /^\s*[-*•]\s+/;
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+/;
const SENTENCE_END_RE = /[.!?…"”»)]$/;
const EM_DASH_LEAD_RE = /^[—–]\s+/;

function countSentences(text) {
  // Cheap: count sentence terminators that are followed by whitespace/EOS.
  const matches = text.match(/[.!?…](?:\s|$)/g);
  return matches ? matches.length : 0;
}

function isAllOrMostlyCaps(text) {
  const letters = text.replace(/[^A-Za-zÅÄÖåäöÉéÜüß]/g, "");
  if (letters.length < 3) return { isCaps: false, ratio: 0 };
  let upper = 0;
  for (const ch of letters) {
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper++;
  }
  const ratio = upper / letters.length;
  return { isCaps: ratio >= 0.7, ratio };
}

/**
 * @param {{ type?: string, text?: string|null, level?: number|null }} unit
 * @returns {Array<{ suggested_type: string, confidence: number, reasoning: string, level?: number }>}
 */
export function suggestTypeCorrection(unit) {
  const text = (unit?.text ?? "").trim();
  if (!text) return [];

  const out = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const currentType = unit?.type ?? "paragraph";

  // Rule: multi-line bullet list (- / * / •).
  if (lines.length >= 2 && lines.every((l) => BULLET_LINE_RE.test(l))) {
    out.push({
      suggested_type: "bullet_list",
      confidence: 0.95,
      reasoning: `All ${lines.length} lines start with a bullet marker (-, *, or •).`,
    });
  }

  // Rule: multi-line numbered list ("1." / "2)" / etc).
  if (lines.length >= 2 && lines.every((l) => NUMBERED_LINE_RE.test(l))) {
    out.push({
      suggested_type: "numbered_list",
      confidence: 0.95,
      reasoning: `All ${lines.length} lines start with a numeric prefix (1., 2., …).`,
    });
  }

  // Single-block rules below only make sense when there's no list pattern.
  const sentenceCount = countSentences(text);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const len = text.length;

  // Rule: short fragment that looks like a heading.
  //   - <= 80 chars
  //   - <= ~10 words
  //   - no sentence-ending punctuation OR starts capital and has no period.
  const startsCapital = /^[A-ZÅÄÖ]/.test(text);
  const endsSentence = SENTENCE_END_RE.test(text);
  if (
    currentType === "paragraph" &&
    lines.length === 1 &&
    len <= 80 &&
    wordCount <= 10 &&
    (!endsSentence || (startsCapital && !text.includes(".")))
  ) {
    out.push({
      suggested_type: "heading",
      confidence: 0.8,
      reasoning: "Short single-line fragment without sentence-ending punctuation — typical of a heading rather than body text.",
      level: 2,
    });
  }

  // Rule: leading em/en dash → attribution / blockquote.
  if (EM_DASH_LEAD_RE.test(text)) {
    out.push({
      suggested_type: "attribution",
      confidence: 0.75,
      reasoning: "Text starts with an em/en dash, the typical attribution lead-in (\"— Name, Title\").",
    });
  }

  // Rule: all-caps / mostly-caps → kicker / eyebrow.
  const caps = isAllOrMostlyCaps(text);
  if (caps.isCaps && len <= 120) {
    out.push({
      suggested_type: "kicker",
      confidence: 0.7,
      reasoning: `${Math.round(caps.ratio * 100)}% of letters are uppercase — likely a kicker or eyebrow label, not body text.`,
    });
  }

  // Rule: long multi-sentence paragraph is almost certainly correctly typed
  // as `paragraph`. Returning [] communicates "no suggestion".
  if (currentType === "paragraph" && len >= 200 && sentenceCount >= 3) {
    return [];
  }

  // Drop suggestions that match the current type (no-op).
  const filtered = out.filter((s) => s.suggested_type !== currentType);

  filtered.sort((a, b) => b.confidence - a.confidence);
  return filtered;
}
