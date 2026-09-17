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
//   - no page sits in a closure that is not its own — not index.html's, and
//     not another page's, which is the same "downloaded without being asked
//     for" in a different place
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIST = process.argv[2] ?? path.join(import.meta.dirname, 'dist', 'breatic');
const ASSETS = path.join(DIST, 'assets');
const ROUTES = path.join(import.meta.dirname, 'src', 'app', 'routes.tsx');

/**
 * The production pages, read from the route table rather than listed here.
 *
 * A list written out in this file covers whatever it was written against: the
 * fourteenth entry gets added to `routes.tsx` and this guard goes on passing
 * without ever having looked at it. Rollup names a chunk after its module's
 * file, so the basename of each `lazyRoute` import is the name to expect.
 * @returns {string[]} Page module basenames, in table order.
 */
function routeTablePages() {
  const src = readFileSync(ROUTES, 'utf8');
  return [...src.matchAll(/lazyRoute\(\s*\(\)\s*=>\s*import\('([^']+)'\)/g)].map((m) =>
    m[1].split('/').pop(),
  );
}

const PAGES = routeTablePages();

if (PAGES.length === 0) {
  console.error(`verify-chunks: found no lazyRoute entries in ${ROUTES}`);
  process.exit(1);
}

if (!existsSync(ASSETS)) {
  console.error(`verify-chunks: no build at ${DIST} — run \`pnpm --filter @breatic/web build\` first`);
  process.exit(1);
}

const files = readdirSync(ASSETS);

/** @returns {string[]} the files index.html loads before anything else. */
function entryFiles() {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const found = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map(
    (m) => m[1],
  );
  // No roots means an empty closure, and an empty closure holds no page — the
  // invariant below would pass by having nothing to look at.
  if (found.length === 0) {
    console.error(`verify-chunks: index.html in ${DIST} loads no script`);
    process.exit(1);
  }
  return found;
}

/** @returns {string | undefined} the chunk emitted for a page, if there is one. */
function chunkOf(page) {
  return files.find((f) => f.startsWith(`${page}-`) && f.endsWith('.js'));
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

const missing = PAGES.filter((page) => chunkOf(page) === undefined);
if (missing.length > 0) {
  problems.push(`no chunk of its own: ${missing.join(', ')}`);
}

// Walk from index.html and from each page, because a page dragged in by
// another page is downloaded without being asked for just as surely as one
// dragged in by the entry — and the first invariant does not see it, since a
// module two chunks want keeps a chunk of its own.
const walked = [['index.html', entryFiles()]];
for (const page of PAGES) {
  const chunk = chunkOf(page);
  if (chunk !== undefined) walked.push([page, [chunk]]);
}

let entryClosureSize = 0;
for (const [owner, roots] of walked) {
  const reached = closure(roots);
  if (owner === 'index.html') entryClosureSize = reached.size;
  const strangers = PAGES.filter(
    (page) => page !== owner && reached.has(chunkOf(page) ?? ''),
  );
  if (strangers.length > 0) {
    problems.push(`${owner} downloads: ${strangers.join(', ')}`);
  }
}

if (problems.length > 0) {
  console.error('verify-chunks: the build stopped splitting per entry');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `verify-chunks: ${PAGES.length} pages each in their own chunk, none in another's closure or in the ${entryClosureSize}-file entry closure`,
);
