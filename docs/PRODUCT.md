# Breatic — Product Design

**An AI operating system for content creators.**

---

## 1. Product Overview

Breatic is the AI-native operating system for content creators — a unified workspace where AI agents plan, generate, and edit multimodal content (image, video, audio, 3D, text) through natural language. All creative assets live on a shared infinite canvas where teams collaborate in real time.

---

## 2. Interface Layout

The frontend is divided into three panels:

```
┌──────────────┬─────────────────────────┬──────────────────┐
│  Agent Panel │     Canvas Panel        │  Editor Panel    │
│  (Left)      │     (Center)            │  (Right)         │
│              │                         │                  │
│  Private     │  Shared (Yjs)           │  Context-        │
│  chat with   │  ReactFlow nodes        │  sensitive       │
│  AI agent    │  + edges                │  editing tools   │
│              │                         │                  │
│  Brainstorm  │  Show generation        │  Appears when    │
│  & plan      │  status                 │  a node is       │
│              │                         │  selected        │
└──────────────┴─────────────────────────┴──────────────────┘
```

### 2.1 Agent Panel (Left)

- Private per-user chat sessions. User A cannot see User B's conversations.
- Purpose: brainstorm ideas, generate creation plans via AI.
- The AI Agent calls Skills (e.g. `generate_image_plan`) to produce structured task plans.
- User reviews the plan and clicks "Confirm" to create a Canvas node.
- Agent Panel always outputs **parameter mode** plans — explicit model + params.

### 2.2 Canvas Panel (Center)

- Shared ReactFlow infinite canvas, synced across all collaborators via Yjs.
- Nodes represent content: image, video, audio, text, 3D.
- Nodes have **edges (connections)** expressing creative lineage (e.g. a storyboard script node → connected image/video nodes it produced).
- Each node shows generation status (queued, generating, completed, failed).
- Nodes have **action buttons** above them (e.g. understand/analyze).
- Each generation node has a **parameter mode / intelligent mode toggle**.
- Backend is **unaware** of Canvas/ReactFlow/Yjs state — it only receives task requests and pushes results via SSE.

### 2.3 Editor Panel (Right)

- Appears when a user selects a Canvas node.
- Content and tools change based on the selected node type.
- Does **not** use multi-turn Agent chat.

---

## 3. Collaboration Model

| Scope | Visibility | Sync Mechanism |
|---|---|---|
| Agent Panel conversations | **Private** per user | Server-side, per-user session |
| Canvas nodes and edges | **Shared** across all collaborators | Yjs (CRDT) |
| Editor state | **Per-user** (follows selected node) | Local |
| Generation results | **Shared** via Canvas | SSE → client writes Yjs |

---

## 4. Content Creation Flow

### 4.1 Agent Panel → Canvas (Parameter Mode)

```
User describes what they want in Agent Panel chat
  → "Create a cyberpunk city at night, 16:9, high quality"
  ↓
MainAgent calls generate_image_plan Skill
  → LLM selects model (nano-banana-pro), params (aspect_ratio: 16:9, resolution: 2k)
  → Outputs structured plan JSON
  ↓
User reviews plan, clicks "Confirm"
  ↓
Frontend creates ReactFlow node on Canvas (loading state)
  → POST /canvas/tasks → backend
  ↓
ARQ Worker executes: validate_params() → generate_async()
  → Result via Redis Pub/Sub → SSE → frontend
  ↓
Canvas node updates with generated image
  → All collaborators see it via Yjs sync
```

### 4.2 Canvas Node — Two Execution Modes

Each generation node (image/video/audio/3D) has a **toggle** that users can freely switch:

| Mode | Input | Who selects model/params | Backend Path |
|---|---|---|---|
| **Parameter Mode** | User selects model, aspect ratio, resolution, etc. | User (or Agent plan) | `_run_aigc_direct()` — direct provider call |
| **Intelligent Mode** | User writes natural language + optional @ references + optional ratio | AI (LLM in Skill) | Skill agent → LLM auto-selects model + params → execute |

