/**
 * Shared palette output geometry + data for {@link LocalGenNode} (send spawn + connect-end companion nodes).
 */
import type { Edge, Node } from '@xyflow/react';
import type { LocalCanvasNodeData } from '@/new/project/types';
import { getLocalFlowNodeOuterWidth } from '../../common/localFlowNodeSpawn';
import { CANVAS_SPAWNED_OUTPUT_GAP_PX } from '../../canvasSpawnLayout';

/** React Flow shell width for generator nodes (`gen1001`–`gen1004`). */
export const GENERATOR_NODE_WIDTH_PX = 420 as const;

export const paletteOutputDefaults: Record<string, { w: number; h: number }> = {
  '1001': { w: 300, h: 250 },
  '1002': { w: 300, h: 250 },
  '1003': { w: 300, h: 250 },
  '1004': { w: 472, h: 200 },
};

export const paletteHandlesForOutput: Record<string, NonNullable<LocalCanvasNodeData['handles']>> = {
  '1001': { target: [{ handleType: 'Text', number: 0 }] },
  '1002': { target: [{ handleType: 'Image', number: 0 }] },
  '1003': { target: [{ handleType: 'Video', number: 0 }] },
  '1004': { target: [{ handleType: 'Audio', number: 0 }] },
};

/** Default `data.name` for palette outputs — aligned with {@link LocalDataNodeHandle} agent labels. */
export const paletteOutputNodeName: Record<string, string> = {
  '1001': 'Text',
  '1002': 'Image',
  '1003': 'Video',
  '1004': 'Audio',
};

/** Left target + right source handle ids per generator flow type. */
export const generatorHandleIds: Record<string, { target: string; source: string }> = {
  gen1001: { target: 'Text_0_0', source: 'Text_0_0' },
  gen1002: { target: 'Image_0_0', source: 'Image_0_0' },
  gen1003: { target: 'Video_0_0', source: 'Video_0_0' },
  gen1004: { target: 'Audio_0_0', source: 'Audio_0_0' },
};

export const generatorTitleByFlowType: Record<string, string> = {
  gen1001: 'Text Generator',
  gen1002: 'Image Generator',
  gen1003: 'Video Generator',
  gen1004: 'Audio Generator',
};

/**
 * Maps React Flow generator type (`gen1001`…) to palette asset id (`1001`…).
 *
 * @param flowType - `gen1001` | … | `gen1004`
 * @returns Palette id or `null`
 */
export function paletteTypeFromGeneratorFlowType(flowType: string): keyof typeof paletteOutputDefaults | null {
  if (flowType === 'gen1001') return '1001';
  if (flowType === 'gen1002') return '1002';
  if (flowType === 'gen1003') return '1003';
  if (flowType === 'gen1004') return '1004';
  return null;
}

/**
 * Right-hand handle id used for edges from a generator to its palette output.
 *
 * @param generatorFlowType - e.g. `gen1002`
 */
export function generatorOutboundHandleId(generatorFlowType: string): string {
  return generatorHandleIds[generatorFlowType]?.source ?? generatorHandleIds.gen1001.source;
}

/**
 * Empty asset node placed next to a generator when it is created from the connect-end menu.
 *
 * @param paletteType - `1001`–`1004`
 */
export function buildEmptyPaletteOutputData(paletteType: string): LocalCanvasNodeData {
  const handlesOut = paletteHandlesForOutput[paletteType];
  const outputName = paletteOutputNodeName[paletteType] ?? 'Output';
  if (paletteType === '1001') {
    return { name: outputName, text: '', handles: handlesOut };
  }
  if (paletteType === '1003') {
    return {
      name: outputName,
      url: '',
      content: '',
      handles: handlesOut,
      nodeRuntimeData: {},
    };
  }
  return { name: outputName, url: '', handles: handlesOut };
}

/**
 * Asset payload for a freshly sent generator output (pending shimmer).
 *
 * @param paletteType - `1001`–`1004`
 */
export function buildPendingPaletteOutputData(paletteType: string): LocalCanvasNodeData {
  const base = buildEmptyPaletteOutputData(paletteType);
  return { ...base, localOutputPending: true };
}

