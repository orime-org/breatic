// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of a mini-tool's Run, from the snapshot to the request or upload
 * (inner#888 §7.5), on the pattern of Understand: the result nodes and their
 * edges are written before anything is asked of the server, because they are
 * the reader's content; what the run does then lands on their task rows.
 */

import { newId, t } from '@breatic/shared';
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
import { runOnce, useRunning, type RunOnceOutcome } from '@web/stores/task-actions-in-flight';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { ImageTooLargeError } from '@web/spaces/canvas/mini-tool/adjust-export';
import { DrawingEmptyError, type DrawingExport } from '@web/spaces/canvas/mini-tool/export-drawing';
import { exportsBeforeRun } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import { outputPlacementOf, plannedOutputSizes, type PlacedOutput } from '@web/spaces/canvas/mini-tool/output-placement';
import { groupBackgroundFor } from '@web/spaces/canvas/group-background';
import { planGroupAround } from '@web/spaces/canvas/group-creation';
import { writeGroup } from '@web/spaces/canvas/group-write';
import { MODALITY_LABEL } from '@web/spaces/canvas/nodes/_shared/modality';
import type { DrawingKind } from '@web/spaces/canvas/mini-tool/paint-drawing';
import type { ExpandFrame, PixelSize } from '@web/spaces/canvas/mini-tool/expand-frame';
import { createEmptyNode, type CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { resolveUploadFailure } from '@web/spaces/canvas/upload-failure';
import type { DrawOp } from '@web/stores/drawing-draft';
import type { MarkObject } from '@web/stores/mark-draft';
import { useUploadMarksStore, type UploadMarkMessage } from '@web/stores/upload-marks';

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

/**
 * What the reader made on the node, copied out at the press (inner#1303 §5):
 * a drawing tool's strokes, an expand tool's frame with the source's pixel
 * size it was measured against, or markup's objects.
 */
export type MiniToolCapture =
  | { kind: 'strokes'; ops: readonly DrawOp[] }
  | { kind: 'expand'; frame: ExpandFrame; sourceSize: PixelSize }
  | { kind: 'mark'; objects: readonly MarkObject[] };

/** The images an expand press uploads: the padded picture and the mask of its new area. */
export interface ExpandExport {
  image: Blob;
  mask: Blob;
}

/** The uploaded images a drawing tool's request carries. */
type DrawingUrls = NonNullable<MiniToolRequest['drawing']>;

/** What a press uploaded before its request: a drawing's images, or an expand's padded picture and mask. */
interface PressUploads {
  drawing?: DrawingUrls;
  expand?: NonNullable<MiniToolRequest['expand']>;
}

/** One file a browser tool exported. */
export interface ExportedFile {
  file: File;
}

/** The group a press put its results into, and the box it covers. */
export interface BuiltGroup {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
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
  /** Make a browser tool's files from the snapshot and the capture, one per result in order. */
  exportFile: (spec: MiniToolSpec, snapshot: MiniToolSnapshot, capture?: MiniToolCapture) => Promise<ExportedFile[]>;
  /** Upload a browser tool's one file into its node, tagged with the tool, carrying on the press's operation. */
  fillUpload: (nodeId: string, file: File, modality: CreatableNodeType, tag: MiniToolUploadTag, markOp: string) => void;
  /** Upload a browser tool's files into their nodes in one batch, tagged with the tool, each carrying on its node's operation. */
  fillUploads: (entries: { nodeId: string; file: File; markOp: string }[], tag: MiniToolUploadTag) => void;
  /** What the reader made on the node, copied out at the press. */
  capture?: MiniToolCapture | undefined;
  /** Make a drawing tool's images from the source and the drawing. */
  exportDrawing: (url: string, kind: DrawingKind, ops: readonly DrawOp[]) => Promise<DrawingExport>;
  /** Make an expand tool's padded picture and mask from the source and the frame. */
  exportExpand: (url: string, frame: ExpandFrame, sourceSize: PixelSize) => Promise<ExpandExport>;
  /** Upload an image with no node of its own, answering where it is kept. */
  uploadImage: (file: File) => Promise<string>;
  /** Show the press as under way, or not; a later opening of the panel is left alone. */
  setExporting: (exporting: boolean) => void;
  /** Whether the panel is still the opening the press was made in. */
  stillOpen: () => boolean;
  /**
   * Called with the nodes the press built, each with the footprint it was laid
   * out at, and the group they went into when the tool groups its results, the
   * moment they exist, while the panel is the same opening.
   */
  onBuilt: (
    built: { id: string; position: { x: number; y: number }; width: number; height: number }[],
    group?: BuiltGroup,
  ) => void;
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
 * @param uploads - What the press uploaded before the request.
 * @returns The body.
 */
function requestOf(run: MiniToolRun, nodeIds: string[], uploads: PressUploads): MiniToolRequest {
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
    ...(uploads.drawing !== undefined && { drawing: uploads.drawing }),
    ...(uploads.expand !== undefined && { expand: uploads.expand }),
  };
}

/** Why a press stopped before its run started, said on the nodes it built. */
type Stopped = { failed: UploadMarkMessage };

/**
 * Why an upload of a drawing's image did not complete.
 * @param err - What the upload threw.
 * @returns The message for the nodes.
 */
function uploadFailureMessage(err: unknown): UploadMarkMessage {
  // Without a task id every reason resolves to a message of its own.
  const plan = resolveUploadFailure({ reason: err instanceof UploadFailedError ? err.reason : 'upload' });
  return { key: plan.kind === 'toastOnly' ? plan.toastKey : 'canvas.upload.failed' };
}

/**
 * Export a drawing tool's images and upload them.
 * @param run - The press.
 * @param kind - Mask or sketch.
 * @param ops - The strokes at the press.
 * @returns Where the images are kept, or why they could not be made.
 */
async function uploadDrawing(run: MiniToolRun, kind: DrawingKind, ops: readonly DrawOp[]): Promise<DrawingUrls | Stopped> {
  let made: DrawingExport;
  try {
    made = await run.exportDrawing(run.snapshot.source.url, kind, ops);
  } catch (err) {
    return {
      failed: { key: err instanceof DrawingEmptyError ? 'canvas.miniTool.panel.drawingEmpty' : 'canvas.miniTool.panel.exportFailed' },
    };
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
    return { failed: uploadFailureMessage(err) };
  }
}

/**
 * Export an expand tool's padded picture and mask and upload both at once.
 * @param run - The press.
 * @param frame - The frame at the press.
 * @param sourceSize - The source's pixels the frame was measured against.
 * @returns Where the two images are kept, or why they could not be made.
 */
async function uploadExpand(
  run: MiniToolRun,
  frame: ExpandFrame,
  sourceSize: PixelSize,
): Promise<NonNullable<MiniToolRequest['expand']> | Stopped> {
  let made: ExpandExport;
  try {
    made = await run.exportExpand(run.snapshot.source.url, frame, sourceSize);
  } catch {
    return { failed: { key: 'canvas.miniTool.panel.exportFailed' } };
  }
  const prefix = outputTemplateOf(run.spec).namePrefix;
  try {
    const [image, mask] = await Promise.all([
      run.uploadImage(new File([made.image], `${prefix}-image.png`, { type: 'image/png' })),
      run.uploadImage(new File([made.mask], `${prefix}-mask.png`, { type: 'image/png' })),
    ]);
    return { image, mask };
  } catch (err) {
    return { failed: uploadFailureMessage(err) };
  }
}

/**
 * The browser's own work for a press, after its nodes are built, and the check
 * that the source is still there.
 * @param run - The press.
 * @returns The browser tool's files and what the press uploaded, or why the press stops here.
 */
async function prepare(run: MiniToolRun): Promise<{ files?: ExportedFile[]; uploads: PressUploads } | Stopped> {
  const { spec, snapshot, capture } = run;
  let files: ExportedFile[] | undefined;
  const uploads: PressUploads = {};
  if (spec.run.kind === 'browser') {
    try {
      files = await run.exportFile(spec, snapshot, capture);
    } catch (err) {
      return {
        failed: { key: err instanceof ImageTooLargeError ? 'canvas.miniTool.panel.imageTooLarge' : 'canvas.miniTool.panel.exportFailed' },
      };
    }
  }
  if (spec.drawing !== undefined && capture?.kind === 'strokes') {
    const urls = await uploadDrawing(run, spec.drawing.kind, capture.ops);
    if ('failed' in urls) return urls;
    uploads.drawing = urls;
  }
  if (spec.expand !== undefined && capture?.kind === 'expand') {
    const urls = await uploadExpand(run, capture.frame, capture.sourceSize);
    if ('failed' in urls) return urls;
    uploads.expand = urls;
  }
  if (!run.sourceExists()) return { failed: { key: 'canvas.miniTool.panel.sourceGone' } };
  return { ...(files !== undefined && { files }), uploads };
}

/**
 * Put a press's result nodes into a new group named after the tool's output
 * and the source, sized from the nodes' laid-out footprints. Called inside the
 * press's undo batch, so one undo takes the nodes and the group back.
 * @param run - The press.
 * @param nodes - The result nodes just added.
 * @param placements - Their placements, carrying each node's footprint.
 * @returns The group, or undefined when there was nothing to group.
 */
function groupResults(
  run: MiniToolRun,
  nodes: readonly { id: string; type: string; position: { x: number; y: number } }[],
  placements: readonly PlacedOutput[],
): BuiltGroup | undefined {
  const plan = planGroupAround(
    nodes.map((node, index) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      width: placements[index]?.width,
      height: placements[index]?.height,
      data: {},
    })),
    newId(),
  );
  if (plan === null) return undefined;
  const output = outputTemplateOf(run.spec);
  writeGroup(
    run.projectId,
    run.spaceId,
    plan,
    run.userId,
    groupBackgroundFor(Math.random()),
    `${output.namePrefix}-${run.source.name ?? MODALITY_LABEL[output.modality]}`,
  );
  return { id: plan.groupId, position: plan.position, width: plan.width, height: plan.height };
}

