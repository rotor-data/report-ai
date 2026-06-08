/**
 * Canonical MCP tool-error contract — shared, byte-identical across all
 * Smyra repos (hub, report-ai, brand-os). Dependency-free pure JS so the
 * logic stays identical regardless of where it's vendored.
 *
 * Every tool FAILURE is returned as a JSON-RPC *result* (HTTP 200) whose
 * payload follows this shape. It is NOT a JSON-RPC `error` object — MCP
 * clients (Claude.ai) surface in-result errors better, and the human text
 * stays readable in plain-text clients.
 *
 *   result: {
 *     isError: true,
 *     content: [{ type: 'text', text: <HUMAN> }],
 *     structuredContent: { error: {
 *       code, message, retryable, next_action, context
 *     } }
 *   }
 *
 * HUMAN = message; if next_action is present, append
 *   "\n\n▶ Nästa steg: <next_action>".
 *
 * `code` is one of:
 *   BRAND_ID_REQUIRED | VALIDATION | NOT_FOUND | UPSTREAM_TIMEOUT |
 *   UPSTREAM_ERROR | RATE_LIMITED | AUTH | INTERNAL
 */

const VALID_CODES = new Set([
  "BRAND_ID_REQUIRED",
  "VALIDATION",
  "NOT_FOUND",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ERROR",
  "RATE_LIMITED",
  "AUTH",
  "INTERNAL",
]);

/**
 * Build the canonical tool-error `result` object.
 *
 * @param {object} p
 * @param {string} [p.code]        one of VALID_CODES; defaults to 'INTERNAL'.
 * @param {string} p.message       human-readable failure message.
 * @param {boolean} [p.retryable]  defaults from code if omitted.
 * @param {string|null} [p.next_action] actionable recovery hint for the caller.
 * @param {object} [p.context]     structured extra context (ids, valid lists…).
 * @returns {{isError:true, content:Array, structuredContent:object}}
 */
function toolError({ code, message, retryable, next_action, context } = {}) {
  const finalCode = VALID_CODES.has(code) ? code : "INTERNAL";
  const finalMessage =
    typeof message === "string" && message.trim() ? message : "Internal error";
  const finalNextAction =
    typeof next_action === "string" && next_action.trim() ? next_action : null;
  const finalRetryable =
    typeof retryable === "boolean" ? retryable : defaultRetryable(finalCode);
  const finalContext =
    context && typeof context === "object" && !Array.isArray(context)
      ? context
      : {};

  const humanText = finalNextAction
    ? `${finalMessage}\n\n▶ Nästa steg: ${finalNextAction}`
    : finalMessage;

  return {
    isError: true,
    content: [{ type: "text", text: humanText }],
    structuredContent: {
      error: {
        code: finalCode,
        message: finalMessage,
        retryable: finalRetryable,
        next_action: finalNextAction,
        context: finalContext,
      },
    },
  };
}

/**
 * Default retryability per error code. Validation / not-found / auth are
 * caller-fixable (not retryable); transient upstream / rate-limit are.
 */
function defaultRetryable(code) {
  switch (code) {
    case "UPSTREAM_TIMEOUT":
    case "UPSTREAM_ERROR":
    case "RATE_LIMITED":
      return true;
    case "INTERNAL":
      // Internal errors are conservatively retryable=false (caller can't
      // know the cause is transient). Override explicitly when it is.
      return false;
    default:
      // VALIDATION, NOT_FOUND, BRAND_ID_REQUIRED, AUTH
      return false;
  }
}

/**
 * True if `result` is a canonical tool-error result.
 * @param {*} result
 * @returns {boolean}
 */
function isToolErrorResult(result) {
  return !!(
    result &&
    typeof result === "object" &&
    result.isError === true &&
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    result.structuredContent.error &&
    typeof result.structuredContent.error === "object"
  );
}

export { toolError, isToolErrorResult, VALID_CODES };