**Intelligent Mode interaction:**

```
Node input box:
  /generate-image a cyberpunk knight @ref_style.jpg 16:9

Parsed:
  - skill: generate_image_plan (user-selected or auto-matched)
  - prompt: "a cyberpunk knight"
  - references: [ref_style.jpg] (@ reference)
  - aspect_ratio: 16:9 (explicitly chosen)
  - everything else: AI decides (model, resolution, style params, etc.)
```

**Key principles:**
- Default to AI selection, allow user override — minimum choices for the user
- Agent Panel always produces parameter mode plans
- Both modes exist on the node itself as a toggle
- Both ultimately produce the same task execution, just different input paths

### 4.3 Canvas Node Actions

Quick-action buttons displayed above selected Canvas nodes:

| Action | Trigger | Endpoint | Result |
|---|---|---|---|
| **Understand** | Button above image/video/audio nodes | `POST /canvas/understand` | Creates a new **text node** with analysis/transcription |

The understand action supports:
- **Image understanding** (vi) — describe content, reverse-engineer prompts, extract style
- **Video understanding** (vv) — describe scenes, analyze camera movement
- **Audio understanding** (va) — describe music style, identify instruments
- **Transcription** (transcribe) — speech-to-text via Whisper ASR

Auto-selects model based on source node type (image → gemini-flash-vi, video → gemini-flash-vv, audio → gemini-flash-va). User can override with a specific model.

These are not Agent Panel features and not Editor tools — they are Canvas-level node actions.

---

## 5. Editor Panel

### 5.1 Editor Modes by Node Type

| Node Type | Editor UI | Example Tools |
|---|---|---|
| **Text** | Feishu-doc-like rich text editor | AI polish, expand, summarize, translate, rewrite, continue, generate, character descriptions, storyboard (table mode), script/dialogue |
| **Image** | ReactFlow without edges (tool palette) | Inpainting, background removal, upscale, sharpen, denoise, restore, adjust, relight, multi-angle, text edit |
| **Video** | Tool palette | Frame interpolation, upscale, extend, edit, motion, animate, talking head |
| **Audio** | Tool palette | Sound effects, TTS, voice clone, vocal separation, audio extend |
| **3D** | 3D viewer + tools | Texture edit, format conversion |

### 5.2 Editor Execution Model

Mini-tools in the Editor use **two execution paths** based on complexity:

| Complexity | Examples | Execution |
|---|---|---|
| **Simple** (no LLM) | Background removal, upscale, flip, crop, sharpen, denoise, vocal separation | Direct AIGC provider API call |
| **Complex** (LLM needed) | Inpainting with instructions, style transfer with description | SubAgent + bound Skill |

Whether a tool uses SubAgent/Skill is determined by the tool's nature, not a blanket rule. Pure image manipulations (flip, rotate, crop, format convert) and simple audio operations (trim, concat, volume) are handled by the frontend (Canvas/FFmpeg.wasm) — they don't hit the backend.

### 5.3 Editor Operation Types

| Type | Examples | Behavior |
|---|---|---|
| **In-place (reversible)** | Flip, rotate, crop, brightness adjust | Modifies the original node content. Can be undone. |
| **Generative (irreversible)** | Background removal, upscale, inpainting, relight, TTS, voice clone | Creates a **new node** on Canvas. Original node is preserved. |

---

## 6. Skill System

### 6.1 Skill Structure

Each Skill lives in `skills/{name}/` with two files:

```
skills/{name}/
├── SKILL.md          # Frontmatter (name, description) + LLM instructions
└── metadata.json     # Runtime configuration
```

### 6.2 metadata.json Specification