/**
 * The run-once intent of a press of one tool on one node (inner#1490).
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node the tool runs on.
 * @param toolId - The tool.
 * @returns The intent id.
 */
export function miniToolIntent(spaceId: string, nodeId: string, toolId: string): string {
  return `mini-tool:${spaceId}:${nodeId}:${toolId}`;
}

/**
 * Whether a press of this tool on this node is still waiting; the Run button reads it.
 * @param spaceId - The Space the node lives in.
 * @param nodeId - The node the tool runs on.
 * @param toolId - The tool.
 * @returns True while it waits.
 */
export function useMiniToolRunning(spaceId: string, nodeId: string, toolId: string): boolean {
  return useRunning(miniToolIntent(spaceId, nodeId, toolId)) !== undefined;
}

/** Ends a press's marks on its nodes: answered, or failed with a message. */
type Settle = (message?: UploadMarkMessage) => void;

/**
 * What a refused or unreached request says on the nodes: the server's
 * sentence when it gave one, already in the reader's language; a request that
 * never arrived has none.
 * @param err - What the send rejected with.
 * @returns The message.
 */
function refusalOf(err: unknown): UploadMarkMessage {
  return err instanceof ApiException && err.fromServer && err.message
    ? { text: err.message }
    : { key: 'canvas.miniTool.panel.couldNotStart' };
}

