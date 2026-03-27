import { randomUUID } from "node:crypto";

function pickHeader(event, name) {
  return event?.headers?.[name] ?? event?.headers?.[name.toLowerCase()] ?? null;
}

export function getRequestContext(event, functionName, extra = {}) {
  const requestId = pickHeader(event, "x-request-id") || randomUUID();
  const traceId = pickHeader(event, "x-trace-id") || randomUUID();
  return {
    function_name: functionName,
    request_id: requestId,
    trace_id: traceId,
    start_ms: Date.now(),
    ...extra,
  };
}

function emit(level, ctx, message, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    function_name: ctx?.function_name,
    request_id: ctx?.request_id,
    trace_id: ctx?.trace_id,
    duration_ms: typeof ctx?.start_ms === "number" ? Date.now() - ctx.start_ms : undefined,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(ctx, message, fields = {}) {
  emit("info", ctx, message, fields);
}

export function logWarn(ctx, message, fields = {}) {
  emit("warn", ctx, message, fields);
}

export function logError(ctx, message, err = null, fields = {}) {
  emit("error", ctx, message, {
    ...fields,
    ...(err ? { error: err?.message ?? String(err) } : {}),
  });
}