| Field | Required | Type | Default | Description |
|---|---|---|---|---|
| `name` | yes | string | — | Unique skill identifier |
| `description` | yes | string | — | One-line description (LLM uses this to decide when to invoke) |
| `scope` | yes | string[] | — | Where the skill can be used: `"agent"` (multi-turn chat) and/or `"canvas"` (single Worker execution) |
| `category` | yes | string | — | Classification: `image`, `video`, `audio`, `tts`, `3d`, `text`, `understand`, `creative`, `research`, `default` |
| `tools` | no | string[] | `[]` | LLM tools this skill needs (e.g. `["web_search", "exec"]`) |
| `output_type` | no | string | `"canvas"` | Output format: `"task_plan"` (JSON plan), `"canvas"` (node result), `"inline"` (chat text) |
| `keywords` | no | string[] | `[]` | Keywords for search/matching |
| `requires` | no | object | `{}` | Dependencies: `{ "env": ["API_KEY"], "bins": ["ffmpeg"] }` |
| `disable_model_invocation` | no | boolean | `false` | If true, only user can invoke (LLM cannot auto-select) |
| `always` | no | boolean | `false` | If true, always included in system prompt |

### 6.3 Scope: Three Areas

| Area | Scope value | Execution | Multi-turn | Output |
|---|---|---|---|---|
| **Agent Panel** (left chat) | `"agent"` | MainAgent in API process | Yes — skill injected into conversation context | Flexible: plan JSON, text advice, reference list, or pure discussion |
| **Canvas Node** (intelligent mode) | `"canvas"` | Worker process (single execution) | No — one-shot | Must produce generation result (calls provider → writes to Yjs) |
| **Editor Panel** (right tools) | — | Does not use skills | — | Uses mini-tools or hardcoded text-tools |

### 6.4 Current Skills (13)

**Agent scope — Creation Planning:**

| Skill | Category | Output | Purpose |
|---|---|---|---|
| `generate_image_plan` | image | task_plan | Plan image generation (model + params) |
| `generate_video_plan` | video | task_plan | Plan video generation |
| `generate_audio_plan` | audio | task_plan | Plan music/SFX generation |
| `generate_tts_plan` | tts | task_plan | Plan speech/voice clone |
| `generate_3d_plan` | 3d | task_plan | Plan 3D model generation |

**Agent scope — Creative Assistance:**

| Skill | Category | Output | Purpose |
|---|---|---|---|
| `prompt_engineer` | creative | inline | Optimize AIGC prompts for all modalities |
| `creative_research` | research | inline | Search references, explore styles, curate inspiration |
| `brainstorm` | creative | inline | Brainstorm ideas, develop concepts, structure projects |
| `text_generation` | text | canvas | Generate written content (articles, scripts, poems) |
| `afame` | image | canvas | Generate creative illustrations |

**Agent scope — Meta/Tools:**

| Skill | Category | Output | Purpose |
|---|---|---|---|
| `mini_tool_creator` | default | inline | Create custom browser-side mini-tools |
| `skill_creator` | default | inline | Create or update Breatic skills |

**Agent + Canvas scope:**

| Skill | Category | Output | Purpose |
|---|---|---|---|
| `vision_analyze` | understand | inline | Analyze images/videos/audio via multimodal AI |

### 6.5 Editor Mini-Tools (no skills)

Triggered from the Editor panel on a selected Canvas node. Do not use the Skill system.

| Modality | Endpoint | Execution | Tools |
|---|---|---|---|
| **Image** | `POST /mini-tools/image` | Async Worker → Yjs | remove-bg, upscale, sharpen, denoise, restore, adjust, relight, multi-angle, edit, upscale-creative |
| **Video** | `POST /mini-tools/video` | Async Worker → Yjs | upscale, interpolate, extend, edit, motion, animate, talking-head |
| **Audio** | `POST /mini-tools/audio` | Async Worker → Yjs | sfx, tts, voice-clone, separate, extend |
| **Text** | `POST /mini-tools/text` | Sync SSE streaming | polish, expand, summarize, translate, rewrite, continue, generate, character, storyboard, script |

---

## 7. Node Types and Modes

### 7.1 Image

