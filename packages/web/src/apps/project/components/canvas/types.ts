import { createContext, useContext, type CSSProperties } from 'react';

/** Resource modality for composer / upstream lists (not the React Flow node `type` string). */
export type ResourceType = 'image' | 'file' | 'text' | 'audio' | 'video';

/** React Flow connection handle metadata. */
export interface HandleConfig {
  handleType: 'Text' | 'Image' | 'Video' | 'Audio';
  /** Max connections; `0` means unlimited. */
  number?: number;
  topOffset?: number;
  id?: string;
  style?: CSSProperties;
  className?: string;
  label?: string;
}

export type CanvasNodeState = 'idle' | 'handling';

/**
 * @deprecated Use flat fields on {@link CanvasWorkflowNodeData} instead.
 * Kept only for components not yet migrated.
 */
export interface CanvasNodeRuntimeData {
  runType?: 'parameter' | 'sensitive';
  attach?: unknown;
  prompt?: string;
  parameter?: Record<string, unknown>;
}

/** Picked canvas image injected into the composer (`content` = URL or data URL). */
export interface PickInject {
  content: string;
  name: string;
  type: 'image';
}

/** In-progress pick until the chip is applied. */
export interface PickPending {
  targetNodeId: string;
  placeholderId: string;
  content: string;
  name: string;
  overlayAnchor?: { xPct: number; yPct: number };
  /** Resource modality used when inserting the chip in mention mode. Defaults to 'image'. */
  resourceType?: ResourceType;
}

export interface PickResultBox {
  cxPct: number;
  cyPct: number;
  wPct: number;
  hPct: number;
  /** Same id as the composer placeholder / chip; used to drop the overlay when the chip is removed. */
  placeholderId?: string;
  /** Source composer node id that created this pick. */
  sourceNodeId?: string;
  /** Resolved resource payload for re-selecting from overlay dropdown. */
  content?: string;
  name?: string;
  resourceType?: ResourceType;
}

export type PickConsumeFrom = 'chatRecordPanel' | 'nodeComposer' | 'chatRecordPanelMention' | 'nodeComposerMention';

/** Stored under `data.pickState`. Present only while pick mode is active; deleted on exit. */
export interface PickState {
  /** True while the canvas is in image-pick mode for this node. */
  fromCanvas?: boolean;
  /** True when the associated composer input is focused and can accept inserts. */
  composerFocused?: boolean;
  inject?: PickInject | null;
  pending?: PickPending | null;
  pendingList?: PickPending[] | null;
  resultBoxes?: PickResultBox[] | null;
  /** Overlay dropdown picked a different recognized target; composer should update the matched chip. */
  selection?: PickPending | null;
  consumeFrom?: PickConsumeFrom | null;
}

/** @deprecated Use {@link PickState} */
export type AgentComposerPickState = PickState;
/** @deprecated Use {@link PickState} */
export type AgentComposerPickCanvasData = PickState;
/** @deprecated Use {@link PickInject} */
export type AgentCanvasPickInject = PickInject;
/** @deprecated Use {@link PickPending} */
export type AgentCanvasPickPending = PickPending;
/** @deprecated Use {@link PickResultBox} */
export type AgentCanvasPickResultBox = PickResultBox;
/** @deprecated Use {@link PickConsumeFrom} */
export type AgentCanvasPickConsumeFrom = PickConsumeFrom;

/**
 * Workflow canvas data node `data` shape.
 *
 * Mirrors the keys inside the nested `data` Y.Map on each canvas
 * node. Fields like `prompt` (Y.XmlFragment) are NOT included here
 * — they're accessed directly from Yjs when the node editor is
 * focused.
 *
 * UI-only fields (`pickState`, `handles`) live in React local state,
 * NOT in Yjs.
 */
