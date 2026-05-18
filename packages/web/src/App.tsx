/**
 * Web v14 fresh start placeholder.
 *
 * The `feat/web-builder-v1` long branch was reset from `main` (2026-05-18).
 * Layered architecture / tokens / 17 shadcn primitives / chrome / canvas /
 * chat / mini-tool are rebuilt across 14 PRs per the overview plan.
 *
 * See: breatic-inner-design/engineering/frontend-architecture.md
 *      breatic-inner-design/engineering/plans/2026-05-18-*.md
 */
export default function App() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
      <h1 className="text-2xl font-semibold">breatic web v14</h1>
      <p className="text-sm text-muted-foreground">
        long branch <code>feat/web-builder-v1</code> · fresh start (reset 2026-05-18)
      </p>
      <p className="text-xs text-muted-foreground">
        PR 1 (shadcn primitives) in progress
      </p>
    </div>
  );
}
