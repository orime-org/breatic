// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas node **view** layer — the component-facing projection of the
 * shared wire contract {@link CanvasNodeFields}.
 *
 * Two layers, one source of truth:
 *   - **wire** = `@breatic/shared`'s `CanvasNodeFields` (the Yjs Y.Map
 *     shape; a flat field bag; what Collab / Worker read and write).
 *   - **view** = the narrowed, per-modality types below (what the node
 *     components render). `toNodeView` is the single bridge between them.
 *
 * The view deliberately differs from the wire in three places, so each
 * component receives exactly what it renders:
 *   - `status` is a derived 3-state (`idle` / `handling` / `error`)
 *     collapsed from wire `state` (2-state) + `errorMessage`.
 *   - `content` is the unified primary payload (URL or text body) — the
 *     old frontend split this into `url` (assets) vs `content` (text).
 *   - `createdAt` on an annotation is an epoch-ms `number` (the wire's
 *     canonical timestamp), not an ISO string.
 *
 * `kind` is the view discriminant; it carries the same string values as
 * wire `type`. Every wire `type` now has a view (the 6 content modalities,
 * `annotation`, and `group`); `toNodeView` returns `null` only for a dirty
 * or unknown `type`.
 *
 * Content views also project the Generate panel's inputs (model revision
 * 2026-06-15): wire `kind` (the generate sub-mode) surfaces as
 * `generateMode` to avoid colliding with the view's `kind` discriminant.
 */

import { HANDLING_TIMEOUT_MS } from '@breatic/shared';
import type { CanvasNodeFields, ReferenceItem } from '@breatic/shared';

/** The 6 content modalities that own a renderable payload. */
export type Modality = 'text' | 'image' | 'audio' | 'video' | '3d' | 'web';

/** Every kind the canvas node components render: the 6 content + annotation + group. */
export type NodeKind = Modality | 'annotation' | 'group';

/**
 * Derived body status that drives the placeholder / skeleton / error /
 * content branch. Collapsed from wire `state` + `errorMessage` by
 * {@link deriveStatus} — it is NOT a wire field.
 */
export type DisplayStatus = 'idle' | 'handling' | 'error';

/** Fields shared by every node view (content + annotation). */
interface NodeViewCommon {
  /**
   * User-driven manual lock — drives the lock indicator + blocks editing.
   * Optional in the view (the node body takes `locked` as its own optional
   * prop); `toNodeView` always populates it from the required wire field.
   */
  locked?: boolean;
}

/** Fields shared by every content-node view. */
interface ContentNodeViewBase extends NodeViewCommon {
  /**
   * Editable display name shown in the node name header (fixed-English
   * default). Optional in the view (like `locked`) so component tests that
   * only exercise the body need not spell it out; `toNodeView` always
   * populates it from the required wire `data.name`.
   */
  name?: string;
  status: DisplayStatus;
  errorMessage?: string;
  // Generate panel inputs (model revision 2026-06-15) — a content node can
  // carry the Generate action's collaborative inputs. All optional: a node
  // with no Generate history simply omits them.
  /** Rich-text prompt body (Y.XmlFragment at runtime). */
  prompt?: unknown;
  /** Selected model id. */
  model?: string;
  /** Reference rail rows feeding the prompt context. */
  references?: ReferenceItem[];
  /** Model-specific request params. */
  params?: Record<string, unknown>;
  /** Generate sub-mode (wire `kind`), renamed to avoid the `kind` discriminant clash. */
  generateMode?: string;
}

export interface TextNodeView extends ContentNodeViewBase {
  kind: 'text';
  /** Text body (empty string when the node has no content yet). */
  content: string;
}

export interface ImageNodeView extends ContentNodeViewBase {
  kind: 'image';
  /** Image asset URL. */
  content?: string;
}

export interface AudioNodeView extends ContentNodeViewBase {
  kind: 'audio';
  /** Audio asset URL. */
  content?: string;
  /** Duration in seconds. */
  duration?: number;
}

export interface VideoNodeView extends ContentNodeViewBase {
  kind: 'video';
  /** Video asset URL. */
  content?: string;
  /** Poster / first-frame thumbnail URL. */
  coverUrl?: string;
  /** Duration in seconds. */
  duration?: number;
}

export interface ThreeDNodeView extends ContentNodeViewBase {
  kind: '3d';
  /** .glb / .gltf / .usdz model URL. */
  content?: string;
}

export interface WebNodeView extends ContentNodeViewBase {
  kind: 'web';
  /** External page URL embedded in a sandboxed iframe. */
  content?: string;
}

export interface AnnotationNodeView extends NodeViewCommon {
  kind: 'annotation';
  /** Message body. */
  content: string;
  /** Author user id (sticky, set at creation; never transferred). */
  createdBy: string;
  /** Creation time as epoch ms. */
  createdAt: number;
}

/**
 * Group container view (model revision 2026-06-15) — a canvas region that
 * holds other nodes. A core feature; the full grouping interactions
 * (marquee-group, lock-move, ReactFlow `parentId` containment) land in the
 * dedicated group slice. This view carries what the container renders.
 */
