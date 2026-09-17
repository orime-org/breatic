// Every route entry still ships as its own chunk (task #142).
//
// The unit tests pin how `routes.tsx` is written; this reads what the build
// emitted. The two can part ways without either noticing — a `manualChunks`
// branch that swallows the page modules, a bundler default that changes, an
// entry added to the table and then imported statically somewhere else — and
// what a reader downloads is decided here, not there.
//
//   node verify-chunks.mjs [dist-dir]
//
// Exits non-zero, naming what moved, when either invariant breaks:
//   - every production page has a chunk of its own
//   - index.html's static closure holds none of them
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = process.argv[2] ?? path.join(import.meta.dirname, 'dist', 'breatic');
const ASSETS = path.join(DIST, 'assets');

/** The thirteen production pages, as `src/app/routes.tsx` declares them. */
const PAGES = [
  'StudioLayout',
  'StudioRecentPage',
  'StudioContainerPage',
  'ProjectPage',
  'DecisionLandingPage',
  'NoAccessPage',
  'LoginPage',
  'RegisterPage',
  'RecoveryCodePage',
  'SlugSetupPage',
  'ForgotPasswordPage',
  'ResetPasswordPage',
  'VerifyEmailPage',
];

if (!existsSync(ASSETS)) {
  console.error(`verify-chunks: no build at ${DIST} — run \`pnpm --filter @breatic/web build\` first`);
  process.exit(1);
}

const files = readdirSync(ASSETS);

/** @returns {string[]} the files index.html loads before anything else. */
function entryFiles() {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  return [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
}

/** @returns {Set<string>} the transitive static closure of the given files. */
function closure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !files.includes(file)) continue;
    seen.add(file);
    const code = readFileSync(path.join(ASSETS, file), 'utf8');
    for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)[^;]*?from"\.\/([^"]+)"/g)) {
      stack.push(m[1]);
    }
    for (const m of code.matchAll(/(?:^|[;\s}])import"\.\/([^"]+)"/g)) stack.push(m[1]);
  }
  return seen;
}

const problems = [];

const missing = PAGES.filter(
  (page) => !files.some((f) => f.startsWith(`${page}-`) && f.endsWith('.js')),
);
if (missing.length > 0) {
  problems.push(`no chunk of its own: ${missing.join(', ')}`);
}

// A page module inside the entry closure is downloaded by every entry, which
// is the state this task existed to leave.
const base = closure(entryFiles());
const eager = PAGES.filter((page) => [...base].some((f) => f.startsWith(`${page}-`)));
if (eager.length > 0) {
  problems.push(`in the closure every entry downloads: ${eager.join(', ')}`);
}

if (problems.length > 0) {
  console.error('verify-chunks: the build stopped splitting per entry');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `verify-chunks: ${PAGES.length} pages each in their own chunk, none in the ${base.size}-file entry closure`,
);
