#!/usr/bin/env node
/**
 * Layer 1 — lint + syntax check (report-ai).
 *
 * Three passes:
 *   1. `node --check` over every .js / .mjs / .cjs in netlify/functions/
 *      and scripts/. Catches parse-time syntax errors locally before
 *      bundling.
 *   2. ESLint with a minimal config focused on `no-undef` (catches the
 *      fileURLToPath-without-import class of bug). Covers
 *      netlify/functions/, scripts/, and src/ (the React SPA).
 *   3. TypeScript noEmit if a tsconfig.json is present. The Vite app is
 *      JS/JSX today so this normally no-ops, but if TS lands later we
 *      pick it up automatically.
 *
 * If ESLint isn't installed (fresh checkout, no devDeps yet) we log and
 * skip instead of failing — the node --check pass on its own already
 * catches the most common parse-time bugs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const TARGETS = ['netlify/functions', 'scripts', 'src'];
const SYNTAX_TARGETS = ['netlify/functions', 'scripts'];
const EXTS = new Set(['.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.netlify',
  'dist',
  '.vite',
  'python-extractor',
]);

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else {
      const dot = entry.lastIndexOf('.');
      if (dot >= 0 && exts.has(entry.slice(dot))) out.push(p);
    }
  }
  return out;
}

// Pass 1: node --check on bundled-server-side JS.
const syntaxFiles = SYNTAX_TARGETS.flatMap((t) => walk(join(repoRoot, t), EXTS));
console.log(`[lint] node --check on ${syntaxFiles.length} files...`);

let syntaxFails = 0;
for (const f of syntaxFiles) {
  const res = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`[lint] SYNTAX ERROR: ${relative(repoRoot, f)}`);
    if (res.stderr) console.error(res.stderr.trim());
    syntaxFails++;
  }
}

if (syntaxFails > 0) {
  console.error(`[lint] ${syntaxFails} file(s) failed node --check — aborting`);
  process.exit(1);
}
console.log('[lint] node --check OK');

// Pass 2: ESLint over all targets (incl. src/ for the React SPA).
if (process.env.SKIP_ESLINT === '1') {
  console.log('[lint] SKIP_ESLINT=1 — skipping eslint pass');
} else {
  const tmpEslintConfig = join(repoRoot, '.eslintrc.layer1.cjs');
  const cfg = `module.exports = {
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  env: { node: true, browser: true, es2022: true },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': 'warn',
    'no-redeclare': 'error',
  },
  globals: {
    // React / browser globals the SPA touches that aren't in env:browser yet
    React: 'readonly',
    JSX: 'readonly',
  },
  ignorePatterns: [
    'node_modules/',
    '.netlify/',
    'dist/',
    'vendor/',
    'tests/',
    'public/',
    'python-extractor/',
    '_*.mjs',
    'notion-fix/',
  ],
};
`;
  writeFileSync(tmpEslintConfig, cfg);

  const eslintRes = spawnSync(
    'npx',
    [
      '--no-install',
      'eslint',
      '--no-eslintrc',
      '--config', tmpEslintConfig,
      '--ext', '.js,.mjs,.cjs,.jsx',
      'netlify/functions',
      'scripts',
      'src',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );

  if (eslintRes.error && eslintRes.error.code === 'ENOENT') {
    console.log('[lint] eslint not installed — skipping (install with `npm i -D eslint` to enable)');
  } else if (eslintRes.status !== 0) {
    console.error(`[lint] eslint failed (exit=${eslintRes.status})`);
    process.exit(1);
  } else {
    console.log('[lint] eslint OK');
  }
}

// Pass 3: TypeScript noEmit if tsconfig.json is present. Today the
// React SPA is JS/JSX, so this is a no-op — keeps the door open if TS
// lands later.
const tsconfig = join(repoRoot, 'tsconfig.json');
if (existsSync(tsconfig)) {
  console.log('[lint] tsconfig.json found — running tsc --noEmit');
  const tscRes = spawnSync(
    'npx',
    ['--no-install', 'tsc', '--noEmit', '-p', tsconfig],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (tscRes.error && tscRes.error.code === 'ENOENT') {
    console.log('[lint] tsc not installed — skipping TS pass');
  } else if (tscRes.status !== 0) {
    console.error(`[lint] tsc failed (exit=${tscRes.status})`);
    process.exit(1);
  } else {
    console.log('[lint] tsc OK');
  }
} else {
  console.log('[lint] no tsconfig.json — skipping TS pass (JS/JSX repo)');
}