| Context | Modes |
|---|---|
| Agent Panel (creation) | t2i, i2i |
| Editor (post-processing) | edit, relight, remove_bg, upscale, sharpen, denoise, restore, adjust, multi_angle |

### 7.2 Video

| Context | Modes |
|---|---|
| Agent Panel (creation) | t2v, i2v, ref |
| Editor (post-processing) | extend, edit, motion, animate, talking_head, upscale, interpolation |

### 7.3 Audio

| Context | Modes |
|---|---|
| Agent Panel (creation) | t2m, a2m, sfx |
| Editor (post-processing) | separate, extend, tts, voice_clone |

### 7.4 TTS

| Context | Modes |
|---|---|
| Agent Panel (creation) | tts, voice_clone |
| Editor (mini-tool) | tts, voice_clone (same models, triggered from audio node editor) |

### 7.5 3D

| Context | Modes |
|---|---|
| Agent Panel (creation) | t23d, i23d |
| Editor (post-processing) | (future: texture edit, format conversion) |

### 7.6 Understand

| Context | Modes | Output |
|---|---|---|
| Canvas node action | vi (image), vv (video), va (audio), transcribe | Text node |

### 7.7 Text

| Context | Features |
|---|---|
| Editor only | AI polish, expand, summarize, generate character descriptions, generate storyboard (table mode) |

Text nodes have **no intelligent mode** and no Agent Panel plan Skill — all text AI features are handled by the Editor.

---

## 8. Backend Architecture

### 8.1 Request Flow (3 Services)

```
Frontend (React + ReactFlow + Yjs)
  ↓ HTTP                          ↕ WebSocket
API Service (Hono, port 3000)      Collab Service (Hocuspocus, port 1234)
  ├── POST /canvas/tasks  → BullMQ    ├── Yjs document sync (canvas + node editors)
  │   + SETNX canvas lock             ├── PostgreSQL persistence (yjs_documents)
  │   + XADD handling event           ├── Redis extension cross-instance sync
  ├── POST /canvas/understand → BullMQ├── Stream consumer: XREAD dev:stream:canvas-nodes
  ├── POST /mini-tools/*  → BullMQ    │   → parse NodeEvent (handling|completed|failed)
  │   + XADD handling / completed     │   → openDirectConnection → canvas.nodes update
  └── POST /chat/message  → SSE stream└── Release canvas lock on completed/failed
  ↓
Worker Service (BullMQ, no port)
  ├── runMiniTool()    → provider direct call
  ├── runUnderstand()  → media analysis / ASR
  ├── runAigcDirect()  → explicit model + params
  ├── Skill (explicit) → AI SDK agent loop
  └── Skill (auto)     → merged skills, LLM chooses
  ↓
  Store result in DB → XADD dev:stream:canvas-nodes {type:"completed",content,cover_url}
  ↓
  Collab Stream consumer → NodeEvent → openDirectConnection() → canvas.nodes[i].data
  ↓
  Yjs sync → all connected frontend clients see updated canvas node
```

See [YJS.md](./YJS.md) for the full document structure, NodeEvent schema, and lock semantics.

### 8.2 Provider Architecture

All providers follow the same dual-layer pattern:

```
providers/{modality}/
├── index.ts             # generateAsync() — resolve model → dispatch to transport
├── models/              # Per-family parameter conversion (buildRequest)
└── transports/          # Per-provider HTTP handling (generate)
```

| Provider | Public API | Output | Transport |
|---|---|---|---|
| Image | `generateAsync()` | `{url}` or `{buffer}` | wavespeed, google, byteplus, dashscope, topaz |
| Video | `generateAsync()` | `{url}` | wavespeed |
| Audio | `generateAsync()` | `{url}` or `{buffer}` | wavespeed, minimax |
| TTS | `generateAsync()` | `{buffer}` | elevenlabs |
| 3D | `generateAsync()` | `{url}` | wavespeed |
| Understand | `generateAsync()` | `{text}` | google (vi/vv/va), wavespeed (transcribe) |

