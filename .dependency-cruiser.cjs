/**
 * dependency-cruiser config — declarative architecture-boundary rules
 * (CI maximal-strictness guard suite, ADR 2026-06-01).
 *
 * The single declarative home for the repo's import-boundary rules. The
 * package-level import bans that used to be hand-rolled bash grep guards
 * (no-app-import-in-core / no-domain-import-in-collab / no-service-import-hono)
 * are migrated here — dependency-cruiser sees only real imports (not
 * comments), so it can't false-positive on a doc-comment naming a banned
 * alias the way the grep guards had to defend against. Guards whose mandate
 * is NOT a pure import edge live elsewhere: no-relative-import (import
 * SYNTAX, which the resolver erases), no-library-logger (a logger.* CALL),
 * no-raw-sql-outside-repo (a usage), no-library-env-access, etc. Those are
 * migrating from scripts/ to AST rules in eslint-rules/.
 * No circular-dep / orphan rules are enabled (separate opt-in).
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
/**
 * The web package's layer order, top to bottom. A layer may import anything
 * below it and nothing above it (docs/ARCHITECTURE.md "Layered architecture").
 *
 * The order stops at the bottom entry: `ui`, `components`, `theme`, `i18n` and
 * `lib` are one group at the same level, so importing across them is not a
 * direction violation — `lib/format-relative-time.ts` importing `@web/i18n` is
 * the shape that makes this explicit.
 */
const WEB_LAYERS = [
  ["app"],
  ["pages"],
  ["spaces"],
  ["features"],
  ["stores"],
  ["data"],
  ["ui", "components", "theme", "i18n", "lib"],
];

/**
 * Build one forbidden rule per web layer that has something above it.
 *
 * Generated rather than hand-written so the layer order exists once: six
 * hand-written rules would spell the list of layer names six times, and a
 * future reordering would have to land in all six.
 *
 * Two shapes in the emitted `to` pattern carry the whole rule:
 *   - `($|/)` rather than a trailing slash, because a barrel import has no
 *     slash after the layer name (`from '@web/stores'`). Three of the
 *     violations this guard was written for are exactly that shape.
 *   - the raw `@web/*` specifier rather than a resolved path, because this
 *     config declares no tsConfig, so aliases stay unresolved — the same
 *     mechanism `library-no-app-import` relies on.
 */
function webLayerRules() {
  const rules = [];
  for (let i = 1; i < WEB_LAYERS.length; i += 1) {
    const layer = WEB_LAYERS[i];
    const above = WEB_LAYERS.slice(0, i).flat();
    const name = layer.length === 1 ? layer[0] : "base";
    rules.push({
      name: `web-layer-${name}`,
      comment:
        `Frontend layered architecture (docs/ARCHITECTURE.md): ${layer.join(" / ")} ` +
        `sits below ${above.join(" / ")} and must not import it. Dependencies flow ` +
        `strictly downward. A lower layer needing a type that lives above it means ` +
        `the type is in the wrong place — move the definition down to the layer ` +
        `that owns the I/O or the state, or take it from @breatic/shared.`,
      severity: "error",
      from: { path: `^packages/web/src/(${layer.join("|")})/` },
      to: { path: `^@web/(${above.join("|")})($|/)` },
    });
  }
  return rules;
}

