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
//   - no entry reaches any of the heavy things `HEAVY` below names, except
//     the one page that renders a space
//   - the entry closure stays inside its byte budget, which covers the heavy
//     things nobody has thought to name yet
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST = process.argv[2] ?? path.join(import.meta.dirname, 'dist', 'breatic');
const ASSETS = path.join(DIST, 'assets');
const ROUTES = path.join(import.meta.dirname, 'src', 'app', 'routes.tsx');
const ROUTE_IMPORTS = path.join(import.meta.dirname, 'src', 'app', 'route-imports.ts');

/**
 * The production pages, read from the loader module rather than listed here.
 *
 * A list written out in this file covers whatever it was written against: the
 * fourteenth entry gets added and this guard goes on passing without ever
 * having looked at it. Rollup names a chunk after its module's file, so the
 * basename of each `import()` specifier is the name to expect.
 *
 * Two counts are checked rather than trusted. A parse that reads twelve of
 * thirteen entries covers twelve of them and says nothing about the one it
 * missed; and a page whose loader exists but which no route renders would
 * never be downloaded at all, so the wiring is counted from both ends.
 * @returns {string[]} Page module basenames, in declaration order.
 */
function routeTablePages() {
  const loaders = readFileSync(ROUTE_IMPORTS, 'utf8');
  const named = [...loaders.matchAll(/=>\s*import\('([^']+)'\)/g)].map((m) =>
    m[1].split('/').pop(),
  );
  const declared = (loaders.match(/=>\s*import\(/g) ?? []).length;
  if (named.length !== declared) {
    console.error(
      `verify-chunks: ${ROUTE_IMPORTS} declares ${declared} loaders, ${named.length} of which this could read`,
    );
    process.exit(1);
  }
  const calls = (readFileSync(ROUTES, 'utf8').match(/lazyRoute\(/g) ?? []).length;
  if (calls !== named.length) {
    console.error(
      `verify-chunks: ${ROUTE_IMPORTS} declares ${named.length} loaders but ${ROUTES} makes ${calls} lazyRoute calls`,
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

const problems = [];
/**
 * Each page's chunk, matched by name prefix, read once.
 *
 * More than one file can carry a page's name — a page whose module is
 * `pages/x/index.tsx` is named `index`, which is also what the entry chunk is
 * called. Which one a `find` returns is decided by the content hash, so the
 * same source answers differently from one build to the next; naming the
 * ambiguity is what turns that into something readable.
 */
const chunkByPage = new Map(
  PAGES.map((page) => {
    const hits = files.filter((f) => f.startsWith(`${page}-`) && f.endsWith('.js'));
    if (hits.length > 1) {
      problems.push(`${page}: ${hits.length} chunks carry that name (${hits.join(', ')})`);
    }
    return [page, hits[0]];
  }),
);

/**
 * The chunk emitted for a page.
 * @param page - The page module's basename.
 * @returns {string | undefined} Its chunk, if the build emitted one.
 */
function chunkOf(page) {
  return chunkByPage.get(page);
}

/**
 * The transitive closure of the given files.
 * @param roots - Files to start from.
 * @param followDynamic - Which `import("./x")` targets to walk into.
 * @param skip - Files to treat as already seen.
 * @returns {Set<string>} Every chunk reached.
 */
function closure(roots, followDynamic, skip = new Set()) {
  const seen = new Set(skip);
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !files.includes(file)) continue;
    seen.add(file);
    const code = readFileSync(path.join(ASSETS, file), 'utf8');
    // Either quote: esbuild's minifier writes double, and a build with
    // `minify: false` writes single. A walk that reads only one spelling
    // reaches nothing and reports an empty closure as a clean one — measured,
    // an unminified build passed every check with zero edges walked.
    for (const m of code.matchAll(
      /(?:^|[;\s}])(?:import|export)[^;]*?from\s*(["'])\.\/([^"']+)\1/g,
    )) {
      stack.push(m[2]);
    }
    for (const m of code.matchAll(/(?:^|[;\s}])import\s*(["'])\.\/([^"']+)\1/g)) {
      stack.push(m[2]);
    }
    for (const m of code.matchAll(/import\(\s*(["'])\.\/([^"']+)\1/g)) {
      if (followDynamic(m[2])) stack.push(m[2]);
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
  // The canvas's state belongs to the canvas as much as its body does, and it
  // travels separately: importing the `@web/stores` barrel from anywhere drags
  // all of it in, which is how /login came to download the canvas, mini-tool
  // and inpaint stores plus zundo.
  {
    label: 'canvas',
    holds: (src) =>
      src.includes('/src/spaces/canvas/') ||
      /\/src\/stores\/(canvas|mini-tool|inpaint)\.ts$/.test(src),
  },
  { label: 'document editor', holds: (src) => src.includes('/src/spaces/document/') },
  { label: 'model runtime', holds: (src) => /node_modules\/(ai|@ai-sdk)\//.test(src) },
  {
    label: 'rich-text editor',
    holds: (src) => /node_modules\/(@tiptap|prosemirror)/.test(src),
  },
  // The engine, separately from our canvas source: `vite.config.mts` gives
  // `@xyflow` a manual chunk of its own, so a build where that chunk is shared
  // reaches every entry with zero `/src/spaces/canvas/` modules beside it —
  // 182 kB none of the four predicates above would have matched.
  {
    label: 'canvas engine',
    holds: (src) => /node_modules\/@xyflow\//.test(src),
  },
  // The collaboration runtime, which only a space body uses. It is named here
  // because `@breatic/shared` depends on it and that package's main entry is
  // one bundled module: an export the browser calls that reaches Yjs is
  // emitted in the entry chunk, and lib0 comes along behind it. Measured once,
  // at 88,224 bytes for every reader; the byte budget below caught that, and
  // this says which library arrived.
  //
  // Only `yjs` is matched. `lib0` arrives with it, so naming Yjs is enough to
  // catch the same regression, and this build already holds a second copy of
  // lib0 that has nothing to do with collaboration: `@blocknote/core` depends
  // on `lib0@1.0.0-rc.22` for its id generator while listing Yjs itself as
  // optional.
  {
    label: 'collaboration runtime',
    holds: (src) => /node_modules\/yjs\//.test(src),
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
 * @throws {Error} When a chunk has no sourcemap, which would read as clean. The
 *   caller turns it into a problem: this guard needs `sourcemap: true` in
 *   `vite.config.mts`, and that dependency is only visible when it breaks.
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

const missing = PAGES.filter((page) => chunkOf(page) === undefined);
if (missing.length > 0) {
  problems.push(`no chunk of its own: ${missing.join(', ')}`);
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
const entryDownloads = closure(entryRoots, (file) => !pageChunks.has(file));

// Every page chunk has to be reachable from the entry, or that route cannot
// load at all. It is also the one assertion that fails when the walk itself
// stops reading edges, which is how an unminified build used to pass every
// check with an empty graph.
const reachable = closure(entryRoots, () => true);
const unreachable = PAGES.filter((page) => !reachable.has(chunkOf(page) ?? ''));
if (unreachable.length > 0) {
  problems.push(`the entry cannot reach: ${unreachable.join(', ')}`);
}

// What each owner downloads. index.html's closure is the one computed above;
// a page's walk follows every dynamic edge — a `React.lazy` inside a page
// fires while that same screen renders, so the reader waits for it behind the
// same loading screen — and excludes the entry's own closure, because the
// entry chunk holds the dynamic import for every route and would otherwise
// reach the whole graph from anywhere.
//
// Both sides are walked because a page dragged in by another page is
// downloaded without being asked for just as surely as one dragged in by the
// entry, and the first invariant does not see it: a module two chunks want
// keeps a chunk of its own.
const owners = [['index.html', entryDownloads]];
for (const page of PAGES) {
  const chunk = chunkOf(page);
  if (chunk !== undefined) {
    owners.push([page, closure([chunk], () => true, entryDownloads)]);
  }
}

for (const [owner, downloads] of owners) {
  const strangers = PAGES.filter(
    (page) => page !== owner && downloads.has(chunkOf(page) ?? ''),
  );
  if (strangers.length > 0) {
    problems.push(`${owner} downloads: ${strangers.join(', ')}`);
  }

  if (owner === RENDERS_A_SPACE) continue;
  let modules;
  try {
    modules = modulesIn([...downloads]);
  } catch (e) {
    problems.push(`${owner}: ${e.message} — this guard needs \`sourcemap: true\``);
    continue;
  }
  for (const heavy of HEAVY) {
    const got = [...modules].filter((src) => heavy.holds(src));
    if (got.length > 0) {
      problems.push(
        `${owner} downloads the ${heavy.label}: ${got.length} modules, e.g. ${got[0]}`,
      );
    }
  }
}

// What every reader downloads, as a number rather than a list of names. The
// predicates above cover the heavy things known when they were written, and a
// number covers the ones nobody has thought of: measured, `pdfjs-dist` landing
// in a file that gates every route grew the entry chunk from 742,834 to
// 1,176,403 bytes with all five of them still green. The budget leaves room to
// grow and none to grow by a library; raising it is a decision to make on
// purpose. The closure's size on any build is the number this prints when it
// trips, so it is not repeated here to drift.
const ENTRY_BUDGET = 1_100_000;
const entryBytes = [...entryDownloads].reduce(
  (n, f) => n + statSync(path.join(ASSETS, f)).size,
  0,
);
if (entryBytes > ENTRY_BUDGET) {
  problems.push(
    `every reader downloads ${entryBytes} bytes of JS, over the ${ENTRY_BUDGET} budget`,
  );
}

// A page's hashed filename is written into whichever chunk holds an
// `import()` that reaches it, and that chunk has to change its own hash on
// every release that touches any page. Confining those specifiers to the one
// small loader chunk is what keeps the rest byte-identical — and nothing
// about `route-imports.ts` forces it, so this reads the built output instead.
// Measured while this was not held: a chunk naming pages cost a returning
// reader 1,079,379 unchanged bytes, and a preload helper that landed beside
// the loaders dragged the 1.8 MB canvas chunk along on every login-page edit.
const jsFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
const loaderChunk = jsFiles.find((f) => f.startsWith('route-imports-'));
if (loaderChunk === undefined) {
  problems.push('no route-imports chunk — the page specifiers are back inside another chunk');
} else {
  const pageChunkNames = new Set(
    PAGES.map((page) => chunkOf(page)).filter((c) => c !== undefined),
  );
  const heavyReaders = jsFiles.filter(
    (f) =>
      pageChunkNames.has(f) &&
      readFileSync(path.join(ASSETS, f), 'utf8').includes(loaderChunk),
  );
  if (heavyReaders.length > 0) {
    problems.push(
      `${heavyReaders.join(', ')} name ${loaderChunk}, which changes on every release — so they do too`,
    );
  }
}

if (problems.length > 0) {
  console.error('verify-chunks: the build stopped splitting per entry');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `verify-chunks: ${PAGES.length} pages each in their own chunk, none in another's closure or in the ${entryDownloads.size}-file entry closure`,
);
