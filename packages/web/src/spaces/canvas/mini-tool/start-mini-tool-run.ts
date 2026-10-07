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
  type MiniToolRequest,
  type MiniToolRequestSlot,
  type MiniToolSlotValue,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from '@breatic/shared';

import { miniToolsApi } from '@web/data/api/mini-tools';
import { ApiException } from '@web/data/api/types';
import type { MiniToolUploadTag } from '@web/data/upload/ingest-upload';
import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { createEmptyNode, type CreatableNodeType } from '@web/spaces/canvas/node-factory';

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
  /** Make a browser tool's file from the snapshot. */
  exportFile: (spec: MiniToolSpec, snapshot: MiniToolSnapshot) => Promise<File>;
  /** Upload a browser tool's file into its node, tagged with the tool. */
  fillUpload: (nodeId: string, file: File, modality: CreatableNodeType, tag: MiniToolUploadTag) => void;
  /** Called with the nodes the press built, the moment they exist. */
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
 * @returns The body.
 */
function requestOf(run: MiniToolRun, nodeIds: string[]): MiniToolRequest {
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
  };
}

/**
 * Build the result nodes, wire them to the source, and start the run.
 *
 * A browser tool's file is made first: a failed export, like a source deleted
 * while it was being made, builds nothing and says so. A server tool's request
 * goes out after the nodes exist; a refusal opened no row, so the press is
 * where it is said, and the nodes stay.
 * @param run - The press.
 * @returns Nothing; what happens next is on the new nodes' task rows.
 */
export async function startMiniToolRun(run: MiniToolRun): Promise<void> {
  const { projectId, spaceId, userId, spec, snapshot, source } = run;

  let file: File | undefined;
  if (spec.run.kind === 'browser') {
    try {
      file = await run.exportFile(spec, snapshot);
    } catch {
      toast.warning(t('canvas.miniTool.panel.exportFailed'));
      return;
    }
  }
  if (!run.sourceExists()) {
    toast.warning(t('canvas.miniTool.panel.sourceGone'));
    return;
  }

  const base = {
    x: source.position.x + (source.groupOrigin?.x ?? 0) + NODE_STEP.x,
    y: source.position.y + (source.groupOrigin?.y ?? 0),
  };
  const nodes = spec.outputs.map((output, index) => {
    const built = createEmptyNode(output.modality, { x: base.x, y: base.y + index * NODE_STEP.y }, userId);
    const name = `${output.namePrefix}-${source.name ?? built.data.name}`;
    return { ...built, data: { ...built.data, name } };
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
  run.onBuilt(nodes.map((node) => ({ id: node.id, position: node.position })));

  if (file !== undefined) {
    const [node] = nodes;
    const [output] = spec.outputs;
    if (node !== undefined && output !== undefined && output.modality !== 'text') {
      run.fillUpload(node.id, file, output.modality, { source: 'mini_tool', toolName: spec.id });
    }
    return;
  }

  try {
    await miniToolsApi.run(requestOf(run, nodes.map((node) => node.id)));
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
