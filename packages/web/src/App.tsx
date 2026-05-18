/**
 * Web v14 — fresh start placeholder.
 *
 * 本 long branch `feat/web-builder-v1` 从 `main` reset 起步,layered 架构 / tokens /
 * 17 shadcn primitive / chrome / canvas / chat / mini-tool 全按 overview plan
 * 14 批 PR 逐步重写。当前只是空白 placeholder,等 PR 1 起步。
 *
 * 详:engineering/frontend-architecture.md + engineering/plans/2026-05-18-*.md
 */
export default function App() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#1c1917',
        background: '#fafaf9',
        gap: 12,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>breatic web v14</h1>
      <p style={{ fontSize: 14, color: '#78716c', margin: 0 }}>
        long branch <code>feat/web-builder-v1</code> · fresh start (reset 2026-05-18)
      </p>
      <p style={{ fontSize: 13, color: '#a8a29e', margin: 0 }}>
        PR 1 (shadcn primitives) 实施中
      </p>
    </div>
  );
}
