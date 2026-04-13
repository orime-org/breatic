/**
 * Mini-tool → default model mapping.
 *
 * Maps each mini-tool name to its default AIGC model.
 * Users can override via the `model` param in the request.
 */

/** Default models keyed by task_type → tool_name. */
export const MINI_TOOL_DEFAULTS: Readonly<Record<string, Record<string, string>>> = {
  image: {
    "remove-bg": "bg-remover",
    upscale: "topaz-upscale",
    "upscale-creative": "topaz-upscale-creative",
    sharpen: "topaz-sharpen",
    denoise: "topaz-denoise",
    restore: "topaz-restore",
    adjust: "topaz-adjust",
    relight: "ic-light-v2",
    "multi-angle": "qwen-multi-angle",
    edit: "nano-banana-2-edit",
  },
  video: {
    upscale: "video-upscale-pro",
    interpolate: "rife-interpolation",
    extend: "kling-o3-pro",
    edit: "kling-o3-pro",
    motion: "kling-v3-pro-motion",
    animate: "wan-2.2-animate",
    "talking-head": "omnihuman-1.5",
  },
  audio: {
    sfx: "elevenlabs-sfx-v2",
    separate: "vocal-remover",
    extend: "minimax-music-01",
  },
  tts: {
    tts: "elevenlabs-v3",
    "voice-clone": "f5-tts",
  },
};