module.exports = {
  forbidden: [
    {
      name: "routes-no-data-layer",
      comment:
        "Prohibition #1 (route layer must not reach the data layer): a server route handler must call " +
        "a *.service, never a *.repo directly. The repo is the data-access " +
        "layer; the service owns the business logic. A route reaching a repo " +
        "skips the service layer. Route a read/write through the owning " +
        "module's service instead (add a thin service method if missing).",
      severity: "error",
      from: { path: "^packages/server/src/routes/" },
      to: { path: "\\.repo\\.(ts|js)$" },
    },
    {
      name: "server-no-sync-aigc",
      comment:
        "Prohibition #14 (no synchronous AIGC path; PROXY rule): heavy AIGC generation must " +
        "run async in the worker, never synchronously in a server request. " +
        "The only server modules allowed to import the AI SDK are the three " +
        "streaming entry points CLAUDE.md permits (Agent chat + memory " +
        "consolidation + Text mini-tool SSE). Any OTHER server file importing " +
        "ai / @ai-sdk / openai / @anthropic-ai is a new synchronous AIGC " +
        "surface — move it to the worker. This is a path proxy (allowlist of " +
        "3 files); a novel sync-AIGC shape still needs human review.",
      severity: "error",
      from: {
        path: "^packages/server/src/",
        pathNot:
          "packages/server/src/agent/main-agent\\.ts$" +
          "|packages/server/src/agent/memory-consolidator\\.ts$" +
          "|packages/server/src/modules/text-tool/text-tool\\.service\\.ts$" +
          "|\\.test\\.|\\.spec\\.|/__tests__/",
      },
      to: { path: "node_modules/(ai|@ai-sdk|openai|@anthropic-ai)/" },
    },
    {
      name: "library-no-app-import",
      comment:
        "Modular-monolith dependency direction (ADR 2026-05-31 + root " +
        "CLAUDE.md): library packages (@breatic/core, @breatic/shared, " +
        "@breatic/domain) must NOT import an application package " +
        "(@server / @worker / @collab / @web / @ingest). The direction is " +
        "app → domain → core/shared, never the reverse. Migrated from " +
        "lint-no-app-import-in-core.sh.",
      severity: "error",
      from: { path: "^packages/(core|shared|domain)/src/" },
      to: { path: "^@(server|worker|collab|web|ingest)/" },
    },
    {
      name: "collab-no-domain-import",
      comment:
        "ADR 2026-05-31 second revision (extracting @breatic/domain): collab depends on " +
        "core + shared ONLY; it must NOT import @breatic/domain (the " +
        "server+worker-only AIGC business — credit / task / node-history / " +
        "agent / model-catalog / canvas-lock). Migrated from " +
        "lint-no-domain-import-in-collab.sh.",
      severity: "error",
      from: { path: "^packages/collab/src/" },
      to: { path: "@breatic/domain|^@domain/|^packages/domain/(src|dist)" },
    },
    {
      name: "service-no-hono",
      comment:
        "Prohibition #2 (Service import hono): a domain service layer file " +
        "(*.service.ts) translates protocol-agnostic business logic and must " +
        "NOT import hono / @hono/* — the route layer owns the HTTP transport. " +
        "Migrated from lint-no-service-import-hono.sh.",
      severity: "error",
      from: { path: "^packages/.*\\.service\\.ts$" },
      to: { path: "node_modules/(hono|@hono)/|^hono($|/)|^@hono/" },
    },
    ...webLayerRules(),
  ],
  options: {
    // No tsConfig: the @server/* path aliases stay unresolved, but the
    // repo import specifier itself always ends in `.repo.js` (the alias
    // is `@server/modules/<mod>/<x>.repo.js`), so the prohibition-#1
    // `\.repo\.(ts|js)$` pattern matches the raw module string directly.
    // The AI-SDK packages (prohibition #14) resolve to their real
    // node_modules path via the default resolver. Loading the server
    // tsconfig here fails on its monorepo `extends`/`include` resolution,
    // and neither rule needs it.
    doNotFollow: { path: "node_modules" },
    // Tests are exempt (a route test may import a repo to seed/assert);
    // dist/ is built output, not source.
    exclude: { path: "\\.test\\.|\\.spec\\.|/__tests__/|/dist/" },
    // `import type` edges are off the graph by default, and three of the seven
    // web layer violation edges this suite was extended for were type-only.
    // Turning it on grows the graph with those edges and leaves the
    // package-boundary rules above at zero violations.
    tsPreCompilationDeps: true,
  },
};
