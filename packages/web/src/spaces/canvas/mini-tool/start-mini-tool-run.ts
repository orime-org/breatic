// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of a mini-tool's Run, from the snapshot to the request or upload
 * (inner#888 §7.5), on the pattern of Understand: the result nodes and their
 * edges are written before anything is asked of the server, because they are
 * the reader's content; what the run does then lands on their task rows.
 */

import {
  t,
} from '@breatic/shared';
import {
  outputTemplateOf,
  type MiniToolRequest,
  type MiniToolRequestSlot,
  type MiniToolSlotValue,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from '@breatic/shared/mini-tools';

import { miniToolsApi } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import type { MiniToolUploadTag } from '@web/data/upload/ingest-upload';
import { UploadFailedError } from '@web/data/upload/media-upload';
import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { DrawingEmptyError, type DrawingExport } from '@web/spaces/canvas/mini-tool/export-drawing';
import { exportsBeforeRun } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import { outputPlacementOf, type OutputSize } from '@web/spaces/canvas/mini-tool/output-placement';
import type { DrawingKind } from '@web/spaces/canvas/mini-tool/paint-drawing';
import { createEmptyNode, type CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';
import type { DrawOp } from '@web/stores/drawing-draft';

/** The node a tool reads, as the canvas holds it. */
export interface MiniToolSourceNode {
  id: string;
  /** What the reader calls it; the result nodes are named after it. */
  name: string | undefined;
  /** Its stored position, group-relative when it sits in one. */
  position: { x: number; y: number };
  /** The origin of the group holding it, or null when top-level. */
  groupOrigin: { x: number; y: number } | null;
  mimeType?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/** The drawing as it stood at the press. */
export interface MiniToolDrawingSnapshot {
  kind: DrawingKind;
  ops: readonly DrawOp[];
}

/** The uploaded images a drawing tool's request carries. */
type DrawingUrls = NonNullable<MiniToolRequest['drawing']>;

/** One file a browser tool exported, and its pixel size when the export knows it. */
export interface ExportedFile {
  file: File;
  size?: OutputSize;
}

/** Everything one press needs. */
export interface MiniToolRun {
  projectId: string;
  spaceId: string;
  /** Who pressed, which is who the new nodes are created by. */
  userId: string;
  spec: MiniToolSpec;
  /** The draft as it stood at the press. */
  snapshot: MiniToolSnapshot;
  source: MiniToolSourceNode;
  /** Whether the source node is still on the canvas, asked at build time. */
  sourceExists: () => boolean;
  /** Make a browser tool's files from the snapshot, one per result in order, with their pixel size when known. */
  exportFile: (spec: MiniToolSpec, snapshot: MiniToolSnapshot) => Promise<ExportedFile[]>;
  /** Upload a browser tool's one file into its node, tagged with the tool. */
  fillUpload: (nodeId: string, file: File, modality: CreatableNodeType, tag: MiniToolUploadTag) => void;
  /** Upload a browser tool's files into their nodes in one batch, tagged with the tool. */
  fillUploads: (entries: { nodeId: string; file: File }[], tag: MiniToolUploadTag) => void;
  /** The drawing at the press, on a tool that draws. */
  drawing?: MiniToolDrawingSnapshot | undefined;
  /** Make a drawing tool's images from the source and the drawing. */
  exportDrawing: (url: string, kind: DrawingKind, ops: readonly DrawOp[]) => Promise<DrawingExport>;
  /** Upload an image with no node of its own, answering where it is kept. */
  uploadImage: (file: File) => Promise<string>;
  /** Show the press as under way, or not; a later opening of the panel is left alone. */
  setExporting: (exporting: boolean) => void;
  /** Whether the panel is still the opening the press was made in. */
  stillOpen: () => boolean;
  /** Called with the nodes the press built, the moment they exist, while the panel is the same opening. */
  onBuilt: (built: { id: string; position: { x: number; y: number } }[]) => void;
}

/**
 * One picked item as the request carries it.
 * @param value - The pick.
 * @returns Its address and length.
 */
function slotOf(value: MiniToolSlotValue): MiniToolRequestSlot {
  return { url: value.url, ...(value.duration !== undefined && { duration: value.duration }) };
}

/**
 * The request a server tool's press sends.
 * @param run - The press.
 * @param nodeIds - The result nodes, in output order.
 * @param drawing - The uploaded images of a drawing tool's drawing.
 * @returns The body.
 */
function requestOf(run: MiniToolRun, nodeIds: string[], drawing: DrawingUrls | undefined): MiniToolRequest {
  const { spec, snapshot, source } = run;
  const slots: MiniToolRequest['slots'] = {};
  for (const slot of spec.slots) {
    const held = snapshot.slots[slot.key];
    if (held === undefined) continue;
    slots[slot.key] = Array.isArray(held)
      ? (held as readonly MiniToolSlotValue[]).map(slotOf)
      : slotOf(held as MiniToolSlotValue);
  }
  return {
    tool: spec.id,
    project_id: run.projectId,
    space_id: run.spaceId,
    node_ids: nodeIds,
    source: {
      url: snapshot.source.url,
      ...(source.mimeType !== undefined && { mime_type: source.mimeType }),
      ...(source.width !== undefined && { width: source.width }),
      ...(source.height !== undefined && { height: source.height }),
      ...(snapshot.source.duration !== undefined && { duration: snapshot.source.duration }),
    },
    ...(spec.prompt !== undefined && { prompt: snapshot.prompt }),
    params: { ...snapshot.params },
    slots,
    ...(drawing !== undefined && { drawing }),
  };
}

/**
 * Say why an upload of a drawing's image did not complete.
 * @param err - What the upload threw.
 */
function toastUploadFailure(err: unknown): void {
  // Without a task id every reason resolves to a toast.
  const plan = resolveUploadFailure({ reason: err instanceof UploadFailedError ? err.reason : 'upload' });
  if (plan.kind === 'toastOnly') toast[plan.severity](t(plan.toastKey));
}

/**
 * Export a drawing tool's images and upload them.
 * @param run - The press.
 * @param drawing - The drawing at the press.
 * @returns Where the images are kept, or null when the reader was told why not.
 */
async function uploadDrawing(run: MiniToolRun, drawing: MiniToolDrawingSnapshot): Promise<DrawingUrls | null> {
  let made: DrawingExport;
  try {
    made = await run.exportDrawing(run.snapshot.source.url, drawing.kind, drawing.ops);
  } catch (err) {
    toast.warning(
      t(err instanceof DrawingEmptyError ? 'canvas.miniTool.panel.drawingEmpty' : 'canvas.miniTool.panel.exportFailed'),
    );
    return null;
  }
  const prefix = outputTemplateOf(run.spec).namePrefix;
  /**
   * A PNG file named after the tool's output and the part it is.
   * @param blob - The image.
   * @param part - `mask` or `sketch`.
   * @returns The file.
   */
  const pngFile = (blob: Blob, part: string): File => new File([blob], `${prefix}-${part}.png`, { type: 'image/png' });
  try {
    return 'mask' in made
      ? { mask: await run.uploadImage(pngFile(made.mask, 'mask')) }
      : { image: await run.uploadImage(pngFile(made.image, 'sketch')) };
  } catch (err) {
    toastUploadFailure(err);
    return null;
  }
}

/**
 * Everything before the build: the browser's own work and the check that the
 * source is still there.
 * @param run - The press.
 * @returns The file or images made, or null when the press stops here.
 */
async function prepare(run: MiniToolRun): Promise<{ files?: ExportedFile[]; drawing?: DrawingUrls } | null> {
  const { spec, snapshot } = run;
  let files: ExportedFile[] | undefined;
  let drawing: DrawingUrls | undefined;
  if (spec.run.kind === 'browser') {
    try {
      files = await run.exportFile(spec, snapshot);
    } catch {
      toast.warning(t('canvas.miniTool.panel.exportFailed'));
      return null;
    }
  }
  if (spec.drawing !== undefined && run.drawing !== undefined) {
    const urls = await uploadDrawing(run, run.drawing);
    if (urls === null) return null;
    drawing = urls;
  }
  if (!run.sourceExists()) {
    toast.warning(t('canvas.miniTool.panel.sourceGone'));
    return null;
  }
  return { ...(files !== undefined && { files }), ...(drawing !== undefined && { drawing }) };
}

/**
 * Build the result nodes, wire them to the source, and start the run.
 *
 * A browser tool's file, or a drawing tool's images and their upload, are made
 * first: a failed export or upload, like a source deleted meanwhile, builds
 * nothing and says so. A server tool's request
 * goes out after the nodes exist; a refusal opened no row, so the press is
 * where it is said, and the nodes stay.
 * @param run - The press.
 * @returns Nothing; what happens next is on the new nodes' task rows.
 */
export async function startMiniToolRun(run: MiniToolRun): Promise<void> {
  const { projectId, spaceId, userId, spec, source } = run;

  const exports = exportsBeforeRun(spec);
  if (exports) run.setExporting(true);
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(run);
  } finally {
    if (exports) run.setExporting(false);
  }
  if (prepared === null) return;
  const { files, drawing } = prepared;

  const base = {
    x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x,
    y: source.position.y + (source.groupOrigin?.y ?? 0),
  };
  const nodes = outputPlacementOf(spec, run.snapshot.params, files?.map((made) => made.size) ?? [], source.name).map((placed) => {
    const built = createEmptyNode(placed.output.modality, { x: base.x + placed.x, y: base.y + placed.y }, userId);
    return { ...built, data: { ...built.data, name: placed.name } };
  });
  runCanvasUndoBatch(projectId, spaceId, () => {
    for (const node of nodes) {
      addNode(projectId, spaceId, node);
      addEdge(projectId, spaceId, {
        id: `${source.id}->${node.id}`,
        source: source.id,
        target: node.id,
        toolId: spec.id,
      });
    }
  });
  if (run.stillOpen()) run.onBuilt(nodes.map((node) => ({ id: node.id, position: node.position })));

  if (files !== undefined) {
    const tag: MiniToolUploadTag = { source: 'mini_tool', toolName: spec.id };
    const output = outputTemplateOf(spec);
    const [node] = nodes;
    const [only] = files;
    if (files.length === 1 && node !== undefined && only !== undefined && output.modality !== 'text') {
      run.fillUpload(node.id, only.file, output.modality, tag);
    } else if (files.length > 1) {
      run.fillUploads(
        nodes.flatMap((built, index) => {
          const made = files[index];
          return made === undefined ? [] : [{ nodeId: built.id, file: made.file }];
        }),
        tag,
      );
    }
    return;
  }

  try {
    await miniToolsApi.run(requestOf(run, nodes.map((node) => node.id), drawing));
  } catch (err) {
    // The server's sentence when it gave one, already in the reader's
    // language; a request that never arrived has none.
    toast.error(
      err instanceof ApiException && err.fromServer && err.message
        ? err.message
        : t('canvas.miniTool.panel.couldNotStart'),
    );
  }
}
