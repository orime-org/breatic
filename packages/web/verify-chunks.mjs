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
// Exits non-zero, naming what moved, when any of these breaks:
//   - every production page has a chunk of its own
//   - no page sits in a closure that is not its own — not index.html's, and
//     not another page's, which is the same "downloaded without being asked
//     for" in a different place
//   - no entry reaches the canvas, the document editor, the model runtime or
//     the rich-text editor, except the one page that renders a space
//   - the dev gallery, which is mounted only under `import.meta.env.DEV`, is
//     not in the build at all
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
  const named = [...src.matchAll(/lazyRoute\(\s*\(\)\s*=>\s*import\('([^']+)'\)/g)].map(
    (m) => m[1].split('/').pop(),
  );
  // A parse that reads twelve of thirteen entries covers twelve of them and
  // says nothing about the one it missed, so the count is checked against the
  // calls themselves rather than trusted.
  const calls = (src.match(/lazyRoute\(/g) ?? []).length;
  if (named.length !== calls) {
    console.error(
      `verify-chunks: ${ROUTES} makes ${calls} lazyRoute calls, ${named.length} of which this could read`,
    );
    process.exit(1);
  }
  return named;
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

/**
 * The transitive closure of the given files.
 * @param roots - Files to start from.
 * @param followDynamic - Which `import("./x")` targets to walk into, if any.
 * @param skip - Files to treat as already seen.
 * @returns {Set<string>} Every chunk reached.
 */
function closure(roots, followDynamic = () => false, skip = new Set()) {
  const seen = new Set(skip);
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !files.includes(file)) continue;
    seen.add(file);
    const code = readFileSync(path.join(ASSETS, file), 'utf8');
    // The spacing is the minifier's, and a build without it emits `from "./x"`.
    // A walk that only reads one of those spellings reaches nothing and reports
    // an empty closure as a clean one.
    for (const m of code.matchAll(
      /(?:^|[;\s}])(?:import|export)[^;]*?from\s*"\.\/([^"]+)"/g,
    )) {
      stack.push(m[1]);
    }
    for (const m of code.matchAll(/(?:^|[;\s}])import\s*"\.\/([^"]+)"/g)) stack.push(m[1]);
    for (const m of code.matchAll(/import\(\s*"\.\/([^"]+)"/g)) {
      if (followDynamic(m[1])) stack.push(m[1]);
    }
  }
  for (const file of skip) seen.delete(file);
  return seen;
}

/**
 * What no entry may download, and the page that is allowed to.
 *
 * A1, A12 and A13 are about what lands in a reader's download set, and the two
 * invariants above only answer which chunk a page sits in — a space body
 * reaching an entry through a shared chunk satisfies both. Rollup writes a
 * sourcemap beside every chunk (`vite.config.mts` sets `sourcemap: true`), and
 * its `sources` name every module that got in, so the set is readable here.
 */
const HEAVY = [
  { label: 'canvas', holds: (src) => src.includes('/src/spaces/canvas/') },
  { label: 'document editor', holds: (src) => src.includes('/src/spaces/document/') },
  { label: 'model runtime', holds: (src) => /node_modules\/(ai|@ai-sdk)\//.test(src) },
  {
    label: 'rich-text editor',
    holds: (src) => /node_modules\/(@tiptap|prosemirror)/.test(src),
  },
  // The engine, separately from our canvas source: `vite.config.mts` gives
  // `@xyflow` a manual chunk of its own, so a build where that chunk is shared
  // reaches every entry with zero `/src/spaces/canvas/` modules beside it —
  // 177 kB none of the four predicates above would have matched.
  {
    label: 'canvas engine',
    holds: (src) => /node_modules\/@xyflow\//.test(src),
  },
];

/**
 * The page that renders a space body, and may therefore hold one.
 *
 * Adding a second one turns this red, which is the point: a page that reaches
 * the canvas is a decision to state here, not one to make in passing.
 */
const RENDERS_A_SPACE = 'ProjectPage';

/**
 * Every module the given chunks were built from.
 * @param files - Chunk file names.
 * @returns {Set<string>} The source paths their sourcemaps name.
 * @throws {Error} When a chunk has no sourcemap, which would read as clean.
 */
function modulesIn(files) {
  const found = new Set();
  for (const file of files) {
    const map = path.join(ASSETS, `${file}.map`);
    if (!existsSync(map)) {
      throw new Error(`no sourcemap beside ${file}, so its modules cannot be read`);
    }
    for (const src of JSON.parse(readFileSync(map, 'utf8')).sources ?? []) {
      found.add(src);
    }
  }
  return found;
}

const problems = [];

// The dev gallery's import sits inside the `import.meta.env.DEV` ternary in
// routes.tsx, which a production build folds to false. Declared outside it,
// rollup emits a chunk nothing can ever ask for — and a route table reads the
// same either way, so this is the place the difference is visible.
const orphan = files.find(
  (f) => f.startsWith('PrimitivesGallery-') && f.endsWith('.js'),
);
if (orphan !== undefined) {
  problems.push(`the dev gallery shipped: ${orphan}`);
}

const missing = PAGES.filter((page) => chunkOf(page) === undefined);
if (missing.length > 0) {
  problems.push(`no chunk of its own: ${missing.join(', ')}`);
}

// Walk from index.html and from each page, because a page dragged in by
// another page is downloaded without being asked for just as surely as one
// dragged in by the entry — and the first invariant does not see it, since a
// module two chunks want keeps a chunk of its own.
const owners = [['index.html', entryFiles()]];
for (const page of PAGES) {
  const chunk = chunkOf(page);
  if (chunk !== undefined) owners.push([page, [chunk]]);
}

// The route split is exactly the entry's dynamic edges into page chunks: those
// are fetched once an address matches, so they are not what every reader
// downloads. Every other dynamic edge is eager — a module-scope `import(...)`
// runs the moment its chunk is evaluated — and following those is what makes
// a heavy module the entry pulls in on its own visible at all.
const pageChunks = new Set(
  PAGES.map((page) => chunkOf(page)).filter((chunk) => chunk !== undefined),
);
const entryRoots = entryFiles();
const entryStatic = closure(entryRoots);
const entryDownloads = closure(entryRoots, (file) => !pageChunks.has(file));

for (const [owner, roots] of owners) {
  // A page's walk follows every dynamic edge — a `React.lazy` inside a page
  // fires while that same screen renders, so the reader waits for it behind
  // the same loading screen — and excludes the entry's own closure, because
  // the entry chunk holds the dynamic import for every route and would
  // otherwise reach the whole graph from anywhere.
  const downloads =
    owner === 'index.html'
      ? entryDownloads
      : closure(roots, () => true, entryStatic);

  const strangers = PAGES.filter(
    (page) => page !== owner && downloads.has(chunkOf(page) ?? ''),
  );
  if (strangers.length > 0) {
    problems.push(`${owner} downloads: ${strangers.join(', ')}`);
  }

  if (owner === RENDERS_A_SPACE) continue;
  const modules = modulesIn([...downloads]);
  for (const heavy of HEAVY) {
    const got = [...modules].filter((src) => heavy.holds(src));
    if (got.length > 0) {
      problems.push(
        `${owner} downloads the ${heavy.label}: ${got.length} modules, e.g. ${got[0]}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('verify-chunks: the build stopped splitting per entry');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `verify-chunks: ${PAGES.length} pages each in their own chunk, none in another's closure or in the ${entryStatic.size}-file entry closure`,
);
