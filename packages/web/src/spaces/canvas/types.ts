import { createContext, useContext, type CSSProperties } from 'react';
import type { CanvasNodeFields } from '@breatic/shared';

/**
 * The canonical Yjs `data` field shape, aliased as a named type so that
 * `CanvasWorkflowNodeData` can `extend` it (TypeScript requires an identifier,
 * not an inline indexed-access type, as an `extends` target).
 */
export type CanvasNodeData = CanvasNodeFields['data'];

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

/**
 * Canvas data node `data` shape used by ReactFlow canvas components.
 *
 * Extends `CanvasNodeFields["data"]` from `@breatic/shared` (the canonical
 * Yjs schema) with UI-only fields that live in React local state, NOT part
 * of the node-state-machine schema.
 *
 * Shared fields (from `CanvasNodeFields["data"]`, canvas-native schema):
 * - `name`              — display label
 * - `state`             — Yjs-shared lifecycle: 'idle' | 'handling'
 * - `handlingBy`        — who triggered the current handling (present iff state === 'handling')
 * - `errorMessage`      — last failure message (present when state === 'idle' + last op failed)
 * - `content`           — primary result URL (image/video/audio/3D) or text body
 * - `cover_url`         — video first-frame thumbnail
 * - `width`/`height`    — pixel dimensions (image/video)
 * - `duration`          — video/audio duration in seconds
 * - `sourceNodeId`      — parent node id when produced by mini-tool
 * - `operation`/`operationParams` — mini-tool provenance
 * - `outputType`/`kind`/`prompt`/`references`/`model`/`params` — generative node fields
 * - `childIds`          — group node child IDs
 * - `attachments`       — per-node upload pool (AttachRef[])
 *
 * UI-only fields (NOT in Yjs schema):
 * - `handles`           — React Flow handle config (React local state only)
 * - `attach`            — composer draft upload stash (React local state only)
 * - `params`            — composer parameter overrides (React local state only)
 *
 * B.2 retired the v12 `pickState` field + `PickState` / `PickPending`
 * / `PickResultBox` / `PickInject` / `PickConsumeFrom` types and the
 * `shouldHideNodeChatComposerForChatRecordCanvasPick` helper — the
 * v12 canvas-pick-into-editor flow was deleted with the rest of the
 * legacy chat composer files. v13 chip pick state lives in
 * `features/chat/contexts/ChipsPickContext` as per-user React state
 * and never round-trips through Yjs.
 *
 * TODO PR-C+: migrate `attach` / `params` to a dedicated React context or zustand slice
 * so they are no longer tunnelled through node.data.
 */
export interface CanvasWorkflowNodeData extends CanvasNodeData {
  /** UI-only — handle config from React Flow (NOT in Yjs). */
  handles?: { target?: HandleConfig[]; source?: HandleConfig[] };
  /**
   * UI-only — composer draft upload stash.
   *
   * TODO PR-C+: move to dedicated composer state.
   */
  attach?: unknown;
  /**
   * UI-only — composer parameter overrides.
   *
   * TODO PR-C+: move to dedicated composer state.
   */
  params?: Record<string, unknown>;
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
 * Bridges the main canvas React Flow viewport to siblings that live outside
 * `<ReactFlowProvider>` — e.g. `ChatPanel` mounted at the page level, the
 * document space's `RightToolbar`. Those siblings cannot call `useReactFlow`
 * directly (the provider isn't their ancestor), so the canvas registers an
 * imperative API via `setProjectCanvasViewportApi` while it is mounted and
 * clears it on unmount; consumers read it via `getProjectCanvasViewportApi()`
 * and treat `null` as "no canvas is currently mounted".
 */
export type ProjectCanvasViewportApi = {
  /**
   * Flow-space coordinates at the center of the visible canvas pane.
   *
   * @returns A point in the infinite-canvas coordinate system, or `null`
   *   when the pane is not laid out (zero-size or torn down).
   */
  getViewportCenterFlow: () => { x: number; y: number } | null;
  /**
   * Pan the canvas onto the first matching node id, keeping current zoom.
   *
   * @param nodeIds - Candidate React Flow node ids; the first one that
   *   currently exists in the canvas wins.
   * @param select - When true, selects only the centered node (clearing
   *   any prior selection) before panning.
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
