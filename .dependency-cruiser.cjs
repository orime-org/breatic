/**
 * dependency-cruiser config — declarative architecture-boundary rules
 * (CI maximal-strictness guard suite, inner ADR 2026-06-01).
 *
 * Only two forbidden rules live here (prohibition #1 + #14). The existing
 * hand-rolled import bash guards (no-app-import-in-core / no-relative-import
 * / …) are intentionally NOT migrated into this file yet — that
 * consolidation is a separate, larger change (backlog). No circular-dep /
 * orphan rules are enabled here to keep the surface to exactly the two
 * mandates this guard adds.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "routes-no-data-layer",
      comment:
        "Prohibition #1 (路由层不碰数据层): a server route handler must call " +
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
        "Prohibition #14 (AIGC sync 路径, PROXY): heavy AIGC generation must " +
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
    // Tests are exempt (a route test may import a repo to seed/assert).
    exclude: { path: "\\.test\\.|\\.spec\\.|/__tests__/" },
  },
};
