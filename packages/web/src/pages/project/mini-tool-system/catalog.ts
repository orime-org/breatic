import type { Modality } from '@/spaces/canvas/types/node';

/**
 * Mini-tool catalog — the 47 tools that show up in the canvas node
 * toolbar's right zone. Each tool is keyed by id, knows the source
 * modality (which node kind it operates on), the output modality (the
 * new sibling node it produces), and a short label.
 *
 * Per ADR mini-tool-unified-output: invoking a tool ALWAYS creates a
 * NEW sibling node + primary edge from the source. The Apply contract
 * lives in `apply-as-new-node.ts`.
 */
export interface MiniTool {
  id: string;
  label: string;
  source: Modality;
  /** Output modality of the produced sibling node. */
  output: Modality;
  /** UI grouping in the picker; cosmetic only. */
  category: string;
  /** Whether the tool runs on the API (Text streamText) vs Worker queue. */
  runtime: 'text-sse' | 'worker';
}

export const MINI_TOOLS: ReadonlyArray<MiniTool> = [
  // Text → text (10)
  { id: 'polish', label: 'Polish', source: 'text', output: 'text', category: 'rewrite', runtime: 'text-sse' },
  { id: 'expand', label: 'Expand', source: 'text', output: 'text', category: 'rewrite', runtime: 'text-sse' },
  { id: 'summarize', label: 'Summarize', source: 'text', output: 'text', category: 'rewrite', runtime: 'text-sse' },
  { id: 'translate', label: 'Translate', source: 'text', output: 'text', category: 'rewrite', runtime: 'text-sse' },
  { id: 'rewrite', label: 'Rewrite', source: 'text', output: 'text', category: 'rewrite', runtime: 'text-sse' },
  { id: 'continue', label: 'Continue', source: 'text', output: 'text', category: 'generate', runtime: 'text-sse' },
  { id: 'generate', label: 'Generate from outline', source: 'text', output: 'text', category: 'generate', runtime: 'text-sse' },
  { id: 'character', label: 'Character sheet', source: 'text', output: 'text', category: 'structure', runtime: 'text-sse' },
  { id: 'storyboard', label: 'Storyboard', source: 'text', output: 'text', category: 'structure', runtime: 'text-sse' },
  { id: 'script', label: 'Script', source: 'text', output: 'text', category: 'structure', runtime: 'text-sse' },

  // Text → image (3)
  { id: 'text-to-image', label: 'Text → image', source: 'text', output: 'image', category: 'cross-modal', runtime: 'worker' },
  { id: 'text-to-cover', label: 'Generate cover art', source: 'text', output: 'image', category: 'cross-modal', runtime: 'worker' },
  { id: 'text-to-poster', label: 'Generate poster', source: 'text', output: 'image', category: 'cross-modal', runtime: 'worker' },

  // Text → audio (3)
  { id: 'tts', label: 'Speak (TTS)', source: 'text', output: 'audio', category: 'cross-modal', runtime: 'worker' },
  { id: 'narration', label: 'Narration', source: 'text', output: 'audio', category: 'cross-modal', runtime: 'worker' },
  { id: 'jingle', label: 'Jingle', source: 'text', output: 'audio', category: 'cross-modal', runtime: 'worker' },

  // Text → video (2)
  { id: 'text-to-video', label: 'Text → video', source: 'text', output: 'video', category: 'cross-modal', runtime: 'worker' },
  { id: 'text-to-storyboard-video', label: 'Storyboard → video', source: 'text', output: 'video', category: 'cross-modal', runtime: 'worker' },

  // Image → image (10)
  { id: 'inpaint', label: 'Inpaint', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'outpaint', label: 'Outpaint', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'remove-bg', label: 'Remove background', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'restyle', label: 'Restyle', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'upscale', label: 'Upscale', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'recolor', label: 'Recolor', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'face-swap', label: 'Face swap', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'pose-transfer', label: 'Pose transfer', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'tile-pattern', label: 'Tile pattern', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },
  { id: 'sketch-to-image', label: 'Sketch → image', source: 'image', output: 'image', category: 'edit', runtime: 'worker' },

  // Image → text / video (4)
  { id: 'image-caption', label: 'Caption', source: 'image', output: 'text', category: 'cross-modal', runtime: 'worker' },
  { id: 'image-describe', label: 'Describe', source: 'image', output: 'text', category: 'cross-modal', runtime: 'worker' },
  { id: 'image-to-video', label: 'Animate', source: 'image', output: 'video', category: 'cross-modal', runtime: 'worker' },
  { id: 'image-to-cinemagraph', label: 'Cinemagraph', source: 'image', output: 'video', category: 'cross-modal', runtime: 'worker' },

  // Audio → audio / text (6)
  { id: 'denoise', label: 'Denoise', source: 'audio', output: 'audio', category: 'edit', runtime: 'worker' },
  { id: 'isolate-vocals', label: 'Isolate vocals', source: 'audio', output: 'audio', category: 'edit', runtime: 'worker' },
  { id: 'remaster', label: 'Remaster', source: 'audio', output: 'audio', category: 'edit', runtime: 'worker' },
  { id: 'transcribe', label: 'Transcribe', source: 'audio', output: 'text', category: 'cross-modal', runtime: 'worker' },
  { id: 'summarize-audio', label: 'Summarize', source: 'audio', output: 'text', category: 'cross-modal', runtime: 'worker' },
  { id: 'translate-audio', label: 'Translate', source: 'audio', output: 'text', category: 'cross-modal', runtime: 'worker' },

  // Video → video / image / text / audio (9)
  { id: 'extract-cover', label: 'Extract cover', source: 'video', output: 'image', category: 'extract', runtime: 'worker' },
  { id: 'extract-audio', label: 'Extract audio', source: 'video', output: 'audio', category: 'extract', runtime: 'worker' },
  { id: 'extract-transcript', label: 'Extract transcript', source: 'video', output: 'text', category: 'extract', runtime: 'worker' },
  { id: 'extract-keyframes', label: 'Extract keyframes', source: 'video', output: 'image', category: 'extract', runtime: 'worker' },
  { id: 'video-summary', label: 'Summarize', source: 'video', output: 'text', category: 'cross-modal', runtime: 'worker' },
  { id: 'stabilize', label: 'Stabilize', source: 'video', output: 'video', category: 'edit', runtime: 'worker' },
  { id: 'upscale-video', label: 'Upscale', source: 'video', output: 'video', category: 'edit', runtime: 'worker' },
  { id: 'restyle-video', label: 'Restyle', source: 'video', output: 'video', category: 'edit', runtime: 'worker' },
  { id: 'video-loop', label: 'Loop', source: 'video', output: 'video', category: 'edit', runtime: 'worker' },
];

const BY_ID = new Map(MINI_TOOLS.map((t) => [t.id, t]));

export function getMiniTool(id: string): MiniTool | undefined {
  return BY_ID.get(id);
}

export function miniToolsForModality(
  modality: Modality,
): ReadonlyArray<MiniTool> {
  return MINI_TOOLS.filter((t) => t.source === modality);
}
