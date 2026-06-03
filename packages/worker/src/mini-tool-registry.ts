// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Mini-tool execution registry.
 *
 * Replaces the earlier `mini-tool-defaults.ts`. Each registered tool
 * declares HOW it runs, not just which model it calls:
 *
 *   - `kind: 'provider'` → AIGC vendor API via `provider.generateAsync`
 *     (Topaz / Kling / ElevenLabs / ...).
 *   - `kind: 'local'` → Worker-local execution via `runLocalHandler`,
 *     which dispatches by `handler` path to a function that internally
 *     chooses FFmpeg / Sharp / ImageMagick / anything else. The
 *     "library" choice is the handler's private implementation detail
 *     — the registry is library-agnostic.
 *
 * The two kinds share the same invocation surface (`runMiniTool`
 * dispatches by kind); the caller cannot tell whether the result came
 * from a remote vendor or local ffmpeg.
 *
 * Migration from MINI_TOOL_DEFAULTS: every entry there was a vendor
 * model string — all now register as `kind: 'provider'`. No behavior
 * change. Future `kind: 'local'` entries land as their handlers are
 * implemented (T3 phase 2+).
 */

/** Vendor-backed mini-tool: `generateAsync(prompt, model, params)`. */
export interface ProviderToolEntry {
  kind: "provider";
  /** Default vendor model. Caller-supplied `params.model` takes precedence. */
  model: string;
}

/**
 * Worker-local mini-tool: dispatch by `handler` path.
 *
 * Format: `"<category>/<operation>"`, e.g. `"video/crop"`. The handler
 * chooses its own library (FFmpeg, Sharp, libvips, …) — the registry
 * does not know or care.
 */
export interface LocalToolEntry {
  kind: "local";
  /** `"<category>/<operation>"` — resolves to `handlers/local/<path>.ts`. */
  handler: string;
}

export type MiniToolEntry = ProviderToolEntry | LocalToolEntry;

/** Mini-tool registry: `taskType` → `toolName` → entry. */
export const MINI_TOOL_REGISTRY: Readonly<Record<string, Record<string, MiniToolEntry>>> = {
  image: {
    "remove-bg": { kind: "provider", model: "bg-remover" },
    upscale: { kind: "provider", model: "topaz-upscale" },
    // V1 image roster per `design/project/02-mini-tool-system.md` §2.2 =
    // remove-bg / upscale / inpaint. inpaint will land once its
    // overlay-driven param UI is designed; the previous over-broad
    // registry (sharpen / denoise / restore / upscale-creative / adjust
    // / relight / multi-angle / edit / graffiti) was trimmed in B5.
    //
    // Image local handlers intentionally absent: crop / flipRotate /
    // manual-adjust are sub-100ms Canvas operations and belong in the
    // browser (see `feedback_frontend_backend_boundary` memory). The
    // `adjust` row moved entirely to frontend Category A in F4-categoryA.
  },
  video: {
    upscale: { kind: "provider", model: "video-upscale-pro" },
    interpolate: { kind: "provider", model: "rife-interpolation" },
    extend: { kind: "provider", model: "kling-o3-pro" },
    edit: { kind: "provider", model: "kling-o3-pro" },
    motion: { kind: "provider", model: "kling-v3-pro-motion" },
    animate: { kind: "provider", model: "wan-2.2-animate" },
    "talking-head": { kind: "provider", model: "omnihuman-1.5" },
    // FFmpeg-based local handlers — no AIGC, Worker in-process.
    crop: { kind: "local", handler: "video/crop" },
    speed: { kind: "local", handler: "video/speed" },
    cut: { kind: "local", handler: "video/cut" },
    adjust: { kind: "local", handler: "video/adjust" },
    "audio-denoise": { kind: "local", handler: "video/audio-denoise" },
    // Visual-parity shims for legacy front-end behaviour — none of
    // these are real AIGC; they mirror the ffmpeg.wasm implementations
    // so migrating to Worker-local execution is visually identical.
    stabilization: { kind: "local", handler: "video/stabilization" },
    "scene-extension": { kind: "local", handler: "video/scene-extension" },
    "hdr-conversion": { kind: "local", handler: "video/hdr-conversion" },
  },
  audio: {
    sfx: { kind: "provider", model: "elevenlabs-sfx-v2" },
    separate: { kind: "provider", model: "vocal-remover" },
    extend: { kind: "provider", model: "minimax-music-01" },
  },
  tts: {
    tts: { kind: "provider", model: "elevenlabs-v3" },
    "voice-clone": { kind: "provider", model: "f5-tts" },
  },
};

/**
 * Look up a mini-tool entry, or throw a clear error if unregistered.
 * @param taskType - Task type the tool belongs to (e.g. "image", "video", "audio")
 * @param toolName - Mini-tool name within that task type
 * @returns The registered `MiniToolEntry` describing the local or provider handler
 * @throws {Error} when the `(taskType, toolName)` pair is unknown.
 */
export function resolveMiniToolEntry(taskType: string, toolName: string): MiniToolEntry {
  const taskTypeEntries = MINI_TOOL_REGISTRY[taskType];
  if (!taskTypeEntries) {
    throw new Error(`No mini-tool registry for task type '${taskType}'`);
  }
  const entry = taskTypeEntries[toolName];
  if (!entry) {
    throw new Error(`Unknown mini-tool '${toolName}' for '${taskType}'`);
  }
  return entry;
}
