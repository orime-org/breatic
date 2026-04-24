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
    "upscale-creative": { kind: "provider", model: "topaz-upscale-creative" },
    sharpen: { kind: "provider", model: "topaz-sharpen" },
    denoise: { kind: "provider", model: "topaz-denoise" },
    restore: { kind: "provider", model: "topaz-restore" },
    adjust: { kind: "provider", model: "topaz-adjust" },
    relight: { kind: "provider", model: "ic-light-v2" },
    "multi-angle": { kind: "provider", model: "qwen-multi-angle" },
    edit: { kind: "provider", model: "nano-banana-2-edit" },
    // Sharp-based local handlers — no AIGC, Worker in-process.
    // `manual-adjust` is the slider-driven `AdjustValue` adjust,
    // distinct from the existing `adjust: topaz-adjust` which is
    // Topaz's AI auto-enhance (no user sliders).
    crop: { kind: "local", handler: "image/crop" },
    flipRotate: { kind: "local", handler: "image/flipRotate" },
    "manual-adjust": { kind: "local", handler: "image/adjust" },
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
 *
 * @throws `Error` when the `(taskType, toolName)` pair is unknown.
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
