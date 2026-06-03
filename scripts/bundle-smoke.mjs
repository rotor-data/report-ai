#!/usr/bin/env node
/**
 * Layer 1 — bundle smoke test (report-ai).
 *
 * Runs Netlify's esbuild bundler over `netlify/functions/` then loads each
 * bundled function in a fresh Node subprocess. Catches top-level crashes
 * during module load (the fileURLToPath / ESM-vs-CJS class of bug that
 * bit the hub 2026-06-03) before deploy.
 *
 * Must be a SUBPROCESS, not require() in this process — otherwise a
 * side-effectful top-level crash takes down the smoke runner itself
 * with a misleading stack and we lose the actual error context.
 *
 * Targets:
 *   - mcp-v2, v2-render, v2-render-pptx, v2-brand-css, v2-reports,
 *     v2-editor-url, unsplash-direct
 *   - every *-background.js function in netlify/functions/
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const fnSrcDir = join(repoRoot, 'netlify/functions');

// Required foreground functions — failure to bundle/load any of these
// aborts the smoke. Background functions are discovered dynamically.
const REQUIRED_FOREGROUND = [
  'mcp-v2',
  'v2-render',
  'v2-render-pptx',
  'v2-brand-css',
  'v2-reports',
  'v2-editor-url',
  'unsplash-direct',
];

function discoverBackgroundFunctions() {
  if (!existsSync(fnSrcDir)) return [];
  return readdirSync(fnSrcDir)
    .filter((f) => f.endsWith('-background.js'))
    .map((f) => f.replace(/\.js$/, ''));
}

function findFunctionsServeDir() {
  // Netlify CLI bundle layout has shifted between versions — probe all
  // known output dirs. The first match wins.
  const candidates = [
    join(repoRoot, '.netlify/functions-built'),
    join(repoRoot, '.netlify/functions-serve'),
    join(repoRoot, '.netlify/functions'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolveBundledEntry(dir, fnName) {
  // Layout 1: <dir>/<fnName>/<fnName>.js (zipless serve dir)
  const a = join(dir, fnName, `${fnName}.js`);
  if (existsSync(a)) return { kind: 'js', path: a };
  // Layout 2: <dir>/<fnName>.js (flat)
  const b = join(dir, `${fnName}.js`);
  if (existsSync(b)) return { kind: 'js', path: b };
  // Layout 3: <dir>/<fnName>.zip — `netlify functions:build` output.
  // Each zip contains a top-level <fnName>.js stub that requires the
  // real entry under netlify/functions/<fnName>.js. We unzip into a
  // sibling staging dir and load the stub.
  const z = join(dir, `${fnName}.zip`);
  if (existsSync(z)) return { kind: 'zip', path: z };
  return null;
}

console.log('[smoke] bundling functions via `netlify functions:build`...');
try {
  // `netlify functions:build` refuses if src === dest. The repo's
  // netlify.toml points `functions = "netlify/functions"`, so we
  // bundle into a separate dir (`.netlify/functions-built`) here.
  execSync(
    'npx --no-install netlify functions:build --src netlify/functions --functions .netlify/functions-built',
    {
      cwd: repoRoot,
      stdio: 'inherit',
      timeout: 240_000,
      env: { ...process.env, NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN || '' },
    },
  );
} catch (err) {
  console.error('[smoke] netlify functions:build FAILED');
  console.error(err?.message ?? err);
  process.exit(1);
}

const fnDir = findFunctionsServeDir();
if (!fnDir) {
  console.error('[smoke] no .netlify/functions-serve or .netlify/functions dir produced — bundle did not run');
  process.exit(1);
}

console.log(`[smoke] bundled functions dir: ${fnDir}`);

const backgroundFns = discoverBackgroundFunctions();
const targets = [...REQUIRED_FOREGROUND, ...backgroundFns];
console.log(`[smoke] checking ${targets.length} functions (${REQUIRED_FOREGROUND.length} foreground + ${backgroundFns.length} background)`);

let failures = 0;
let loaded = 0;
const missing = [];

const stagingRoot = join(repoRoot, '.netlify/smoke-staging');
if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

for (const fn of targets) {
  const ref = resolveBundledEntry(fnDir, fn);
  if (!ref) {
    missing.push(fn);
    continue;
  }
  let entryPath;
  if (ref.kind === 'zip') {
    const dest = join(stagingRoot, fn);
    mkdirSync(dest, { recursive: true });
    const unzipRes = spawnSync('unzip', ['-q', ref.path, '-d', dest], { stdio: 'inherit' });
    if (unzipRes.status !== 0) {
      console.error(`[smoke] failed to unzip ${ref.path}`);
      failures++;
      continue;
    }
    // Find the function entry. Netlify CLI emits one of:
    //   - <fn>.js (CJS, foreground / esbuild-bundled)
    //   - netlify/functions/<fn>.mjs (ESM, background via bootstrap)
    //   - ___netlify-entry-point.mjs (wraps an .mjs source)
    const candidates = [
      join(dest, `${fn}.js`),
      join(dest, `${fn}.mjs`),
      join(dest, 'netlify', 'functions', `${fn}.js`),
      join(dest, 'netlify', 'functions', `${fn}.mjs`),
      join(dest, '___netlify-entry-point.mjs'),
    ];
    entryPath = candidates.find((c) => existsSync(c));
    if (!entryPath) {
      console.error(`[smoke] zip ${ref.path} has no recognised entry (tried ${candidates.map((c) => c.slice(dest.length + 1)).join(', ')})`);
      failures++;
      continue;
    }
  } else {
    entryPath = ref.path;
  }
  console.log(`[smoke] loading ${fn}`);
  // Use dynamic import() for .mjs entries; require() for .js (CJS).
  // Both run in a fresh subprocess so a top-level crash is caught
  // with a real stack trace rather than killing this runner.
  const isMjs = entryPath.endsWith('.mjs');
  const loader = isMjs
    ? `import(${JSON.stringify('file://' + entryPath)}).catch((e) => { console.error('IMPORT_FAILED:', e && e.stack || e); process.exit(1); })`
    : `try { require(${JSON.stringify(entryPath)}); } catch (e) { console.error('REQUIRE_FAILED:', e && e.stack || e); process.exit(1); }`;
  const res = spawnSync(
    process.execPath,
    ['-e', loader],
    { stdio: 'inherit', timeout: 30_000 },
  );
  if (res.status !== 0) {
    console.error(`[smoke] FAILED to load ${fn} (exit=${res.status}, signal=${res.signal})`);
    failures++;
  } else {
    loaded++;
  }
}

if (missing.length) {
  console.error('[smoke] required functions not present in bundle output:', missing.join(', '));
  failures += missing.length;
}

if (failures > 0) {
  console.error(`[smoke] ${failures} function(s) failed to load — aborting`);
  process.exit(1);
}

console.log(`[smoke] OK — ${loaded}/${targets.length} functions loaded cleanly`);
