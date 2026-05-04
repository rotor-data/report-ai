/**
 * Tests for the PATCH /api/v2/content_units/:id endpoint.
 *
 * The handler talks to Postgres via getSql() and verifies hub/editor
 * tokens. We mock both so the test is hermetic — exercising the
 * handler's request/response shape, validation, and auth gating without
 * needing a live database or signing keys.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────
// Hoisted so the handler module picks them up on import.

const sqlState = {
  // Set per-test; the mocked sql tagged-template returns these in order.
  responses: [],
  calls: [],
};

vi.mock('../../../netlify/functions/db.js', () => ({
  getSql: () => {
    // Return a tagged-template function that pops from `responses`.
    const fn = (strings, ...values) => {
      sqlState.calls.push({ strings: strings.join('?'), values });
      const next = sqlState.responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? []);
    };
    return fn;
  },
}));

const authState = {
  // Mutable per-test
  result: { ok: true, hubUserId: 'hub-test-user' },
  scopeMismatch: false,
};

vi.mock('../../../netlify/functions/auth-middleware.js', () => ({
  requireHubOrEditorAuth: () => authState.result,
  editorScopeMismatch: () => authState.scopeMismatch,
}));

// Module under test — import AFTER mocks above.
const { handler } = await import('../../../netlify/functions/v2-content-units.js');

function patchEvent({ id = 'unit-1', body, headers = {} } = {}) {
  return {
    httpMethod: 'PATCH',
    path: `/.netlify/functions/v2-content-units/${id}`,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
  };
}

beforeEach(() => {
  sqlState.responses = [];
  sqlState.calls = [];
  authState.result = { ok: true, hubUserId: 'hub-test-user' };
  authState.scopeMismatch = false;
});

describe('PATCH /api/v2/content_units/:id', () => {
  it('updates text on a valid request and returns the updated row', async () => {
    sqlState.responses = [
      // SELECT existing
      [{
        id: 'unit-1',
        report_id: 'rep-1',
        unit_id: 'intro-lead',
        type: 'paragraph',
        level: null,
        text: 'old',
        metadata: {},
        order_index: 0,
      }],
      // UPDATE … RETURNING
      [{
        id: 'unit-1',
        report_id: 'rep-1',
        unit_id: 'intro-lead',
        type: 'paragraph',
        level: null,
        text: 'new body',
        metadata: {},
        order_index: 0,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-04T00:00:00Z',
      }],
    ];
    const res = await handler(patchEvent({ body: { text: 'new body' } }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.item.text).toBe('new body');
    expect(body.item.unit_id).toBe('intro-lead');
  });

  it('rejects with 401 when auth fails', async () => {
    authState.result = { ok: false, status: 401, error: 'Unauthorized' };
    const res = await handler(patchEvent({ body: { text: 'x' } }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects level outside 1..6 with 400', async () => {
    const res = await handler(patchEvent({ body: { level: 7 } }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Invalid payload/i);
  });

  it('rejects empty body with 400', async () => {
    const res = await handler(patchEvent({ body: {} }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown unit id', async () => {
    sqlState.responses = [[]]; // SELECT returns nothing
    const res = await handler(patchEvent({ body: { text: 'x' } }));
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/not found/i);
  });

  it('blocks cross-tenant access via editor scope', async () => {
    sqlState.responses = [
      [{
        id: 'unit-1',
        report_id: 'rep-OTHER',
        unit_id: 'x',
        type: 'paragraph',
        level: null,
        text: 'old',
        metadata: {},
        order_index: 0,
      }],
    ];
    authState.scopeMismatch = true;
    const res = await handler(patchEvent({ body: { text: 'sneaky' } }));
    expect(res.statusCode).toBe(403);
  });

  it('rejects malformed JSON body with 400', async () => {
    const res = await handler(patchEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 405 for non-PATCH methods', async () => {
    const ev = patchEvent({ body: { text: 'x' } });
    ev.httpMethod = 'GET';
    const res = await handler(ev);
    expect(res.statusCode).toBe(405);
  });

  it('handles OPTIONS preflight without auth', async () => {
    const ev = patchEvent({ body: {} });
    ev.httpMethod = 'OPTIONS';
    const res = await handler(ev);
    expect(res.statusCode).toBe(204);
  });

  it('rejects metadata over 1 MB with 400', async () => {
    // Build a large but JSON-safe metadata payload.
    const big = { blob: 'x'.repeat(1024 * 1024 + 100) };
    const res = await handler(patchEvent({ body: { metadata: big } }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/exceeds/i);
  });

  it('updates level + metadata together', async () => {
    sqlState.responses = [
      [{
        id: 'unit-2',
        report_id: 'rep-1',
        unit_id: 'h1',
        type: 'heading',
        level: 1,
        text: 'Title',
        metadata: {},
        order_index: 0,
      }],
      [{
        id: 'unit-2',
        report_id: 'rep-1',
        unit_id: 'h1',
        type: 'heading',
        level: 2,
        text: 'Title',
        metadata: { color: 'red' },
        order_index: 0,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-04T00:00:00Z',
      }],
    ];
    const res = await handler(patchEvent({
      id: 'unit-2',
      body: { level: 2, metadata: { color: 'red' } },
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.item.level).toBe(2);
    expect(body.item.metadata).toEqual({ color: 'red' });
  });
});