/**
 * Build the result nodes, wire them to the source, and start the run.
 *
 * The nodes and their group are built at the press, laid out from the sizes
 * the results will have, and the uploader sees them wait (inner#1303 §6.7).
 * The browser's own work follows: a browser tool's files, a drawing tool's
 * images, or an expand tool's padded picture and mask, and their upload. A failure there, a source deleted meanwhile, or a
 * server tool's refused request is said on the nodes, which stay.
 *
 * One press per tool and node runs at a time (inner#1490): a press while one
 * waits builds nothing, and an unanswered request is re-sent with the same key
 * without building a second set of nodes. The nodes wait until that request
 * has its final answer, or until the press is let go without one.
 * @param run - The press.
 * @returns The press's whole run; what happens next is on the new nodes' task rows.
 */
export function startMiniToolRun(run: MiniToolRun): Promise<RunOnceOutcome<unknown>> {
  let settle: Settle | null = null;
  return runOnce(miniToolIntent(run.spaceId, run.source.id, run.spec.id), {
    scope: 'mini-tool',
    prepare: () =>
      buildMiniToolRun(run, (built) => {
        settle = built;
      }),
    send: (key, body: MiniToolRequest) => miniToolsApi.run(body, key),
    onDone: () => {
      settle?.();
      return undefined;
    },
    onFailure: (err) => {
      if (settle === null) toast.error(t('canvas.miniTool.panel.couldNotStart'));
      else settle(refusalOf(err));
    },
  }).then((outcome) => {
    // Let go after the request went out, with no final answer: the nodes stop
    // waiting, and their task icons say whatever ran.
    if (outcome.kind === 'released') settle?.();
    return outcome;
  });
}

