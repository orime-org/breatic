/**
 * Local-only node data for the canvas under `src/new/project/components/canvas`.
 * Mirrors production `apps/project/components/canvas/dataNode` fields used by the library panel.
 */

/** Pick overlay box (mixed-editor / video erase). */
export interface ImageEditorPickResultBox {
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  frameTimeSec?: number;
  maskShape?: 'rectangle' | 'circle';
  placeholderId?: string;
  sourceNodeId?: string;
  content?: string;
  name?: string;
}

export interface ImageEditorPickPending {
  targetNodeId: string;
  placeholderId: string;
  content: string;
  name: string;
  overlayAnchor?: { xPct: number; yPct: number };
}

export interface ImageEditorPickState {
  fromCanvas?: boolean;
  composerFocused?: boolean;
  eraseMaskTool?: 'selection' | 'rectangle' | 'circle';
  pending?: ImageEditorPickPending | null;
  pendingList?: ImageEditorPickPending[] | null;
  resultBoxes?: ImageEditorPickResultBox[] | null;
  selection?: ImageEditorPickPending | null;
  consumeFrom?: string | null;
}

export interface ImageEditorNodeRuntimeData {
  prompt?: string;
  upstream?: string;
  parameter?: Record<string, unknown>;
  /**
   * Local `gen1001`–`gen1004` footer: category dropdown key (e.g. audio `tts`, text `chat`).
   * Replaces agent-only UI — pairs with {@link modelLabel} / voice / language for the model pill.
   */
  generatorCategoryKey?: string;
  /** Primary model name in the footer pill (all generator kinds). */
  modelLabel?: string;
  /** Audio generator: voice name in the pill summary. */
  voiceLabel?: string;
  /** Audio generator: language label in the pill summary. */
  languageLabel?: string;
}

export type LocalCanvasNodeData = {
  /** When true, asset nodes show an inline loading overlay (e.g. output placeholder after local generator send). */
  localOutputPending?: boolean;
  /** 0–100 while pending; drives {@link CanvasOutputPendingProgressOverlay} when mini-tool work is polled (no fixed 3s mock). */
  localOutputProgressPct?: number;
  /** Display name above the node shell. */
  name?: string;
  /** Text node body (plain). */
  text?: string;
  /** Media URL for image / video / audio preview nodes. */
  url?: string;
  /** Mixed-editor parity: alternate media URL field for video flow nodes. */
  content?: string;
  state?: 'idle' | 'handling' | 'localPending';
  errorInfo?: string;
  coverUrl?: string;
  nodeRuntimeData?: ImageEditorNodeRuntimeData;
  pickState?: ImageEditorPickState | null;
  /**
   * Local audio composer / generation UI state (node type `1004` new canvas).
   * Stored in node `data` for Yjs-free local preview; production may map to `nodeRuntimeData` later.
   */
  audioRuntime?: AudioNodeRuntimeData;
  /** Handle metadata (same shape as production palette nodes). */
  handles?: {
    source?: { handleType: string; number: number }[];
    target?: { handleType: string; number: number }[];
  };
};

/**
 * Audio generation mode for the local audio node composer (footer + prompt routing).
 *
 * - `voice-clone` / `tts` — speech; `lyrics-music` / `melody` / `sfx` — music & sound design slots.
 */
export type AudioGenerationMode =
  | 'voice-clone'
  | 'melody'
  | 'lyrics-music'
  | 'tts'
  | 'sfx';

/**
 * Persisted UI fields for the audio node composer (prompts, model labels, toggles).
 */
export interface AudioNodeRuntimeData {
  generationMode: AudioGenerationMode;
  /** Single prompt / “styles” line when not in split lyric mode. */
  stylesPrompt: string;
  /** Secondary column for lyric-driven music modes. */
  lyrics: string;
  instrumental: boolean;
  modelLabel: string;
  voiceLabel: string;
  languageLabel: string;
}

/** Alias used by ported mixed-editor video node logic. */
export type ImageFlowNodeData = LocalCanvasNodeData;

/**
 * @param name - Display name
 * @param content - Video URL (also mirrored to `url` when set)
 */
export function createEditorVideoNodeData(name: string, content: string): ImageFlowNodeData {
  return {
    name,
    content,
    url: content || undefined,
    state: 'idle',
    nodeRuntimeData: {},
  };
}

/** React Flow `type` for local canvas video nodes (library `1003`). */
export const imageEditorVideoNodeType = '1003' as const;

/** React Flow `type` for local canvas audio nodes (library `1004`). */
export const imageEditorAudioNodeType = '1004' as const;

const defaultEditorAudioRuntime = (): AudioNodeRuntimeData => ({
  generationMode: 'tts',
  stylesPrompt: '',
  lyrics: '',
  instrumental: false,
  modelLabel: 'Minimax Speech 02 hd',
  voiceLabel: '沉稳高管',
  languageLabel: '中文-普通话',
});

/**
 * @param name - Display name
 * @param url - Audio URL (`url` and `content` mirror video nodes)
 */
export function createEditorAudioNodeData(name: string, url: string): LocalCanvasNodeData {
  return {
    name,
    url: url || undefined,
    content: url || undefined,
    state: 'idle',
    audioRuntime: defaultEditorAudioRuntime(),
    nodeRuntimeData: {},
  };
}
