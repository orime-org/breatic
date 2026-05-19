# Frontend

Public overview of `packages/web/` — the breatic React app served at the
browser. For backend, see `packages/{shared,core,server,worker,collab}/`.

## Status

The web package is being rewritten on a long-lived branch
(`feat/web-builder-v1`). `main` still carries the prior implementation;
the rewrite lands when the branch is feature-complete.

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
| i18n | i18next (zh-CN / en / ja / zh-TW) |
| Routing | React Router 7 |
| Test | Vitest + Playwright + @testing-library + fast-check |
| Monitoring | Sentry |

## Run

```bash
# from monorepo root
pnpm dev           # starts api / worker / collab / web (web on :8000)
pnpm -F reagt-jike dev          # web only
pnpm -F reagt-jike test         # vitest
pnpm -F reagt-jike test:smoke   # Playwright e2e
pnpm -F reagt-jike build        # vite build → dist/breatic/
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
i18n/       react-i18next setup + locale JSON files
lib/        utils (cn, format, env, analytics)
```

## Key conventions

- **shadcn 100%** — every primitive in `components/ui/` is shadcn/ui (Radix
  underneath). No Headless UI, no MUI.
- **Token bridge** — shadcn standard tokens (`--primary`, `--border`, etc.)
  are aliased to project neutral / status palettes in
  `src/theme/shadcn-bridge.css`. Stone-warm neutral 11-step + 5 always-color
  status palettes + radius cap 6px + brand reserved for logo.
- **Yjs single source of truth** — canvas node data and space metadata flow
  through Yjs (`data/yjs/`). The frontend owns node create / delete /
  position; the backend only updates `data` fields.
- **ChatPanel is per-user, not Yjs-bound** — agent conversations stream via
  SSE, scoped to the viewer; chat content never enters Yjs.
- **Canvas node matrix** — nodes follow a `kind × modality` grid: 4
  modalities (text / image / audio / video, with 3D / web to come) × 2 kinds
  (asset / generator). Generators auto-create a downstream asset + primary
  edge on creation.

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
│   ├── theme/               # tokens.css + shadcn-bridge.css
│   ├── i18n/                # react-i18next + locales
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
| `VITE_LOGIN_MODE` | Login mode (must match backend) |
| `VITE_APP_VERSION` | App version string |
| `GOOGLE_CLIENT_ID` | Google OAuth (optional; injected as `__GOOGLE_CLIENT_ID__`) |
| `VITE_SENTRY_DSN` | Sentry DSN (optional) |