/**
 * The browser's half of a press: build and wire the result nodes, make what
 * the tool needs, and fix the request body. A browser tool hands its file to
 * the upload and sends nothing; a failure is said on the nodes and sends
 * nothing.
 * @param run - The press.
 * @param onSent - Receives how to end the nodes' marks once a request is to be sent.
 * @returns The request body, or null when nothing is to be sent.
 */
async function buildMiniToolRun(run: MiniToolRun, onSent: (settle: Settle) => void): Promise<MiniToolRequest | null> {
  const { projectId, spaceId, userId, spec, source } = run;

  const base = {
    x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x,
    y: source.position.y + (source.groupOrigin?.y ?? 0),
  };
  const placements = outputPlacementOf(
    spec,
    run.snapshot.params,
    plannedOutputSizes(spec, run.snapshot.params, source),
    source.name,
  );
  // A result whose size is planned is built with it, so it holds its place at
  // the size it will have, for everyone (inner#1303 §6.7); the result's own
  // media fields replace it when it lands (`writeNodeMedia`).
  const nodes = placements.map((placed) => {
    const built = createEmptyNode(placed.output.modality, { x: base.x + placed.x, y: base.y + placed.y }, userId);
    const size = placed.size === undefined ? {} : { mediaWidth: placed.size.width, mediaHeight: placed.size.height };
    return { ...built, data: { ...built.data, name: placed.name, ...size } };
  });
  let group: BuiltGroup | undefined;
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
    if (spec.groupOutputs === true) group = groupResults(run, nodes, placements);
  });
  // The press has its place on the canvas at once; the uploader sees each node
  // wait until the server answers (inner#1303 §6.7).
  const marks = useUploadMarksStore.getState();
  const ops = nodes.map((node) => marks.begin(spaceId, node.id, spec.id));
  /**
   * End this press's marks: answered, or failed with a message.
   * @param message - Why it stopped, or undefined when the server answered.
   */
  const settle: Settle = (message) => {
    const now = useUploadMarksStore.getState();
    nodes.forEach((node, index) => {
      const op = ops[index];
      if (message === undefined) now.answer(spaceId, node.id, op);
      else now.fail(spaceId, node.id, op, message);
    });
  };
  if (run.stillOpen()) {
    run.onBuilt(
      nodes.map((node, index) => ({
        id: node.id,
        position: node.position,
        width: placements[index].width,
        height: placements[index].height,
      })),
      group,
    );
  }

  const exports = exportsBeforeRun(spec);
  if (exports) run.setExporting(true);
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(run);
  } finally {
    if (exports) run.setExporting(false);
  }
  if ('failed' in prepared) {
    settle(prepared.failed);
    return null;
  }
  const { files, uploads } = prepared;

  if (files !== undefined) {
    // The press's operation runs on through the upload to the server's
    // answer (§6.7), so the collaborators keep reading the tool (§6.8). A node
    // the upload does not take ends its operation here.
    const tag: MiniToolUploadTag = { source: 'mini_tool', toolName: spec.id };
    const output = outputTemplateOf(spec);
    const handed = new Set<number>();
    // A grouped run's files go up in one batch, which the server takes from a
    // grouping tool only; any other run's one file goes up on its own.
    if (spec.groupOutputs === true) {
      const entries = nodes.flatMap((built, index) => {
        const made = files[index];
        if (made === undefined) return [];
        handed.add(index);
        return [{ nodeId: built.id, file: made.file, markOp: ops[index] }];
      });
      run.fillUploads(entries, tag);
    } else {
      const [node] = nodes;
      const [only] = files;
      if (node !== undefined && only !== undefined && output.modality !== 'text') {
        handed.add(0);
        run.fillUpload(node.id, only.file, output.modality, tag, ops[0]);
      }
    }
    const now = useUploadMarksStore.getState();
    nodes.forEach((node, index) => {
      if (!handed.has(index)) now.answer(spaceId, node.id, ops[index]);
    });
    return null;
  }

  onSent(settle);
  return requestOf(run, nodes.map((node) => node.id), uploads);
}