Sync transports (ElevenLabs, MiniMax direct) return raw `{buffer, contentType}`. Worker handles all storage persistence — buffer upload or CDN URL download → permanent OSS/S3/local storage.

### 8.3 Backend ↔ Canvas Interaction

Backend does **not** create or position canvas nodes — that is entirely frontend-controlled. Backend only **updates existing node `data` fields** via the Collab service, which receives NodeEvents over Redis Streams and writes them into the canvas Y.Doc via `openDirectConnection`.

| Responsibility | Owner |
|---|---|
| Node creation, position, layout | Frontend |
| Node type, edges, visual properties | Frontend |
| Node state (`idle` ↔ `handling`) | Backend (Collab, from API/Worker events) |
| Node content / cover_url | Backend (Collab, from Worker/upload events) |
| Concurrent lock (`handlingBy` + Redis SETNX) | Backend (API acquires, Collab releases) |
| Input params (`nodeRuntimeData`) | Frontend |

The state machine is just `idle ↔ handling`. Failures revert to `idle` with unchanged content — failure details live in the `node_history` table, not on the Yjs node. See [YJS.md](./YJS.md) for the complete ownership table and NodeEvent flow.

---

## 9. API Endpoint Summary

### Canvas

| Method | Path | Purpose |
|---|---|---|
| POST | `/canvas/tasks` | Create generation task (from Agent plan or parameter mode) |
| POST | `/canvas/understand` | Analyze/transcribe a node's content |
| GET | `/canvas/tasks` | List tasks (reconnect recovery) |

### Mini-Tools (Editor)

| Method | Path | Count |
|---|---|---|
| POST | `/mini-tools/image` | Image tools (discriminated union, async Worker) |
| POST | `/mini-tools/video` | Video tools (discriminated union, async Worker) |
| POST | `/mini-tools/audio` | Audio tools (discriminated union, async Worker) |
| POST | `/mini-tools/text` | Text tools (discriminated union, SSE streaming) |

