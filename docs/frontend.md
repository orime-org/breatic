# Frontend

Public overview of `packages/web/` — the breatic React app served at the
browser. For overall architecture (6 packages + 3 services) see
[architecture.md](./architecture.md).

> **Industrial-grade mandate vs. detail.** The *constraints* `web` must
> satisfy — TS strict / zero `any`, the `app → pages → spaces → features →
> stores → domain → data → ui` single-direction layering, critical-path &
> invariant tests, a11y, i18n (ICU), strict design tokens — are stated as a
> mandate in [CLAUDE.md](../CLAUDE.md) "前端工业级标准". This document holds
> the *implementation detail* of those constraints (naming, the node model,
> token bridging, the shadcn vendor boundary, and the specific traps). When a
> rule must be enforced it belongs in CLAUDE.md; how it is done belongs here.

## Status

v14 greenfield rewrite landed on `main` 2026-05-19 (PR #103). Visual
alignment to the design-baseline mocks is ongoing on the long-lived
branch `feat/web-visual-alignment`.

## Tech stack

| Layer | Tech |
|---|---|
| Framework | React 19 + TypeScript 5.6 |
| Build | Vite 5 |
| UI primitives | shadcn/ui (Radix + Tailwind) |
| Styling | Tailwind CSS 3.4 + CSS variables (light / dark via `data-theme`) |
| State | Zustand 5 + immer (zundo for undo-capable stores) |
| Collab | Yjs 13 + @hocuspocus/provider 3 (sync-first, no offline) |
| Canvas | @xyflow/react 12 |
| Rich-text editor | TipTap 3 |
| Audio / Video | WaveSurfer.js / video.js |
| 3D | Three.js + @react-three/fiber |
| Data fetching | Axios + @microsoft/fetch-event-source (SSE) + React Query |
| i18n | `intl-messageformat` (ICU) via shared `t()` + `useTranslation` hook (en / zh-CN / zh-TW / ja) |
| Routing | React Router 7 |
| Test | Vitest + Playwright + @testing-library + fast-check |
| Monitoring | Sentry |

## Run

```bash
# from monorepo root
pnpm dev           # starts api / worker / collab / web (web on :8000)
pnpm -F @breatic/web dev          # web only
pnpm -F @breatic/web test         # vitest
pnpm -F @breatic/web test:smoke   # Playwright e2e
pnpm -F @breatic/web build        # vite build → dist/breatic/
```

## Layered architecture

Dependencies flow strictly downward; lower layers never import upper ones:

```
app/        Vite entry · Router · Providers · ErrorBoundary
pages/      Route pages + page-scoped sub-modules (chrome / chat / members / tweaks)
spaces/     Canvas / Document / Timeline body implementations (open enum)
features/   True cross-page modules (auth / error-boundary / preferences)
stores/     Zustand stores (one file per store, no cross-imports)
domain/     Pure business logic (state machines, permissions, hooks)
data/       I/O boundary (api / yjs / stream / storage)
ui/         Cross-feature business atoms (Avatar, StatusBadge, etc.)
components/ui/  shadcn primitives (vendor; ESLint-ignored)
theme/      tokens.css + shadcn-bridge.css + tailwind extensions
i18n/       locale-bootstrap + useTranslation hook (engine in @breatic/shared/i18n)
lib/        utils (cn, format, env, analytics)
```

## Key conventions

- **shadcn 100%** — every primitive in `components/ui/` is shadcn/ui (Radix
  underneath). No Headless UI, no MUI.
- **Single token source** — all design tokens (neutral / status / brand /
  shadcn alias / chrome UI scale) live in `src/theme/tokens.css`. shadcn
  primitives consume the standard aliases directly; no separate bridge
  file. Stone-warm neutral 11-step + 5 status palettes (each bg/fg/border)
  + radius split (chrome fixed 6px + content sm/md/lg/xl) + brand reserved
  for logo only (`--brand-logo-primary`).
- **Yjs single source of truth** — canvas node data and space metadata flow
  through Yjs (`data/yjs/`). The frontend owns node create / delete /
  position; the backend only updates `data` fields.
- **ChatPanel is per-user, not Yjs-bound** — agent conversations stream via
  SSE, scoped to the viewer; chat content never enters Yjs.
- **Hover pattern standard** — Tailwind `hover:bg-<token>/<2-digit>` alpha
  modifiers (e.g. `hover:bg-accent/40`, `hover:bg-primary/90`) are banned
  in `packages/web/src/`. Use either a solid token swap
  (`hover:bg-accent`, `hover:bg-muted`) for transparent-default rows /
  outline / ghost buttons, or `transition-opacity hover:opacity-90` for
  solid CTA buttons. Enforced by `pnpm lint:hover` (CI hard-fail) +
  shadcn primitive defaults in `components/ui/`. Rationale: alpha hovers
  blend with the underlying surface so contrast depends on context;
  solid swaps + opacity-90 match the chrome-baseline mock and are
  visually consistent across surfaces.
- **Unified type nodes (2026-05-19)** — one node per modality:
  `text` / `image` / `audio` / `video` / `3d` / `web` (6 content types)
  plus `annotation` (standalone collaboration sticky). No asset/generator
  split. `@`-references are edge relations + snapshot copies, NOT a node
  type. Generation lives in the node toolbar's left zone (edits the
  current node); mini-tools live in the right zone (create a new sibling
  node + primary edge).

