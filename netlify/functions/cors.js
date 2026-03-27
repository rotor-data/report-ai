const siteUrl = process.env.SITE_URL ?? "*";
const hubSiteUrl = process.env.HUB_SITE_URL ?? "";

export function getCorsHeaders(event = {}) {
  const origin = event.headers?.origin ?? event.headers?.Origin ?? "";
  const allowed = [siteUrl, hubSiteUrl].filter(Boolean);
  const allowOrigin = allowed.includes("*")
    ? "*"
    : (allowed.includes(origin) ? origin : allowed[0] ?? "*");

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function json(event, statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(event),
    },
    body: JSON.stringify(payload),
  };
}

export function noContent(event, statusCode = 204) {
  return {
    statusCode,
    headers: getCorsHeaders(event),
    body: "",
  };
}