### Other

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/*` | Authentication (email+password, Google OAuth) |
| CRUD | `/projects/*` | Project management |
| POST | `/chat/*` | Agent Panel conversations |
| GET | `/skills/*` | Skill listing |
| POST | `/payment/*` | Stripe payments |
| GET | `/health` | Health check |

---

## 10. AI Model Catalog

**Total: ~50 models (streamlined from ~104), only top-tier per modality. 4 providers, 6 modalities.**

| Provider | Models | Transports | Modes |
|----------|--------|------------|-------|
| [Image](#101-image) | 18 | wavespeed, google, byteplus, dashscope, topaz | t2i, i2i, edit, relight, multi_angle, remove_bg, upscale, sharpen, denoise, restore, adjust |
| [Video](#102-video) | 16 | wavespeed | t2v, i2v, ref, edit, motion, animate, upscale, interpolate, extend |
| [Audio](#103-audio) | 3 | wavespeed | t2m, a2m, separate |
| [TTS](#104-tts) | 1 | elevenlabs | tts |
| [3D](#105-3d) | 4 | wavespeed | t23d, i23d |
| [Understand](#106-understand) | 7 | google, wavespeed | vi, vv, va, transcribe |

### 10.1 Image

23 models, 9 model families, 5 transports. All models support PNG output.

#### Nano Banana (Google Gemini) — 6 models

| Name | model_id | Mode | Resolution | Key Params | Cost |
|------|----------|------|------------|------------|------|
| **nano-banana-pro** | `gemini-3-pro-image-preview` | t2i | 1k-4k | aspect_ratio, style_images(14), camera, lens, focal_length, aperture | 7 |
| **nano-banana-2** | `gemini-3.1-flash-image-preview` | t2i | 0.5k-4k | + enable_web_search, extra ratios (1:4, 4:1, 1:8, 8:1) | 4.5 |
| **nano-banana** | `gemini-2.5-flash-image` | t2i | 1k-2k | aspect_ratio, style_images(10), camera, lens | 2 |
| nano-banana-pro-edit | `gemini-3-pro-image-preview` | i2i, edit | 1k-4k | images(14) | 7 |
| nano-banana-2-edit | `gemini-3.1-flash-image-preview` | i2i, edit | 0.5k-4k | images(14), enable_web_search | 4.5 |
| nano-banana-edit | `gemini-2.5-flash-image` | i2i, edit | 1k-2k | images(10) | 2 |

T2I models use **DeepSeek V3 LLM-enhanced prompts** (camera/lens → structured JSON).

#### Seedream (ByteDance) — 4 models

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **seedream-5.0-lite** | `seedream-5-0-260128` | t2i | aspect_ratio, resolution, style_images(10) | 4 |
| **seedream-4.5** | `seedream-4-5-251128` | t2i | same | 4 |
| seedream-5.0-lite-edit | `seedream-5-0-260128` | edit | aspect_ratio, resolution, images(10) | 4 |
| seedream-4.5-edit | `seedream-4-5-251128` | edit | same | 4 |

#### Midjourney — 4 models

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **midjourney-v7** | `midjourney/text-to-image` | t2i | aspect_ratio, stylize, chaos, weird, sref, seed | 10 |
| **midjourney-niji-v7** | `midjourney/niji/text-to-image` | t2i | same | 10 |
| midjourney-v7-img2img | `midjourney/image-to-image` | i2i | + image, iw(0-3) | 10 |
| midjourney-niji-v7-img2img | `midjourney/niji/image-to-image` | i2i | same | 10 |

#### Z-Image (Alibaba) — 2 models

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **z-image-turbo** | `wavespeed-ai/z-image/turbo` | t2i | aspect_ratio, seed | 0.5 |
| z-image-turbo-img2img | `wavespeed-ai/z-image-turbo/image-to-image` | i2i | + image, strength(0-1) | 0.5 |

#### Qwen (Alibaba DashScope) — 3 models

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **qwen-image** | `qwen-image-plus` | t2i | aspect_ratio, seed | 2 |
| **qwen-edit** | `qwen-image-edit` | edit | aspect_ratio, image, seed | 3 |
| **qwen-multi-angle** | `wavespeed-ai/qwen-image/edit-multiple-angles` | multi_angle | image, horizontal/vertical_angle, distance | 2.5 |

#### IC-Light — 1 model

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **ic-light-v2** | `wavespeed-ai/ic-light` | relight | image, light_source, brightness, temperature, rim_light | 20 |

#### Topaz (Enhancement) — 6 models

| Name | model_id | Mode | Key Params | Cost |
|------|----------|------|------------|------|
| **topaz-upscale** | `enhance` | upscale | image, output_resolution, source_width/height | 7 |
| **topaz-upscale-creative** | `enhance/async` | upscale | + prompt, creativity(1-6) | 7 |
| **topaz-sharpen** | `sharpen-gen/async` | sharpen | image, sharpen_model(9), sharpen/denoise_strength | 15 |
| **topaz-denoise** | `denoise/async` | denoise | image, denoise_model, denoise, detail, face_enhancement | 15 |
| **topaz-restore** | `restore/async` | restore | image, restore_model | 15 |
| **topaz-adjust** | `lighting/async` | adjust | image, adjust_mode, saturation | 15 |

#### Background Remover — 1 model

| Name | model_id | Mode | Cost |
|------|----------|------|------|
| **bg-remover** | `wavespeed-ai/image-background-remover` | remove_bg | 1 |

#### Image Transports

| Transport | Pattern | Auth |
|-----------|---------|------|
| wavespeed | submit + poll | Bearer token |
| google | generateContent (sync) | API key query param |
| byteplus | POST (sync) | Bearer token |
| dashscope | async task + poll | Bearer token |
| topaz | sync or async (form data) | X-API-Key header |

### 10.2 Video

~90 models, 11 model families, 10 transports.

#### Model Families Summary

| Family | Generations | Modes | Official API | Cost Range |
|--------|-------------|-------|-------------|------------|
| **Kling** (KwaiVGI) | O3, O1, V3, V2.6 | t2v, i2v, ref, edit, motion | KlingAI | $0.21-0.84 |
| **Wan** (Alibaba) | 2.6, 2.5, 2.2, 2.1 | t2v, i2v, ref, extend, animate | DashScope | $0.25-1.00 |
| **Seedance** (ByteDance) | 2.0, 1.5, 1.0 | t2v, i2v, ref, extend | BytePlus | $0.16-0.80 |
| **VEO** (Google) | 3.1, 3, 2 | t2v, i2v, extend | Google | $2.50 |
| **Sora** (OpenAI) | 2 Pro, 2 | t2v, i2v | OpenAI | $0.10/s |
| **Hailuo** (MiniMax) | 02, 2.3 | t2v, i2v | MiniMax | $0.19-0.49 |
| **Vidu** (Shengshu) | Q3, Q2 | t2v, i2v, ref | Vidu | $0.375 |
| **PixVerse** | 5.5, 5, 4.5 | t2v, i2v | PixVerse | $0.25-0.70 |
| **Luma** (Luma Labs) | Ray 2, Flash 2 | t2v, i2v, extend | Luma | $0.24-0.71 |
| **Midjourney** | Video | i2v | — | $0.15-0.48 |
| **OmniHuman** (ByteDance) | 1.5 | talking_head | — | $0.25/s |

#### Video Transports

| Transport | Auth | Pattern |
|-----------|------|---------|
| wavespeed | Bearer token | submit + poll |
| klingai | JWT (access_key + secret_key) | submit + poll |
| dashscope | API key header | async task + poll |
| byteplus | Bearer token | content array + poll |
| minimax | API key header | submit + poll |
| google | API key / OAuth | Vertex AI predict |
| openai | Bearer token | submit + poll |
| pixverse | API key | submit + poll |
| vidu | API key | submit + poll |
| luma | Bearer token | submit + poll |

### 10.3 Audio

6 models, 3 model families, 4 transports.

#### MiniMax Music — 3 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **minimax-music-02** | t2m | Best all-round, MoE 230B, vocals, 5min | prompt, lyrics | 10 |
| **minimax-music-2.5** | t2m | Studio-grade, 100+ instruments, 14 tags | prompt, lyrics, is_instrumental | 50 |
| **minimax-music-01** | a2m | Voice cloning, style transfer, 60s | prompt, song, voice, instrumental | 10 |

#### ElevenLabs — 2 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **elevenlabs-music** | t2m | Licensed data, commercially safe, 5s-5min | prompt, music_length_ms, force_instrumental, output_format | 50 |
| **elevenlabs-sfx-v2** | sfx | Sound effects, 0.5-22s, loop mode | prompt, duration_seconds, prompt_influence, loop | 5 |

#### Vocal Remover — 1 model

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **vocal-remover** | separate | AI vocal/instrumental separation | audio, mode(vocals/instrumental) | 2 |

#### Audio Transports

| Transport | Pattern |
|-----------|---------|
| wavespeed | submit + poll |
| minimax | sync (hex-encoded audio → storage) |
| elevenlabs | sync (binary audio → storage) |
| fal | submit + poll (fal.ai queue) |

### 10.4 TTS

6 models, 6 model families, 5 transports.

#### Text-to-Speech — 4 models

| Name | Description | Languages | Voices | Key Params | Cost |
|------|-------------|-----------|--------|------------|------|
| **elevenlabs-v3** | Most natural, emotional | 70+ | 52 (21F/31M) | text, voice_id, stability, similarity | 10 |
| **minimax-speech-2.6-hd** | Ultra-low latency (<250ms) | 40+ | 17 (8F/7M/2N) | text, voice_id, speed, emotion | 10 |
| **fish-speech-1.5** | Cheapest, TTS-Arena #2 | 13+ | via fish.audio | text, reference_id, speed | 3 |
| **gemini-tts** | Multi-speaker dialogue | 24 | 30 (14F/16M) | text, language, speakers, voice | 10 |

#### Voice Cloning — 2 models

| Name | Description | Key Params | Cost |
|------|-------------|------------|------|
| **qwen3-voice-clone** | Clone from reference audio, 11 langs | text, audio, reference_text, language | 5 |
| **f5-tts** | Zero-shot cloning, single sample | text, ref_audio_url, ref_text | 5 |

#### TTS Transports

| Transport | Pattern |
|-----------|---------|
| elevenlabs | sync (binary audio → storage) |
| minimax | sync (hex-encoded audio → storage) |
| fish | sync (msgpack → binary audio → storage) |
| wavespeed | submit + poll |
| fal | submit + poll (fal.ai queue) |

### 10.5 3D

9 models, 5 model families, 1 transport (WaveSpeed).

#### Meshy 6 — 2 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **meshy6-t23d** | t23d | Best quality, PBR, GLB/FBX/OBJ/USDZ | prompt, art_style, topology, target_polycount, enable_pbr, symmetry_mode, ta_pose | 80 |
| **meshy6-i23d** | i23d | Accurate geometry from image | image, topology, target_polycount, enable_pbr, symmetry_mode, ta_pose | 20 |

#### Hunyuan3D — 3 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **hunyuan3d-v3** | t23d | 3 quality tiers (Normal/LowPoly/Geometry) | prompt, generate_type, enable_pbr, face_count | 25 |
| **hunyuan3d-v3-i23d** | i23d | Multi-view input (front+back/left/right) | image, back/left/right_image, generate_type, enable_pbr, face_count | 23 |
| **hunyuan3d-v3.1-rapid** | i23d | Ultra-fast, $0.02, single param | image | 2 |

#### Rodin V2 (Hyper3D) — 2 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **rodin-v2-t23d** | t23d | 5 formats, 8 quality presets, PBR | prompt, material, quality_and_mesh, geometry_file_format, seed, ta_pose | 40 |
| **rodin-v2-i23d** | i23d | 1-5 image input, production-ready | images(1-5), prompt, material, quality_and_mesh, geometry_file_format, seed | 40 |

#### Tripo3D — 1 model

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **tripo3d-v2.5** | i23d | One-click image to 3D | image | 30 |

#### SAM 3D — 1 model

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **sam-3d** | i23d | SAM-powered, cheapest, 22-43s | image, prompt(optional), mask_images(1-10) | 2 |

### 10.6 Understand

10 models, 4 model families, 2 transports (LiteLLM + WaveSpeed).

#### Gemini — 6 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **gemini-flash-vi** | vi | Cheapest image understanding | prompt, images(20), max_tokens | 1 |
| **gemini-flash-vv** | vv | Cheapest video understanding | prompt, video_url, max_tokens | 3 |
| **gemini-flash-va** | va | Cheapest audio understanding | prompt, audio_url, max_tokens | 2 |
| **gemini-pro-vi** | vi | Best image understanding | prompt, images(20), max_tokens | 5 |
| **gemini-pro-vv** | vv | Best video understanding | prompt, video_url, max_tokens | 10 |
| **gemini-pro-va** | va | Best audio understanding | prompt, audio_url, max_tokens | 5 |

#### OpenAI — 1 model

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **gpt-4o-vi** | vi | Strong image understanding, OCR | prompt, images(10), max_tokens | 3 |

#### Whisper (ASR) — 2 models

| Name | Mode | Description | Key Params | Cost |
|------|------|-------------|------------|------|
| **whisper-turbo** | transcribe | Fastest ASR, $0.0007/s, 50+ langs | audio, language | 1 |
| **whisper-v3** | transcribe | Best ASR, timestamps + translate | audio, language, task, enable_timestamps | 2 |

#### Understand Transports

| Transport | Used By | Pattern |
|-----------|---------|---------|
| litellm | vi, vv, va | LiteLLM acompletion (multimodal LLM) |
| wavespeed | transcribe | submit + poll (Whisper API) |