## Naming conventions

| File type | Naming | Example |
|---|---|---|
| React component `.tsx` | `PascalCase` (= export name) | `Button.tsx` `ProjectMembersPanel.tsx` |
| React hook `.ts/.tsx` | `useFooBar` (= export name) | `useProjectSpaces.ts` `useCanvasActions.ts` |
| Other `.ts` (util / data / config / store) | `kebab-case` | `mini-tools.ts` `oss-client.ts` |
| Test | Same as subject + `.test` | `useProjectSpaces.test.ts` |
| Directory | `kebab-case` | `data/yjs/` `domain/space/` `features/project-members/` |

## Routing

- `/` → `/studio`
- `/studio` — project list / new project
- `/project/:projectId` — project page (Agent column + Space outlet)
- `/project/:projectId/space/:spaceId?` — explicit space selection
- `/login`, `/reset-password`

## Source layout

```
packages/web/
├── public/                  # static assets served as-is
├── src/
│   ├── app/                 # entry + providers + error boundaries
│   ├── pages/               # route pages + page-scoped sub-modules
│   ├── spaces/              # Canvas / Document / Timeline
│   ├── features/            # cross-page features
│   ├── stores/              # Zustand stores (one file per store)
│   ├── domain/              # pure business logic
│   ├── data/                # api / yjs / stream / storage
│   ├── ui/                  # business atoms
│   ├── components/ui/       # shadcn primitives (vendor)
│   ├── theme/               # tokens.css (single token source)
│   ├── i18n/                # locale-bootstrap + useTranslation (engine in @breatic/shared/i18n)
│   ├── lib/                 # utils (cn, etc.)
│   ├── styles/              # global css overrides
│   ├── App.tsx · index.tsx · index.css · index.html
├── tests/                   # Playwright e2e
├── components.json          # shadcn config
├── tailwind.config.ts · vite.config.ts · tsconfig.json · postcss.config.js
└── package.json
```

## Environment variables

All `VITE_*` variables load from the monorepo root `.env`. The frontend
talks to backend via relative URLs (`/api/*`, `/ws`, `/uploads/*`); a single
reverse proxy (nginx in production, Vite dev proxy in dev) routes them to
the api / collab containers. The built bundle has no host baked in.

| Variable | Purpose |
|---|---|
| `VITE_APP_VERSION` | App version string |
| `GOOGLE_CLIENT_ID` | Google OAuth (optional; injected as `__GOOGLE_CLIENT_ID__`) |
| `VITE_SENTRY_DSN` | Sentry DSN (optional) |

Authentication is cookie-based — the backend sets an httpOnly
`breatic_session` cookie on login / register / OAuth; the frontend
does not read or persist any token in JS. See
`docs/architecture.md` for `COOKIE_DOMAIN` + `EMAIL_BACKEND`
(server-side env vars).
