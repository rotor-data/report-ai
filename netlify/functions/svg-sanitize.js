/**
 * SVG sanitizer for user-uploaded assets (stored XSS hardening).
 *
 * SVG is an active document format: <script>, <foreignObject>, event-handler
 * attributes (onload/onclick/…), and external references (javascript:, external
 * http(s) hrefs/xlink:href, <use href>) can all execute script when the SVG is
 * opened TOP-LEVEL as image/svg+xml. We never want a tenant to be able to store
 * an SVG that runs script in another user's browser.
 *
 * Strategy (defense in depth):
 *   1. A conservative regex pre-pass strips the highest-risk constructs even if
 *      the structured parse below is bypassed somehow.
 *   2. A structured pass with node-html-parser (already a production dep) walks
 *      the tree and removes dangerous elements, event-handler attributes, and
 *      script-bearing url() / href / xlink:href values.
 *
 * This is NOT a full DOMPurify SVG profile (no dep installed), but it removes
 * every active-content vector called out in the audit (P0.3 / G4). If a real
 * sanitizer (dompurify+jsdom / sanitize-html / @mattkrick/sanitize-svg) is added
 * later, swap the body of sanitizeSvg() for it and keep the signature.
 */
import { parse } from "node-html-parser";

// Elements that can execute script or load active/remote content.
const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "embed",
  "object",
  "audio",
  "video",
  "handler",   // SMIL handler
  "listener",  // SMIL listener
  "set",       // SMIL set can target event attributes
  "animate",   // SMIL animate can be used to inject script-bearing attrs
  "animatetransform",
  "animatemotion",
]);

// Attributes that reference URLs we must scrub for javascript:/data:text-html.
const URL_ATTRS = ["href", "xlink:href", "src", "data", "from", "to", "values", "begin", "end"];

function isDangerousUrl(value) {
  if (!value) return false;
  // Strip whitespace + HTML entities that could hide the scheme, then test.
  const v = String(value)
    .replace(/&#x?[0-9a-f]+;?/gi, "") // numeric/hex entities
    .replace(/\s+/g, "")
    .toLowerCase();
  if (v.startsWith("javascript:")) return true;
  if (v.startsWith("vbscript:")) return true;
  if (v.startsWith("data:") && v.includes("text/html")) return true;
  // External network references (image-inlining, <use> from another origin).
  if (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("//")) return true;
  return false;
}

/**
 * Conservative regex pre-pass. Removes the highest-risk constructs before the
 * structured parse so that even a parser quirk can't let them through.
 */
function regexStrip(svg) {
  let out = svg;
  // <script>…</script> (incl. self-closing / attributes)
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<script[^>]*\/>/gi, "");
  // <foreignObject>…</foreignObject>
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "");
  out = out.replace(/<foreignObject[^>]*\/>/gi, "");
  // on*="…" / on*='…' / on*=bareword event handlers
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  // javascript:/vbscript: anywhere in an attribute value
  out = out.replace(/(javascript|vbscript)\s*:/gi, "removed:");
  return out;
}

/**
 * Sanitize an SVG string. Returns { svg, removed } where `removed` lists what
 * was stripped (for logging). Throws if the input is not parseable as SVG.
 */
export function sanitizeSvg(rawSvg) {
  if (typeof rawSvg !== "string" || !/<svg[\s>]/i.test(rawSvg)) {
    throw new Error("Not an SVG document");
  }

  const removed = [];
  // 1) Regex pre-pass.
  const prePassed = regexStrip(rawSvg);

  // 2) Structured pass.
  const root = parse(prePassed, {
    lowerCaseTagName: true,
    comment: false,
    voidTag: { closingSlash: true },
  });

  for (const el of root.querySelectorAll("*")) {
    const tag = (el.rawTagName || "").toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) {
      removed.push(`<${tag}>`);
      el.remove();
      continue;
    }
    // Scrub attributes.
    const attrs = el.attributes || {};
    for (const name of Object.keys(attrs)) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on")) {
        removed.push(`${tag}@${lower}`);
        el.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.includes(lower) && isDangerousUrl(attrs[name])) {
        removed.push(`${tag}@${lower}(url)`);
        el.removeAttribute(name);
        continue;
      }
      // style="" can carry url(javascript:...) / expression() / @import.
      if (lower === "style") {
        const sv = String(attrs[name]).toLowerCase();
        if (
          /url\s*\(\s*['"]?\s*(javascript|vbscript|data:text\/html)/i.test(sv) ||
          /expression\s*\(/i.test(sv) ||
          /@import/i.test(sv)
        ) {
          removed.push(`${tag}@style`);
          el.removeAttribute(name);
        }
      }
    }
  }

  return { svg: root.toString(), removed };
}
