export type EditorTool = 'select' | 'crop' | 'blank' | 'brush' | 'text';

/** Right toolbar flyout list panels (data supplied by parent). */
export type ImageEditorRightSidePanelId = 'history' | 'assets' | 'attach' | 'link';

/** React Flow node `type` for raster image tiles inside the image editor. */
export type ImageEditorImageNodeType = '2002';

export const imageEditorImageNodeType = '2002' as const satisfies ImageEditorImageNodeType;

/** React Flow node `type` for video tiles inside the mixed editor. */
export type ImageEditorVideoNodeType = '2003';

export const imageEditorVideoNodeType = '2003' as const satisfies ImageEditorVideoNodeType;

/** React Flow node `type` for audio tiles inside the mixed editor. */
export type ImageEditorAudioNodeType = '2004';

export const imageEditorAudioNodeType = '2004' as const satisfies ImageEditorAudioNodeType;

/** Image editor node `data.nodeRuntimeData` (title lives on `data.name`, not here). */
export interface ImageEditorNodeRuntimeData {
  /** JSON string (HTML) prompt payload. */
  prompt?: string;
  /** User-selected upstream resource reference (URL or id). */
  upstream?: string;
  parameter?: Record<string, unknown>;
}

/**
 * Image editor flow image node `data` shape.
 *
 * `state` taxonomy (aligned with main canvas `CanvasNodeState` for `idle` +
 * `handling`; mixed editor adds a third value for the X pattern):
 *   - `'idle'`        — finalized node, ready.
 *   - `'handling'`    — backend long-running job in flight (AIGC worker).
 *                       Lives in Yjs so every collaborator sees the progress.
 *                       Same semantics as main canvas `'handling'`.
 *   - `'localPending'` — browser-local short task (ffmpeg.wasm / mini-tool
 *                       API await). Stored ONLY in the originator's
 *                       `pendingTasks` map, never in Yjs (X pattern —
 *                       prevents zombie tiles when the tab dies).
 */
export interface ImageEditorNodeData extends Record<string, unknown> {
  name: string;
  content: string;
  state: 'idle' | 'handling' | 'localPending';
  nodeRuntimeData: ImageEditorNodeRuntimeData;
  /**
   * Present only while canvas-pick mode is active for this node (e.g. Quick Edit).
   * Absent/null when pick mode is inactive.
   */
  pickState?: ImageEditorPickState | null;
}

/**
 * @param name - Display / file name
 * @param content - Image URL or data URL
 * @returns Default `data` for a new editor flow tile
 */
export const createEditorImageNodeData = (name: string, content: string): ImageEditorNodeData => ({
  name,
  content,
  state: 'idle',
  nodeRuntimeData: {},
});

/**
 * @param name - Display / file name
 * @param content - Video URL or data URL
 * @returns Default `data` for a new editor flow video tile
 */
export const createEditorVideoNodeData = (name: string, content: string): ImageEditorNodeData => ({
  name,
  content,
  state: 'idle',
  nodeRuntimeData: {},
});

/**
 * @param name - Display / file name
 * @param content - Audio URL or data URL
 * @returns Default `data` for a new editor flow audio tile
 */
export const createEditorAudioNodeData = (name: string, content: string): ImageEditorNodeData => ({
  name,
  content,
  state: 'idle',
  nodeRuntimeData: {},
});

/** Partial patch merged into editor node `data`. */
export type ImageEditorNodeDataPatch = Partial<
  Pick<ImageEditorNodeData, 'name' | 'content' | 'state' | 'nodeRuntimeData'>
>;

/** Alias for image tiles in the editor flow (same as {@link ImageEditorNodeData}). */
export type ImageFlowNodeData = ImageEditorNodeData;

/** Pending pick payload (until the chip is applied into the composer). */
export interface ImageEditorPickPending {
  targetNodeId: string;
  placeholderId: string;
  content: string;
  name: string;
  overlayAnchor?: { xPct: number; yPct: number };
}

export type ImageEditorPickConsumeFrom =
  | 'quickEdit'
  | 'nodeComposer'
  | 'chatRecordPanel'
  | 'quickEditMention'
  | 'nodeComposerMention'
  | 'chatRecordPanelMention'
  /** Video erase: canvas pick targets an image node for tracking (no composer chip pipeline). */
  | 'videoErase';

export interface ImageEditorPickResultBox {
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  /** Optional media timestamp anchor (seconds), used by video-frame-aligned overlays. */
  frameTimeSec?: number;
  /** Optional shape used by erase manual-box mode. */
  maskShape?: 'rectangle' | 'circle';
  /** Same id as the composer placeholder / chip; used to drop the overlay when the chip is removed. */
  placeholderId?: string;
  /** Source composer node id that created this pick. */
  sourceNodeId?: string;
  /** Resolved resource payload for re-selecting from overlay dropdown. */
  content?: string;
  name?: string;
}

/** Stored under `data.pickState` for image editor nodes. Present only while pick mode is active. */
export interface ImageEditorPickState {
  fromCanvas?: boolean;
  /** True when the associated composer input is focused and can accept inserts. */
  composerFocused?: boolean;
  /** Active erase mask tool when consumeFrom === 'videoErase'. */
  eraseMaskTool?: 'selection' | 'rectangle' | 'circle';
  /** @deprecated No longer written; “Apply to Node” updates main canvas image nodes instead. */
  inject?: { content: string; name: string; type: 'image' } | null;
  pending?: ImageEditorPickPending | null;
  pendingList?: ImageEditorPickPending[] | null;
  resultBoxes?: ImageEditorPickResultBox[] | null;
  /** Overlay dropdown picked a different recognized target; composer should update the matched chip. */
  selection?: ImageEditorPickPending | null;
  consumeFrom?: ImageEditorPickConsumeFrom | null;
}

/** @deprecated Use {@link ImageEditorPickState} */
export type ImageEditorAgentComposerPickState = ImageEditorPickState;
/** @deprecated Use {@link ImageEditorPickPending} */
export type ImageEditorAgentCanvasPickPending = ImageEditorPickPending;
/** @deprecated Use {@link ImageEditorPickConsumeFrom} */
export type ImageEditorAgentCanvasPickConsumeFrom = ImageEditorPickConsumeFrom;
/** @deprecated Use {@link ImageEditorPickResultBox} */
export type ImageEditorAgentCanvasPickResultBox = ImageEditorPickResultBox;
