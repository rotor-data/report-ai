const buckets = new Map();

function nowMs() {
  return Date.now();
}

function keyFor(route, hubUserId) {
  return `${route}:${hubUserId}`;
}

export function checkRateLimit({ route, hubUserId, max = 10, windowMs = 60_000 }) {
  const key = keyFor(route, hubUserId);
  const now = nowMs();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }

  if (current.count >= max) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return { ok: true, remaining: max - current.count };
}