export interface CanvasWorkflowNodeData {
  name: string;
  content: string;
  coverUrl?: string;
  state: CanvasNodeState;
  handlingBy?: { userId: string; username: string };
  runType?: 'parameter' | 'sensitive';
  /** Present only while pick mode is active for this node; absent otherwise. */
  pickState?: PickState | null;
  handles?: { target?: HandleConfig[]; source?: HandleConfig[] };
  /**
   * @deprecated Flat fields replace this. Kept for unmigrated components.
   */
  nodeRuntimeData?: CanvasNodeRuntimeData;
}

/**
 * Hide the node's bottom chat composer while the AI chat record panel is in canvas-pick mode for
 * this node (`consumeFrom === 'chatRecordPanel'`).
 *
 * @param data - Node `data` (may be partial).
 * @returns True when the floating node composer should be hidden.
 */
export function shouldHideNodeChatComposerForChatRecordCanvasPick(
  data: Partial<CanvasWorkflowNodeData> | undefined,
): boolean {
  const p = data?.pickState;
  return (
    Boolean(p?.fromCanvas) && (p?.consumeFrom === 'chatRecordPanel' || p?.consumeFrom === 'chatRecordPanelMention')
  );
}

/** Project layout focus: main canvas vs right editor (provided by project page). */
export type ProjectWorkspaceRegion = 'canvas' | 'rightEditor' | null;

export const ProjectWorkspaceRegionContext = createContext<ProjectWorkspaceRegion | undefined>(undefined);

/**
 * Reads {@link ProjectWorkspaceRegionContext} when under the project page provider.
 *
 * @returns Current region, or `undefined` if there is no provider.
 */
export function useProjectWorkspaceRegion(): ProjectWorkspaceRegion | undefined {
  return useContext(ProjectWorkspaceRegionContext);
}

// --- Main canvas viewport (pane center in flow space; registry for image editor sibling panel) ---

const projectCanvasFlowRootSelector = '[data-project-canvas-flow-root]';

/**
 * Client-space center of the main canvas pane, or `null` if the pane is missing or not laid out.
 */
export function getProjectCanvasPaneClientCenter(): { x: number; y: number } | null {
  const root = typeof document !== 'undefined' ? document.querySelector(projectCanvasFlowRootSelector) : null;
  if (!root) return null;
  const r = root.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Converts the canvas pane center to flow coordinates, or uses `fallback` screen point when the pane is unavailable.
 *
 * @param screenToFlowPosition - From `useReactFlow()` inside the project canvas.
 * @param fallback - Screen coordinates passed to `screenToFlowPosition` if the pane is missing.
 */
export function flowCenterFromCanvasPane(
  screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number },
  fallback: { x: number; y: number },
): { x: number; y: number } {
  const c = getProjectCanvasPaneClientCenter();
  return screenToFlowPosition(c ?? fallback);
}

/** Bridges main canvas React Flow viewport to code outside that tree (e.g. image editor panel). */
export type ProjectCanvasViewportApi = {
  /**
   * Flow-space coordinates at the center of the visible main canvas pane.
   * @returns Center point in the infinite canvas coordinate system.
   */
  getViewportCenterFlow: () => { x: number; y: number };
  /**
   * Centers the main workflow canvas on the first matching node id without changing current zoom.
   *
   * @param nodeIds - Candidate React Flow node ids (first existing id wins)
   * @param select - When true, clears previous selection and selects that node before centering.
   */
  centerOnFirstNodeId: (nodeIds: string[], select?: boolean) => void;
};

let registeredProjectCanvasViewportApi: ProjectCanvasViewportApi | null = null;

/**
 * @param next - API while the canvas flow is mounted, or `null` on teardown.
 */
export function setProjectCanvasViewportApi(next: ProjectCanvasViewportApi | null): void {
  registeredProjectCanvasViewportApi = next;
}

/**
 * @returns Registered viewport API when the project canvas is mounted, otherwise `null`.
 */
export function getProjectCanvasViewportApi(): ProjectCanvasViewportApi | null {
  return registeredProjectCanvasViewportApi;
}
