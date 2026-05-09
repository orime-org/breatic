# Changelog

## 2026-05-09

- **F4-framework — schema-driven mini-tool floating menu + bottom toolbar (#TBD)**: spec mockup `2026-04-27-visual-language/05-canvas-native-tailwind.html`. New `packages/web/src/features/mini-tools/` module exporting `MiniToolProvider` / `useMiniTool` / `BottomToolbar` / `NodeFloatMenu` / `IMAGE_TOOLS`. `MiniToolContext` is the single source of truth for "what tool, on which node, with which params" — `pickTool(nodeId, toolId, ?values)` / `setValue(paramId, v)` / `clear()`. `NodeFloatMenu` renders the per-node tool button strip (`bg-neutral-900 p-1 rounded-md`); `BottomToolbar` floats absolute bottom-center inside the canvas surface and renders the matching parameter UI per `ParamConfig.ui` discriminator (slider / select / toggle — three controls inlined since they always render together). Schema-driven: `tool-schemas.ts` declares each tool with id (matches the server-side `imageToolSchema` discriminated union literal), modality, category, menu/title labels, and a typed param list — adding a tool = adding a row, no UI changes needed. F4-framework ships **5 Category B image tools** (remove-bg / upscale / sharpen / denoise / restore) the server already supports. Apply handler in `ProjectCanvasContent.handleMiniToolApply` runs three steps in one user action: (1) `createDataNode` spawns a sibling asset node at +360px right with `operation` + `operationParams` stamped, (2) connects source → sibling with a non-primary edge, (3) POSTs `/api/v1/mini-tools/image` with `target_node_id = sibling`. State transitions stay backend-driven (idle → handling → idle/error via NodeStateUpdateEvent → Hocuspocus → Yjs). `ImageNode` mounts `<NodeFloatMenu>` in a second NodeToolbar slot above the existing top toolbar, only when the node has an asset URL. **Category A** (instant frontend — crop / adjust / filter) and **video / audio tool rosters** intentionally not in this PR — they land in F4-categoryA together with the in-browser canvas-op runtime so the framework lands clean. Adds `tool-schemas.test.ts` (8 tests covering invariants — unique ids, in-options defaults, slider-range defaults, lookup hits/misses, empty / per-param `defaultValues`).
- **v13 canvas redesign — F1 + F2 (Yjs schema + GenerativeNode shell)**:
  - **F1 (#52) — Yjs schema v13**: `CanvasNodeFields.data` adds three audit-/lifecycle fields written once at node creation: `createdAt: number` (epoch ms), `createdBy: string` (userId), `locked: boolean` (default `false`; spec §10.13.6 — locked nodes block mini-tool / Worker writes / accidental deletes). Edges grow a per-edge `data` Y.Map carrying `isPrimary?: boolean` (spec §10.13.2 / §10.13.5 — at most one outgoing edge from a generative source has `isPrimary: true`; the invariant is enforced by frontend writers in F3). Pre-v13 nodes / edges fall back gracefully (`createdAt:0`, `createdBy:""`, `locked:false`, `isPrimary:false`). Adds `CurrentUserIdProvider` in `domain/user/` so `useCanvasActions` can stamp `createdBy` without prop drilling.
  - **F2 (#55) — GenerativeNode shell**: 480×320 three-segment node with reference rail (60px, derived from incoming edges + upstream lookup), prompt area (textarea mockup; F12 lands the Tiptap inline-atom-chip editor wired to the `prompt` Y.XmlFragment), and pill bar (60px — kind dropdown / model stub / credit stub / `▶ 新增版本` + `↻ 更新` buttons rendered with stub onClick handlers; F3 wires the atomic create + primary-edge bookkeeping + POST `/api/tasks`). `CanvasNodeFields.data` adds `outputType` / `kind` / `references`; `modelParams` is renamed to `params` to align with spec §10.13.2. Adds `ReferenceItem` / `ChipSnapshot` / `PromptInline` / `PromptDoc` types in `@breatic/shared`. Registers `generative` in `nodeTypes`. References Y.Array and prompt persistence are intentionally NOT initialized in F2 — F3 owns the edge↔refs sync; F12 owns the prompt write-through.
- **Playwright smoke harness (#54)**: `pnpm add -D playwright` in `packages/web` + `pnpm playwright install chromium` (browser binary cached at `~/Library/Caches/ms-playwright/`, not in repo). Adds `playwright.config.ts` (headless, baseURL `:8000`, externally managed dev server) and the first smoke spec `tests/smoke/web-loads.spec.ts` (app boots without console errors / page errors). New script `pnpm -F reagt-jike test:smoke`.
- **CLAUDE.md head-rule banner + post-checks (#51 / #53 / #55)**: A new top-of-file `# 头号原则 (MANDATORY)` banner pins the rule three times (`解决问题要找根因`) plus a pre-action self-check (#51), a post-action self-check that names the three failure modes — symptom moved / problem deferred / pretending to have solved it — with the rule to stop and ask if any of them applies (#53), and a third self-check requiring all-necessary-tests-and-doc-syncs after every task (#55).
- **Documentation realignment (#55)**: Yjs implementation spec updated to reflect the v13 schema added by F1 + F2 — new audit fields (`createdAt` / `createdBy` / `locked`), generative-only fields (`outputType` / `kind` / `references`), `modelParams` → `params` rename, `generative` node type, edge `data.isPrimary`. Ownership table extended with the new fields. (At the time these edits landed in `docs/YJS.md`; that file was subsequently moved to the private inner repo by #56.) This entry catches the previous rounds (F1 / playwright / banner / loop) that landed without CHANGELOG entries (now caught up alongside F2).
- **Public docs slimming (#56)**: deletes `docs/YJS.md` / `docs/FRONTEND.md` / `docs/PRODUCT.md` from the public repo and renames `CHANGELOG.md` → `docs/CHANGELOG.md`. Detailed Yjs / frontend / product specs live in the private inner repo from now on; the public repo keeps `DEPLOY.md` / `ROADMAP.md` / `CHANGELOG.md` / `DD-PROCESS.md` / `TDD-MANDATE.md`. `README.md` index, four CLAUDE.md inline references, two `docs/ROADMAP.md` links, and one `packages/core/src/db/schema.ts` doc-comment reference all updated to drop the now-private files (no "see internal docs" pointers — the public repo doesn't reveal the inner repo's existence).
- **CLAUDE.md head-rule fourth check (#57 / #58)**: head-rule banner adds the fourth post-check — every task, no matter how small, must first list a todo plan and re-verify against that plan after completion. #57 introduced the rule with a "tiny tasks exempt" carve-out; #58 dropped the exemption per user feedback that "task is too small to plan" is a recurring failure mode.
- **F7 — LeftFloatingMenu + NodesLibraryPanel(节点库入口)(#125)**: spec/02 §4.3 v13。`packages/web/src/features/canvas-left-menu/` 新模块 — vertical icon strip 浮在编辑区左缘(`left: 12px`,52px 宽,垂直居中),6 项分两组:① 节点库 toggle `NodesLibraryPanel`,② 上传(F5 stub),③ 批注(F6 stub),分隔线,④/⑤/⑥ Studio 资产 / 帮助 / 反馈三个 placeholder(tooltip + console hint,无 toast 噪音)。`NodesLibraryPanel` 是浮窗(`left: 68px`,280px,max-height 70vh),列 4 类 outputType(text/image/video/audio),点击触发 `useCanvasActions.createGenerativeNode({ outputType, kind, position })`,position 用 `flowCenterFromCanvasPane(screenToFlowPosition, 屏幕中心 fallback)` 取 viewport 中心(spec §10.13.7 决议)。关闭机制三路径(spec §4.3):① 点 panel 外、② 再次点 trigger、③ ESC — 通过 `use-outside-panel-close` hook + `data-panel-trigger` 标记避免 trigger 自身的 race。**删旧** `spaces/canvas/view/NodeLibraryPanel.tsx`(547 行,含旧 `1001/1002/1003/1004/6001/group` node type code + video editor 入口等遗留功能,跟 v13 不符);完整旧实现保留在私有内部仓的 web 备份内,不在公开仓存档以避免 dead code。`ProjectCanvasContent.tsx` 单行替换 `<NodeLibraryPanel />` → `<LeftFloatingMenu />`。视觉参考来自私有内部仓 `2026-04-27-visual-language` mockup 集合中的 canvas-native 设计稿。
- **F2-prompt — GenerativeNode prompt editor lands as Tiptap (#59)**: replaces the F2 textarea mockup with a Tiptap editor (`@tiptap/extension-collaboration` bound to the node's `data.prompt` `Y.XmlFragment`, so keystrokes sync to collaborators in real time). Adds a new shared `features/prompt-editor/` module exporting `PromptEditor`, the `Chip` atom node (extends `@tiptap/extension-mention`; chip attrs carry the full `ChipSnapshot` snapshot — chipId / sourceNodeId / sourceNodeType / snapshotName / snapshotThumbnail / snapshotContent / capturedAt — frozen at @-time per spec §10.13.2), and `buildMentionSuggestion` (wires `@`-trigger to a floating-ui-anchored picker in `SuggestionPicker.tsx`; mouse-only selection at this stage, keyboard navigation lands with F12). The pill-bar buttons disable when the editor is empty (`onEmptyChange` callback flips on every Tiptap update). Installs `@tiptap/extension-mention` (peer dep `@tiptap/y-tiptap` + `@tiptap/pm` + `@tiptap/suggestion` were already present from earlier StarterKit / Collaboration installs). StarterKit's `undoRedo` is disabled because Collaboration owns the Yjs UndoManager. Splits the prompt persistence work out of the F12 task (#130) into its own task #136 because F3's button onClick handlers depend on having Yjs-backed prompt data, and F12 (the left ChatPanel input) is per-user private (no Yjs binding) per `feedback_no_inner_doc_writes` / `project_chat_private_no_yjs` memory. Reference rail click-to-insert mockup is removed — the user now uses `@` inside the editor instead.
- **F3 — primary downstream + dual-button + atomic three-body create**: spec §10.13.4 / §10.13.5 / §10.13.7 v13 lands the GenerativeNode execute flow. `useCanvasActions` upgrades `createGenerativeNode` to atomically create the generative node + an initial primary asset child + the `isPrimary=true` edge in one Yjs transaction, and adds four helpers: `setPrimaryDownstreamEdge` (atomic primary swap — at most one outgoing edge per source carries `isPrimary=true` at every observable moment), `addAppendVersion` (▶ 新增版本 — sibling asset + non-primary edge), `addAppendVersionAsPrimary` (↻ no-primary degenerate path — sibling asset + primary edge, demotes other outgoing edges), and a `findPrimaryDownstream` derivation in `GenerativeNode`. References Y.Array sync runs in `onConnect` / `onEdgesChange` remove / `setEdges` / `deleteNodeAndEdges` (manual call, not silent observer — every edge mutation site is explicit). `CanvasSpaceManager` interface now exposes `projectId` + `spaceId` so deep components can build POST `/api/tasks` payloads without prop-drilling. `GenerativeNode` pill bar implements the dynamic dual button (`▶ 新增版本` always; `↻ 更新 ${primaryName}${🔒?}` when there's a primary, `✨ 新建` when there isn't, disabled when prompt is empty or primary is locked) plus a `▾` `Dropdown` listing all outgoing edges + a "无主下游" reset option. Click handlers POST to `/api/tasks` with `mode: 'append' | 'overwrite'` per spec §10.13.7; the worker takes it from there via the existing NodeStateUpdateEvent flow. Prompt-text extraction is naive (`fragment.toString()` + tag strip) — chip-aware serialization is a follow-up that lands when F12 polishes the chat panel and shares the extractor.

## 2026-05-07

- **Web restructure phase 1: extract layered architecture** (#29 / #30 / #31 / #32): three structural PRs land the foundation of the new web layer model (`ui ← data ← domain ← features ← spaces ← pages ← app`).
  - **#29 — `ui/` primitives + Direction B token scales**: 22 stateless primitive subdirectories moved from `components/base/` to `ui/` (button, checkbox, dialog, dropdown, icon, input, popover, select, slider, switch, tabs, tooltip, upload, etc.); 232 files' imports updated. `theme/light.css` + `dark.css` + `tailwind.config.ts` add the missing numeric scales (`brand.{50..900}` / `neutral.{0..900}` / `rounded.{sm,md,lg,xl}` / `text-scale`). Existing semantic tokens (`bg-brand-base` etc.) remain the recommended default — the numeric scales are additive
  - **#30 — `data/` layer extraction**: 23 IO modules moved out of `utils/`, `apis/`, and `hooks/` into `data/{yjs,api,stream,storage}/`. `data/yjs/` holds Yjs managers + the shared HocuspocusProviderWebsocket hook; `data/api/` holds 13 axios resource clients + `request.ts` + `token.ts`; `data/stream/sse.ts`; `data/storage/{oss-client,upload-blob}.ts`. Renames apply kebab-case (`miniTools.ts → mini-tools.ts`, etc.). 40 files' imports updated
  - **#31 + #32 — `domain/` business hooks**: project / space / user business hooks move out of `hooks/` and `contexts/` into `domain/{space,project,user}/`. `useYjsStore` renamed to `useProjectSpaces` (Yjs is the implementation; the orchestrator's role is managing the project's spaces)
- **Naming convention pinned**: React components `PascalCase.tsx` (= export name); React hooks `useFooBar.ts` (= export name); other `.ts` files `kebab-case`; directories `kebab-case`. Aligned with shadcn / Next.js / Airbnb conventions
- **Default Space seeded at project creation** (#27): `core/project.service.create` now atomically writes `projects` + `project_members` + `yjs_documents` (initial meta state with one canvas Space) inside one `db.transaction`. Establishes "project exists ⇒ at least one Space exists" as a transactional invariant. Eliminates the pre-v10 frontend bootstrap effect that POSTed `/spaces` after first sync
- **Shared websocket attach fix** (#27): `HocuspocusProvider` 3.4.4 only auto-attaches when it owns its own socket — when a shared `websocketProvider` is passed, `attach()` must be called explicitly. Without the fix, the canvas Space provider was constructed but never sent Auth/Subscribe; the meta doc connected via its own per-doc fallback socket and the canvas-{spaceId} doc never connected at all. `data/yjs/manager.ts` now calls `provider.attach()` in shared-ws mode; `data/yjs/use-socket.ts` builds the shared socket via `useMemo` (no first-render race)
- **v10 multi-doc Yjs layout** (#20 / #24 / #25): replaces the pre-v10 single-doc `project-{pid}/canvas` with `project-{pid}/meta` + `project-{pid}/canvas-{spaceId}` per Space. Hocuspocus auth keyed on `(projectId, userId, role)` from `project_members`; cross-process control plane on Redis pub/sub for member changes and Space create/delete events. Tasks now carry `spaceId` (NOT NULL) so worker output flows to the right canvas doc
- **Documentation realignment** (this PR): `docs/FRONTEND.md` rewritten to reflect the new layered structure + multi-doc Yjs. `docs/YJS.md` references updated from old `utils/yjs*.ts` paths to `data/yjs/`. `CLAUDE.md` adds web naming convention section + corrects "15 表" → "19 表" + clarifies that only `name` and `description` are strictly required in skill `metadata.json` (other fields default in `skills-loader.ts`). `docs/PRODUCT.md` aligns the metadata.json spec table. Deletes `packages/web/README.md` (CRA template + outdated naming rule), `docs/WORKTREE.md` (optional dev workflow, low value), `docs/FRONTEND_MINI_TOOL_FLOWS.md` (transitional doc with private memory references)

## 2026-04-30

- **Post-Phase 2 cleanup: delete imageEditor demo + update public docs** (branch `chore/post-phase2-cleanup-and-docs`): removes `packages/web/src/apps/project/components/canvas/dataNode/imageNode/imageEditor/` demo directory (the old Fabric.js + Excalidraw sub-canvas prototype that shipped Phase 1 but is superseded by canvas-native in Phase 2). Updates 5 public-facing docs to reflect Phase 2 architecture: `CLAUDE.md` (remove per-node lock, update event type, update doc naming, update node schema, add localPending note), `docs/YJS.md` (single doc naming `project-{id}`, new `data` Y.Map schema with all Phase 2 fields, NodeStateUpdateEvent replaces 3-event union, no-lock concurrency section, remove editor sub-doc sections), `docs/FRONTEND.md` (remove mixedEditor section, add canvas-native interaction model section, update node data attribution table, update zone table to 2 zones), `docs/ROADMAP.md` (Phase 2 canvas-native checkbox + PR-C mini-tool wiring scope), `CHANGELOG.md` (this entry + prior PR entries)

## 2026-04-29

- **PR-B web layer canvas-native alignment** (#14, branch `feat/yjs-editor-canvas-native-pr-b`): aligns the frontend with the Phase 2 canvas-native schema. Key changes: `useCanvasYjsInternal` reads new `data` Y.Map fields (`cover_url`, `errorMessage`, `width`, `height`, `duration`, `sourceNodeId`, `operation`, `operationParams`, `model`, `modelParams`, `childIds`); `useCanvasActions` exposes `createDataNode` / `createGenerativeNode` / `createEdge` / `deleteNodeAndEdges` / `setNodeState`; `LocalPendingProvider` tracks pre-Yjs placeholder nodes (browser-session, per-user); canvas types updated to `CanvasNodeFields["data"]` shape; `useUpstreamExternalFileList` and `ClipboardPasteHandler` adapted to new field names; removes `useActiveHistoryItem` hook (history-based schema gone); audio/image/video data-node components updated to read `cover_url` / `errorMessage` instead of legacy fields

## 2026-04-28

- **PR-A backend canvas-native forward-fix bundle** (#13): replaces the history-based node schema (HistoryItem / activeHistoryId / HistoryUpdateEvent) with the Phase 2 state-machine schema across `@breatic/shared`, `packages/core`, `packages/server`, `packages/worker`, and `packages/collab`. `@breatic/shared`: `CanvasNodeFields["data"]` gains `errorMessage` / `width` / `height` / `duration` / `sourceNodeId` / `operation` / `operationParams` / `model` / `modelParams` / `childIds`; `NodeEvent` union replaced by single `NodeStateUpdateEvent` with `targetNodeId: string` + `update: Partial<CanvasNodeFields["data"]>`; `HistoryItem` / `activeHistoryId` types removed. `packages/collab` task-listener: consumes `NodeStateUpdateEvent`, merges `update` into `data` Y.Map with field allowlist, removes lock-release logic. `packages/worker`: emits `NodeStateUpdateEvent` on success and failure (no separate `handling` / `completed` / `failed` events); supports `targetNodeIds: string[]` for 1:N output. `packages/server`: `POST /canvas/tasks` accepts `targetNodeIds`; per-node lock acquire/release removed; emits `node-state-update` event on task start. `packages/core`: removes `canvasLock.ts` helper; `NodeStateService` updated to use new event shape

## 2026-04-25

- **Restore tracked files dropped by 4-11 cutoff** (`dfc3544` + `eea202e`, branch `chore/restore-pre-cutoff-tracked-files`): the 4-11 commit-cutoff during repo migration skipped the commits that originally introduced 421 tracked files. They never appeared in any post-cutoff commit because no later commit re-touched these paths, so the new repo silently lost them even though they're git-tracked in the old one. CI was failing because `pnpm-workspace.yaml` was missing — `pnpm install` couldn't resolve `@breatic/*` packages. Two-step restore from old repo main HEAD: 11 root-level files first (`pnpm-workspace.yaml`, `eslint.config.mjs`, `tsconfig.base.json`, `.npmrc`, `.claudeignore`, `agents/*.md`, `logs/.gitignore`, `uploads.example/README.md`), then 410 remaining files (`.github/workflows/no-ai-attribution.yml`, `.husky/commit-msg`, all `config/models/*.yaml` ~30 model routing files, `config/{agent,collab,pricing,text-tools}.yaml`, `packages/shared/src/i18n/index.ts`, `packages/server/src/agent/{message-compressor,types}.ts`, server tooling configs). Post-restore content-hash diff vs old repo main: 0 byte-level differences across all shared files
- **CI workflow re-trigger** (`ed09c59`): single-line README touch to force GitHub Actions to re-run before the restore commits land — otherwise the previous failure status would persist as the latest CI signal
- **Repo rename `breatic_ai` → `breatic`** (#177): broad rename across docs, config, deployment manifests, and code references following the org repo rename. No behavior change
- **AI authorship policy refresh** (`f389ad4` + `6abd8d2`, plus #176 historical context): trim the AI Authorship Policy section in CONTRIBUTING/CLAUDE.md, lead with "AI assistance is fine", drop tool-specific exposure language. Net effect: shorter, more inviting AI-author guidance that doesn't pin specific tool names that may rotate
- **t3-phase6: frontend adapts to backend mini-tool migration** (#175): the final big PR closing T3 batch (frontend half). 9 staged commits land together — stage 1 frontend API scaffolding for multi-output; stage 2 group create button + handling delete guard; stage 3 video 7 ffmpeg.wasm handlers route to backend; stage 4a `image.crop` pure-frontend Canvas (X-pattern, no backend roundtrip for sub-100ms ops); stage 4b/4c `flipRotate` + `adjust` + `expand` upload PNG into Yjs instead of base64 data URLs (avoids Yjs payload bloat); stage 6a `handleUpscaleSend` wires up to backend; stage 6b remove-bg button now triggers `image.remove-bg`; stage 7 + 7b drop ffmpeg.wasm bundle entirely and ban Timeline Exporter UI entry. Net: image/video/audio editor stops bundling ffmpeg.wasm in the browser; all heavy ops go through the backend mini-tool path; sub-100ms ops (crop / flipRotate / adjust) stay pure-frontend per the front/back boundary rule

## 2026-04-24

- **T3 architecture migration — backend mini-tool framework, phase 1-5** (#164/#165/#166/#168/#169/#170/#172): 7-PR sequence migrating image/video editor heavy ops from frontend ffmpeg.wasm to backend worker handlers. **Phase 1** (#164) — groundwork-only, no behavior change: event bus routes by docName (`project-{id}/canvas` vs `project-{id}/node/{nodeId}`), mini-tool registry declares `kind: 'provider' | 'local'`, `runLocalHandler` scaffold (tempdir + download + spawn + upload). **Phase 2** (#165) — first worker-local handler `video/crop` end-to-end + unified `errorInfo` failure contract. **Phase 3** (#166) — first Node-library handler `image/crop` via Sharp, validates library-agnostic claim. **Phase 4a** (#168) — 6 non-AIGC handlers (image flipRotate / manual-adjust / expand, video stabilization / scene-extension / hdr-conversion) + tests. **Phase 4b** (#169) — 3 video visual-parity handlers replacing `videoEditor/*WithFfmpeg.ts`. **Phase 4c** (#170) — corrects Batch A misclassification: image crop / flipRotate / adjust are <10ms Canvas ops where the backend roundtrip turned instant ops into user-perceptible latency; reverted to frontend per `feedback_frontend_backend_boundary` rule. Also registers `image.graffiti` provider (user doodle composited into source + appended prompt → nano-banana-2-edit). **Phase 5** (#172) — unified N-output schema across worker/collab/server: all tasks always return `outputs: []` (N=1 is the degenerate case). Eliminates the single-output / multi-output dual code path that PR #172's description explicitly calls out as a CLAUDE.md #5 anti-pattern (compat shim / hybrid)
- **Video editor refinement** (#161/#162/#163/#173): consolidate Redux state for selection stability; reorganize panels / preview / timeline; fix undo-redo hit-area + timeline JSX layout; align canvas + panel interaction updates after the #144 full-workspace landing the day before
- **Breatic Open Source License v1.0 + community health** (#167): rewrite LICENSE as modified Apache 2.0 with 6 additional clauses — no public-facing deployment without authorization, logo + copyright preservation across ALL components (fixes prior `web/`-only scope), prospective-only license revisions, plus 3 more. Adds SECURITY.md and README community section. No code changes
- **Security docs polish** (#171/#174): switch to dedicated `security@breatic.ai` reporting address; SECURITY.md links to public BUGS.md for verifiable transparency

## 2026-04-23

- **Mixed editor PR-3/3 + follow-up refinement** (#141/#149/#150/#153/#155/#156/#157/#159/#160): closes the mixed-editor rewrite roadmap. **#141 (PR-3/3)** — X pattern for loading tiles (`state: 'handling'` no longer persists to Yjs, eliminates stuck-zombie failure when the originator's browser dies mid-task; heartbeat + force-cleanup machinery deleted in full); Apply-to-Node now targets the host (each tile's Apply writes only to the main-canvas node that opened the editor, never to siblings). **#156/#157** — `draggable` + `zIndex` moved from Yjs to local overlay state (semantically per-user UI: A entering edit mode was locking B's drag, latent time-bomb if rollback misfired). **#149** — restore toolbar visibility, revert dev proxy, add guard. **#150/#153** — QuickEdit / AiChatRecordPanel stale Redux reads throwing on canvas pick. **#155** — rename mixed editor state to align with main canvas semantics. **#159** — align resize semantics with each asset's dimensionality (image ≠ video ≠ audio). **#160** — clear pre-existing TS errors in AudioNode
- **Video editor: full workspace + stability** (#144/#152/#158): #144 ships the full video editor workspace — top bar / left media panel / preview canvas / right style panel / timeline editor; end-to-end editing (transform / crop / style, timeline clip ops, playback shortcuts, fullscreen preview, export flow). #152 stabilizes selection + playback. #158 stabilizes timeline + exporter pipeline
- **Workspace API double-unwrap bug** (#146): `request.ts` unwrapped `{ success, data }` once; `useWorkspaceApi` then unwrapped again — project list / create silently failed. Removed the second-layer helper; one unwrap path everywhere
- **Quick edit exit size + lip sync face labels** (#142): minor UX fixes carried over from #134/#139 work the day before
- **Bug audits round 6/7/8** (#143/#145/#147/#148/#151/#154): 19 + 5 + 8 new findings; close BUG-093/141/142/163/164/185; introduce `audit/fix-plans/` for P0 BUG-153 (ffmpeg CDN) + BUG-154 (blob URL) + BUG-173 (billing bypass). #154 documents BUG-185 audited + fixed in a 24-min lifecycle (both closed in one PR)

## 2026-04-22

- **Editor system overhaul: TextEditor + MixedEditor Yjs-first foundation** (#134/#135/#136/#138/#139/#140): three architectural PRs + feature extensions land together. **#138 (PR-1/3)** — new per-node-editor Yjs foundation (`yjsNodeEditorManager` + `nodeEditorYjsRef` + `useYjsNodeEditor`); TextEditor rewrite binds TipTap via `@tiptap/extension-collaboration` to per-node Y.Doc's `body` Y.XmlFragment; fixes the prior bug where TextEditor read `useMixedEditorStore` (wrong Redux slice — tracks mixed-editor sub-canvas, not main canvas), so edits were local-only and lost on refresh. **#140 (PR-2/3)** — fixes "Launch Editor → /login" on image/video/audio nodes (old code used `useYjsStore({ id: nodeId })` producing wrong docName `project-{nodeId}/canvas`; Hocuspocus auth then looked up project by node UUID, failed, emitted DocumentNotAuthorized, client redirected to /login). Migrates mixed editor to Yjs-first matching main canvas; deletes the 1071-line `useMixedEditorStore` + data-heavy Redux slice. Feature extensions: **#134** ships the full mixed-editor migration including video node workflows (cut / speed / erase / extend / animate / adjust / stabilization / crop) with ffmpeg-based export; new TextEditor capability set (slash menu, table controls, media blocks, AI menus, formatting). **#135** routes node type 1001 → TextEditor and 1002/1003/1004 → mixed ImageEditor; clarifies Vite dev proxy `/ws` key alignment with Yjs client path. **#136** HDR conversion + scene extension workflows. **#139** lip sync (with human voice detection) + audio denoise workflows
- **Pricing model: credits-only** (#129/#131): docs declare breatic is credits-only — no subscription / no membership tiers / no feature gating by tier. #131 removes the vestigial `membership_type` column from User and the subscription UI; new code does NOT feature-gate by tier, only by credit balance. `membershipType` / `membershipExpiresAt` on user object remain as legacy historical fields not to be relied on
- **Soft-delete cascade completeness** (#137): close BUG-141 + BUG-142 — schema gaps where `deleted_at` on parent didn't propagate filter to all child tables. Cascade chain now correct end-to-end
- **Billing hardening: cascade + deductOnce** (#126/#128): #126 Batch B fixes BUG-031 (deleteProject not cascading soft-delete) + BUG-033 (canvas task created before lock acquired → orphan task on conflict). #128 wires `deductOnce()` into 3 production charge paths (BUG-079) — same refKey can no longer double-charge
- **Bug audits round 4/5** (#127/#130/#132/#133): docs-only — round 4 closes 7 bugs + reports 33 new findings; round 5 closes BUG-044, reports 41 new, flags BUG-031 as incomplete (later fixed by #126 same day). #132 closes BUG-079 after #128 verification; #133 narrows BUG-147 scope after #131 removed membership_type

## 2026-04-21

- **Frontend uses relative URLs — kill `VITE_API_URL` / `VITE_WS_URL`** (#120): drop the Vite-build-time env vars and hardcoded full URLs; nginx serves `/api/*` and `/ws/*` from the same origin as the SPA, so axios and the Yjs client just use relative paths. Eliminates the entire class of misconfigured-domain bugs (apex vs www, http vs https, Docker container name vs public hostname) that #112/#113 had to defend against in env-var form
- **CI phase 2: GHCR image publishing + image-based deploy** (#121): build phase pushes images to ghcr.io with tags; deploy phase pulls + `docker compose up` instead of building on the prod host. Decouples build environment from prod environment, makes rollback a tag flip
- **CI: docker actions bumped to Node 24 majors** (#122): `docker/login-action` + `metadata-action` to first Node-24 majors (continuation of #118's Node 20 deprecation work)
- **Docs: deployment patterns for image-based flow** (#123/#124): `.env.docker` documents `BREATIC_TAG` env var + new pull+up Usage flow; `DEPLOY.md` documents the external-managed PostgreSQL + Redis topology (vs co-located in compose) — needed once images move to GHCR and prod no longer builds locally
- **Credit + payment hardening Batch A** (#125): BUG-047 + BUG-048 + BUG-052 + BUG-053 — race conditions and idempotency gaps in credit deduction / payment webhook handling

## 2026-04-20

- **CI: buildx + GitHub Actions cache** (#118): the docker job ran a bare `docker build` with no layer cache, so every run re-pulled `node:22-slim` from registry-1.docker.io and was vulnerable to any Docker Hub 5xx. Switched to `docker/build-push-action@v7` with `cache-from: type=gha` + `cache-to: type=gha,mode=max`. First successful build seeds the cache; subsequent builds skip the Docker Hub round-trip entirely. Typical CI time dropped from ~5-8 min to ~1-2 min
- **CI: Node 24 action bumps** (#118): GitHub is removing Node 20 from runners on 2026-09-16. Bumped `actions/checkout@v4→v6`, `actions/setup-node@v4→v6`, `actions/cache@v4→v5`, `pnpm/action-setup@v4→v6` — all first Node 24 majors. Header comment on `.github/workflows/ci.yml` links the runner deprecation timeline for future reference
- **nginx: canonical redirect was silently broken** (#117): PR #112 added `server_name _;` server blocks intending them as catch-all for apex hosts, but `_` is just a non-matching placeholder with no special semantics in nginx. Without the `default_server` directive, nginx falls back to the FIRST listener on the port — which was the `www`-regex block. Apex requests were being served by the www block (HTTPS apex returned 200 directly, HTTP apex 301'd to apex instead of www). Added `default_server` to both port-80 and port-443 apex blocks and reordered so the default appears first. Config comment now explains the gotcha
- **CLAUDE.md #5 tightened**: 彻底解决/禁止补丁 条款精简为 5 条规则 + 2 条动手前自检。新增硬性要求：方案未经用户确认前不动代码；方案不唯一时必须列权衡请用户选，不许自己拍板；自己拿不准时必须问，不许猜

## 2026-04-17

- **Auth hydration at store init** (#115): `userCenter` reducer now reads `localStorage.auth` in `loadInitialAuthInfo()` at module-import time, replacing the `useEffect` in `Workspace`. Deep links like `/project/<id>` no longer bypass hydration — Redux has the session token on the very first render, which was blocking Yjs from connecting (empty token → `enabled=false` → `addNode` silent no-op)
- **Canvas loading overlay removed** (#114): the project page already owns a top-level loading while `useYjsStore` syncs. The inner canvas-level overlay was redundant duplication
- **Yjs WebSocket session token auth** (#113, BUG-046): replaced the hardcoded `token: 'dev'` in `yjsManager.ts` with an explicit required `token` parameter plumbed from the Redux auth slice. `HocuspocusProvider.onAuthenticationFailed` calls `provider.disconnect()` + user-supplied callback to break the close→reconnect loop when Hocuspocus rejects the token in prod (`NoAccount` mode is dev-only)
- **Canonical domain (apex → www) + strict env** (#112): nginx serves only `www.*` and 301-redirects all other hosts, eliminating the localStorage split-brain between apex and `www`. Removed all silent fallbacks from `yjsManager.ts` and `request.ts` — missing `VITE_API_URL`/`VITE_WS_URL` now throws at startup so distributed deployments can't quietly misroute traffic
- **VITE_API_URL drops `/api` suffix** (#111): axios prepends `/api/v1/` itself; including it in the env caused `/api/api/v1/*` double-prefix 404s. `.env.docker` and `DEPLOY.md` updated accordingly
- **Frontend served from nginx root** (#110): removed the `/breatic/` Vite base path. Nginx already serves the SPA at `/`
- **Fail-fast connectivity check** (#108): API/Worker/Collab call `checkInfraReady()` at boot and exit immediately if PG/Redis are unreachable, with a clear error — prevents silent hangs
- **Independent migration service** (#107): `pnpm db:migrate` is now an explicit standalone step. Docker gets a dedicated `migrate` container that runs once and exits, decoupled from API/Worker startup. `dev` mode does not auto-migrate

## 2026-04-11

- **Canvas Yjs-first architecture**: flipped frontend data flow from Redux-first (500ms debounce + whole-array replace) to Yjs-first (direct Y.Map writes → observe → Redux read cache). Deleted `yjsStoreSync.ts` + `yjsSliceSyncs.ts` bridge. New: `useCanvasYjs.ts` observe hook, `canvasYjsRef.ts` module-level manager ref (#53)
- **Canvas Map-of-Maps structure**: replaced plain JS array `canvas.nodes` with `canvas.nodesMap: Y.Map<nodeId, Y.Map>` + `canvas.edges: Y.Map<edgeId, Y.Map>`. Each node is independent: prompt as Y.XmlFragment (TipTap-ready), attachments as Y.Array, params as Y.Map. O(1) node lookup, no cross-node interference (#51, #52)
- **Security audit (6 findings)**: Google JWT verification (#46), skill file-tool sandbox + SSRF blocklist (#47), cross-tenant ownership checks across REST + Collab layers (#48)
- **AIGC billing idempotency**: provider_result_url sentinel + billed_at CAS guard + no-retry-after-provider policy (#45)
- **Real project duplication**: `POST /projects/:id/duplicate` copies project row + all Yjs documents in a single transaction; fix projects API response envelope (#50)
- **Workspace API migration**: RecentProjects + UseCase components migrated from localStorage to projectsApi (#49)
- **Canvas node state sync**: API acquires Redis SETNX lock on `${env}:canvas:lock:*` (2h TTL) and publishes `handling` NodeEvent to `${env}:stream:canvas-nodes`; Worker publishes `completed` / `failed` on completion; Collab consumes via `nodesMap.get(nodeId).set(field, value)` direct Y.Map writes, releasing the lock on terminal events (#42)
- **Redis Streams transport**: migrated from Redis pub/sub to Streams for task-results / canvas-nodes event bus. Durable resume via persisted last-id; Collab restarts no longer drop in-flight events (#41)
- **Yjs document spec**: written-up Yjs spec (canvas Map-of-Maps shape, CanvasNodeFields / AttachRef types, ownership table, NodeEvent flow, undo/redo scoping, node lock semantics, PG persistence + Redis cross-instance sync) shipped at the time as `docs/YJS.md`; later moved to the private inner repo (#43, #51, #52)
- **Upload / node_history recovery**: cherry-picked PR #31 (unified asset upload) and soft-delete refactor back into main after they were lost during the git-filter-repo AI-authorship cleanup (#40)
- **Unified asset upload**: two-phase `/prepare` → PUT → `/complete` flow with presigned URLs for S3/OSS and a local fallback endpoint. Context routing: agent writes `conversation_attachments` with 50/conversation cap, canvas writes `node_history` silently, editor returns metadata only. Video cover extraction reused on complete (#31)
- **Soft-delete mandate**: migration 0005 adds `deleted_at` to conversations / tasks / skill_installs. Repo/service layer exposes `softDelete*()` methods; list queries filter `isNull(deletedAt)`. CLAUDE.md codifies the rule and points to CONTRIBUTING.md (#31)
- **node_history table**: migration 0003 + `GET /api/v1/canvas/nodes/:nodeId/history` lists per-node generation results (success + failed) and user uploads ordered by most recent. Worker writes `generation` entries, upload endpoint writes `upload` entries (#30)
- **AI authorship policy**: `.husky/commit-msg` + `.github/workflows/no-ai-attribution.yml` block author/co-author trailers that name Claude/Anthropic/GPT/Copilot/Cursor/ChatGPT/Codex. CONTRIBUTING.md explains the US copyright rationale (#33, #35)
- **Docs reorganized**: `docs/` for handwritten docs (DEPLOY/FRONTEND/PRODUCT/ROADMAP/WORKTREE/YJS); `api-reference/` for TypeDoc output (gitignored); root-level keeps README/CLAUDE/CONTRIBUTING/CHANGELOG/LICENSE. Fixed the pre-existing bug where `turbo run docs` silently ran nothing because `packages/server/package.json` had no `docs` script (#37, #38)

## 2026-04-09 (continued)

- **Storage unified in Worker**: transports return raw `{buffer, contentType}`, Worker handles all persist logic (buffer upload + CDN URL download → permanent storage). `storageKey()` uses structured `{userId, projectId, taskType, ext}` format (#20)
- **Model catalog streamlined**: ~102 → 50 models, removed cost-inefficient variants. Deleted 6 video transports, 3 TTS models, 4 3D models, 2 understand models (#21)
- **AIGC duration tracking**: `duration_ms` column on tasks table, `performance.now()` timing in Worker, exposed in API response (#22)
- **OSS storage verified**: Aliyun OSS upload end-to-end with CDN prefix `UPLOAD_BASE_URL`. Image (nano-banana-pro, 54s) + Audio (minimax-music-2.5, 119s) verified (#23)
- **WaveSpeed null param fix**: all 4 WaveSpeed transports strip null/undefined from request body; MiniMax lyrics fallback for instrumental mode (#23)
- **DB auto-migrate**: `runMigrations()` called at API + Worker startup, Drizzle lock table prevents concurrent conflicts (#24)
- **Docker image optimized**: 1.12GB → 357MB via `pnpm deploy --filter --prod` + `turbo --filter` (skip web build) (#25)
- **Nginx reverse proxy**: `Dockerfile.web` (73MB nginx:alpine), unified entry on port 80. Routes: `/api/*` → API, `/ws` → Collab, `/uploads/*` → API, `/*` → frontend SPA fallback (#26)
- **VITE_API_URL / VITE_WS_URL**: must be explicitly configured for all deployment scenarios (self-hosted, SaaS, local dev) (#26)

## 2026-04-09

- **AIGC pipeline end-to-end**: canvas/tasks → BullMQ → Worker → WaveSpeed API → download → local storage → permanent URL. Verified with z-image-turbo.
- **Local storage adapter**: `STORAGE_PROVIDER=local` (default), files stored in `uploads/{type}/{uuid}.ext`, served via `/uploads/*` static route
- **Storage refactor**: split monolithic storage.ts into `storage/index.ts` + `local.ts` + `s3.ts` + `oss.ts`. Each adapter implements `upload()` + `persistFromUrl()`
- **Credit recording**: always write to `credit_transactions` regardless of `PAYMENT_ENABLED`. New columns: `tokens_used`, `model`, `provider`
- **LLM routing fallback**: auto-fallback to OpenRouter when direct provider key (anthropic/google/openai) not configured
- **dotenv from root**: server loads `.env` from monorepo root, not `packages/server/`
- **Daily log rotation**: pino-roll, per-service directories (`logs/api/`, `logs/collab/`, `logs/worker/`)
- **Pre-commit hook**: `.husky/pre-commit` blocks `.env`, `.pem`, `.key` files from being committed
- **Google OAuth route**: `POST /api/v1/auth/google` — accepts Google ID token, returns session
- **i18n unified**: merged backend YAML + frontend JSON → root `locales/*.json`, shared by all
- **Assets API**: `POST /api/v1/assets/upload-url` supports S3 + Aliyun OSS presigned URLs
- **uploads.example/**: user renames to `uploads/` on setup (like `.env.example`)

## 2026-04-08

- **API integration**: shared Zod schemas (@breatic/shared), 8 domain-based frontend API files, `GET /api/v1/auth/me`, unified root `.env.example`
- **Model audit**: add Luma Ray 3.14, Wan 2.7, VEO 3.1 Lite, Tripo3D V3.1, Hunyuan3D V3.1 Pro; remove 8 more obsolete models; fix unverified model IDs
- **Model tiering**: 104 models tagged with tier (44 recommended / 48 optional / 12 internal)
- **Model catalog API**: `GET /api/v1/models` — full catalog grouped by modality, filtered by API key availability
- **Model cleanup**: removed 37 obsolete models superseded by newer versions (141 → 104)

## 2026-04-07

- **AIGC model updates**: PixVerse V6, Luma Ray 3, Fish S2 Pro added; Sora removed (shut down)
- **Agent layer**: SubAgent separated from Skill — `agents/*.md` defines role, `skills/` defines knowledge
- **AsyncLocalStorage**: request context shared across MainAgent + SubAgents (memory, history, userId)
- **SubAgent context**: inherits 3-layer memory + compressed conversation history
- **SubAgent billing**: direct credit deduction (removed text footer hack)
- **exec → run_script**: sandboxed script execution, path traversal prevention
- **Turn-based memory**: turnIndex, memory_window by turns (20), old turn compression, thinking storage
- **Model config externalized**: default_model, consolidation_model → agent.yaml; text tool model → text-tools.yaml
- **DevOps**: Dockerfile, docker-compose, DEPLOY.md, GitHub Actions CI
- **FRONTEND.md**: architecture analysis of web package

## 2026-04-02

- **Skill scope system**: metadata.json `scope` field (agent / canvas)
- **Agent skills**: creative_research, brainstorm, prompt_engineer
- **SubAgent as spawn tool**: AI SDK parallel execution, prevents recursive spawn
- **LLM billing**: 3 paths (AIGC by cost / Text tools by token / Agent chat by token)
- **Memory consolidation**: auto-summarize at memory_window threshold

## 2026-04-01

- **TypeScript full-stack migration**: Python 23K → TypeScript 15K lines
- **Hocuspocus**: independent collab service with PG persistence + Redis sync
- **Stripe**: Checkout integration, 5 pricing tiers, webhook verification
- **Text mini-tools**: 10 AI text tools, SSE streaming, per-user lock
- **Unit tests**: 105 tests, all services covered
- **Worker**: BullMQ with YAML config (concurrency, retries, polling)

## 2026-03-27

- **Understand provider**: vision → understand rename, Whisper ASR, transcribe mode
- **Mini-tool APIs**: image (10 tools), video (7), audio (5), unified to 3 endpoints
- **Skill boundaries**: mode filtering, vision_analyze repositioned

## 2026-03-26

- **Audio/TTS/3D providers**: dual-layer architecture unified across all modalities
- **TTS voice catalog**: 99 voices (ElevenLabs 52 + MiniMax 17 + Gemini 30)
- **Config rename**: providers/ → models/

## 2026-03-24

- **Video provider**: 11 model families, 90 models, 8 modes, 10 providers
- **Video transports**: 9 official APIs + shared retry/polling utilities
- **Image YAML reorganization**: by model family (not by mode)
- **Direct execution**: AIGC tasks skip LLM when params are complete

## 2026-03-23

- **Image post-processing**: Topaz upscale/sharpen/denoise/restore/adjust, bg-remover
- **Credit system**: per-API-call billing (cost × multiplier), transport returns cost
- **Parameter validation**: lenient mode (unknown params dropped, invalid values fallback)

## 2026-03-21

- **Image provider dual-layer**: models/ (prompt formatting) + transports/ (HTTP)
- **Nano Banana LLM prompt**: DeepSeek V3 auto-enhancement, +17% quality
- **Dynamic skill model injection**: YAML-driven, API key filtered

## 2026-03-20

- **LLM provider**: LiteLLM integration, 100+ providers, 10 models × 5 providers
- **Image models**: 11 t2i + 9 edit models, 4 providers

## 2026-03-18

- **Model-centric routing**: YAML per model, multi-provider with priority
- **AIGC concurrency control**: per-provider semaphore + 429 backoff
- **Agent config**: migrated to agent.yaml

## 2026-03-17

- **Architecture restructure**: 16 packages → 10
- **Skill system**: built-in only, auto-injected tools
- **Memory system**: 3-layer LLM rewrite (not append)
- **AIGC CLI scripts**: per-modality generate scripts