export interface GroupNodeView extends NodeViewCommon {
  kind: 'group';
  /** Group display name shown in the group header (default "Group"). */
  name?: string;
  /**
   * Authoritative group width/height (group redesign 2026-06-23 — the group is
   * now a manual-size box, Figma-Frame-style) — the group's canvas footprint,
   * rendered directly instead of derived from members. Members bind back via
   * their own top-level `parentId`.
   */
  width?: number;
  height?: number;
  /** Group container tint. */
  backgroundColor?: string;
}

/** Any of the 6 content-node views (excludes the annotation sticky). */
export type ContentNodeView =
  | TextNodeView
  | ImageNodeView
  | AudioNodeView
  | VideoNodeView
  | ThreeDNodeView
  | WebNodeView;

/** Discriminated union of every renderable node view. */
export type NodeView = ContentNodeView | AnnotationNodeView | GroupNodeView;

/**
 * Collapses the wire 2-state lifecycle + last error into the 3-state
 * display status the components branch on. The wire encodes a failure as
 * `state: 'idle'` with a non-null `errorMessage` (there is no third wire
 * state), so `handling` takes priority and a lingering error only shows
 * once the node is back to `idle`.
 *
 * Lease timeout fallback (#1569): a `handling` node whose lease
 * (`handlingBy.startedAt` + HANDLING_TIMEOUT_MS) has expired derives
 * `error` at the DISPLAY level — the collab sweeper is the authority that
 * writes the timeout back into Yjs; this render-side check only spares a
 * viewer from staring at an hours-old skeleton while the sweep is pending.
 * Legacy zombies without `handlingBy` keep deriving `handling` here (no
 * lease to measure); the sweeper reclaims them server-side.
 * @param data - The wire data fields carrying `state`, `errorMessage` and `handlingBy`.
 * @param now - Clock (epoch ms), injectable for tests; defaults to `Date.now()`.
 * @returns The derived display status.
 */
export function deriveStatus(
  data: Pick<CanvasNodeFields['data'], 'state' | 'errorMessage' | 'handlingBy'>,
  now: number = Date.now(),
): DisplayStatus {
  if (data.state === 'handling') {
    const startedAt = data.handlingBy?.startedAt;
    if (startedAt !== undefined && now - startedAt > HANDLING_TIMEOUT_MS) {
      return 'error';
    }
    return 'handling';
  }
  if (data.errorMessage != null) return 'error';
  return 'idle';
}

/**
 * Projects a wire {@link CanvasNodeFields} into the narrowed view its
 * component renders. Every known `type` maps to a view; returns `null`
 * only for a dirty / unknown `type` — the caller treats `null` as "skip
 * this node" rather than crashing.
 * @param fields - The wire node fields read from the canvas Yjs doc.
 * @returns The matching node view, or `null` when the type is unknown.
 */
export function toNodeView(fields: CanvasNodeFields): NodeView | null {
  const { type, data } = fields;
  const status = deriveStatus(data);
  const errorMessage = data.errorMessage;
  const locked = data.locked;
  // Common content-view fields: the editable name (node name header), the
  // derived status, and the Generate panel inputs. Wire `kind` (the generate
  // sub-mode) → view `generateMode` avoids clashing with the view's `kind`
  // modality discriminant.
  const contentCommon = {
    name: data.name,
    status,
    errorMessage,
    locked,
    prompt: data.prompt,
    model: data.model,
    references: data.references,
    params: data.params,
    generateMode: data.kind,
  };
  switch (type) {
    case 'text':
      return { kind: 'text', content: data.content ?? '', ...contentCommon };
    case 'image':
      return { kind: 'image', content: data.content, ...contentCommon };
    case 'audio':
      return { kind: 'audio', content: data.content, duration: data.duration, ...contentCommon };
    case 'video':
      return {
        kind: 'video',
        content: data.content,
        coverUrl: data.coverUrl,
        duration: data.duration,
        ...contentCommon,
      };
    case '3d':
      return { kind: '3d', content: data.content, ...contentCommon };
    case 'web':
      return { kind: 'web', content: data.content, ...contentCommon };
    case 'annotation':
      return {
        kind: 'annotation',
        content: data.content ?? '',
        createdBy: data.createdBy,
        createdAt: data.createdAt,
        locked,
      };
    case 'group':
      return {
        kind: 'group',
        name: data.name,
        width: data.width,
        height: data.height,
        backgroundColor: data.backgroundColor,
        locked,
      };
    default:
      return null;
  }
}

/**
 * Narrows a {@link NodeView} to the 6 content modalities, excluding the
 * annotation sticky. Useful where only content nodes are valid mini-tool
 * sources or carry a status branch.
 * @param view - The node view to test.
 * @returns True when the view is a content node (i.e. not an annotation).
 */
export function isContentNodeView(view: NodeView): view is ContentNodeView {
  return view.kind !== 'annotation';
}