/**
 * Whether a palette asset node still acts as an unused output slot (reuse on first send instead of spawning another shell).
 *
 * @param paletteType - Palette id
 * @param data - Node data
 */
export function isPaletteOutputSlotEmpty(paletteType: string, data: LocalCanvasNodeData): boolean {
  if (data.localOutputPending) return false;
  if (paletteType === '1001') return !data.text?.trim();
  if (paletteType === '1003') return !data.url?.trim() && !data.content?.trim();
  return !data.url?.trim();
}

/**
 * First matching downstream palette node connected from the generator that is still an empty slot.
 *
 * @param getNodes - React Flow getter
 * @param getEdges - React Flow getter
 * @param generatorId - Generator node id
 * @param sourceHandleId - Generator source handle
 * @param paletteType - Expected palette id (`1001`–`1004`)
 */
export function findEmptyDownstreamPaletteOutput(
  getNodes: () => Node[],
  getEdges: () => Edge[],
  generatorId: string,
  sourceHandleId: string,
  paletteType: string,
): Node | undefined {
  const targets = getEdges()
    .filter((e) => e.source === generatorId && e.sourceHandle === sourceHandleId)
    .map((e) => getNodes().find((n) => n.id === e.target))
    .filter((n): n is Node => !!n)
    .filter((n) => n.type === paletteType)
    .sort((a, b) => a.position.x - b.position.x);

  for (const n of targets) {
    const d = (n.data ?? {}) as LocalCanvasNodeData;
    if (!isPaletteOutputSlotEmpty(paletteType, d)) continue;
    return n;
  }
  return undefined;
}

/**
 * Collects palette nodes already linked from this generator handle (same palette type as the outbound asset).
 *
 * @param getNodes - React Flow getter
 * @param getEdges - React Flow getter
 * @param generatorId - Generator id
 * @param sourceHandleId - Generator source handle id
 * @param paletteType - Palette id (`1001`–`1004`)
 */
function listGeneratorOutboundPaletteTargets(
  getNodes: () => Node[],
  getEdges: () => Edge[],
  generatorId: string,
  sourceHandleId: string,
  paletteType: string,
): Node[] {
  return getEdges()
    .filter((e) => e.source === generatorId && e.sourceHandle === sourceHandleId)
    .map((e) => getNodes().find((n) => n.id === e.target))
    .filter((n): n is Node => !!n && n.type === paletteType);
}

/**
 * Flow-space position for a new palette output from {@link LocalGenNode} send: to the right of the generator
 * (first output), then each further send places the next node to the **right** of the rightmost linked output
 * (same row as the generator top — no vertical stacking).
 *
 * @param generatorNode - Generator node (`getNode(generatorId)`)
 * @param getNodes - React Flow getter
 * @param getEdges - React Flow getter
 * @param generatorId - Generator id
 * @param sourceHandleId - Generator source handle id
 * @param paletteType - Palette id (`1001`–`1004`)
 * @returns Top-left flow coordinates for the new output node
 */
export function computeNextGeneratorPaletteOutputPosition(
  generatorNode: Node,
  getNodes: () => Node[],
  getEdges: () => Edge[],
  generatorId: string,
  sourceHandleId: string,
  paletteType: string,
): { x: number; y: number } {
  const pos = generatorNode.position;
  const genW = getLocalFlowNodeOuterWidth(generatorNode);
  const firstLeft = pos.x + genW + CANVAS_SPAWNED_OUTPUT_GAP_PX;
  const targets = listGeneratorOutboundPaletteTargets(getNodes, getEdges, generatorId, sourceHandleId, paletteType);
  if (targets.length === 0) {
    return { x: firstLeft, y: pos.y };
  }
  let maxRight = pos.x;
  for (const t of targets) {
    maxRight = Math.max(maxRight, t.position.x + getLocalFlowNodeOuterWidth(t));
  }
  return { x: maxRight + CANVAS_SPAWNED_OUTPUT_GAP_PX, y: pos.y };
}
