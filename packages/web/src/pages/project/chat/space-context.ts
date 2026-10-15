// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a message tells the Agent about the reader's Spaces (inner#1413).
 *
 * Read in two steps. At the press, synchronously and from what this tab
 * already holds: the project's Spaces, and the open one's content when the
 * reader has it on. Nothing is created and nothing is asked for, so what goes
 * is the Space as it stood when send was pressed. Then, once the limits are
 * read from the server, cut to them: a document to its start, a canvas by
 * level of detail, with the selected nodes the message's attachments hold
 * unchanged going with the rest. Nothing more is read from the tab.
 */

import type { QueryClient } from '@tanstack/react-query';
import { isGenerationNodeType, spacesNewestFirst } from '@breatic/shared';
import type { ChatAttachedChip, ChatDocumentBlock, ChatSpace, ChatSpaceContext, ModelCatalog } from '@breatic/shared';

import { readEdges, readNodes } from '@web/data/yjs/canvas-space';
import { readDocFacts } from '@web/data/yjs/collab-socket';
import { docName, getDoc, hasDoc } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { snapshotOfPick } from '@web/spaces/canvas/attach-nodes';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { pickReaders } from '@web/spaces/canvas/pick-for-agent';
import { cutEnd, fitCanvas, fitNodeOf } from '@web/pages/project/chat/canvas-fit';
import type { FitInput, FitNode } from '@web/pages/project/chat/canvas-fit';
import { canvasGraphs } from '@web/stores/canvas-graph';
import { spaceContentReadable } from '@web/pages/project/space-type';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import type { ReadBlock } from '@web/spaces/document/document-blocks-read';

/** The open Space as read at the press, before its content is cut. */
export type ReadCurrentSpace = ChatSpace &
  (
    | { state: 'loaded'; blocks: ReadBlock[] }
    | { state: 'loaded'; canvas: FitInput }
    | { state: 'loading' }
    | { state: 'unreadable' }
  );

/** The reader's Spaces as read at the press, before they are cut. */
export interface ReadSpaces {
  /** Every Space in the project, newest first. */
  spaces: ChatSpace[];
  /** The open Space, when one is open and the reader has it on. */
  current?: ReadCurrentSpace;
}

/** Where the read starts from. */
export interface SpaceContextSource {
  projectId: string;
  /** The Space whose tab is active, if any. */
  activeSpace: ProjectSpace | undefined;
  /** Every Space in the project. */
  spaces: readonly ProjectSpace[];
  /** Whether the reader has the open Space on. */
  enabled: boolean;
  /** Holds the model catalog and each model's first voice. */
  queryClient: QueryClient;
}

/** The limits the server reads, from `GET /chat/stream-config`. */
export interface SpaceContextLimits {
  currentSpaceMaxChars: number;
  spaceListMaxItems: number;
}

/**
 * A Space as the list names it.
 * @param space - The Space.
 * @returns Its id, name and kind.
 */
function listed(space: ProjectSpace): ChatSpace {
  return { id: space.id, name: space.name, kind: space.type };
}

/**
 * Whether this tab holds a document and has heard from the server about it.
 * Asked before anything reads it, so a closed Space gets no new document.
 * @param name - The document name.
 * @returns True when its content is the synced content.
 */
function holdsSynced(name: string): boolean {
  return hasDoc(name) && readDocFacts(name).hasEverSynced;
}

/**
 * The nodes the reader has selected on a canvas, as its own render buffer
 * holds them; a selected group brings its members.
 * @param spaceId - The canvas.
 * @param nodes - Every node on it.
 * @returns The ids.
 */
function selectedOn(spaceId: string, nodes: ReadonlyArray<{ id: string; parentId?: string }>): Set<string> {
  const ids = new Set(canvasGraphs.of(spaceId).getState().flowNodes.filter((n) => n.selected === true).map((n) => n.id));
  for (const n of nodes) if (n.parentId !== undefined && ids.has(n.parentId)) ids.add(n.id);
  return ids;
}

/**
 * An open canvas's nodes and the links between them, each node with the run
 * settings of the model it would run and whether the reader selected it.
 * @param source - Where the read starts from.
 * @param space - The canvas.
 * @returns The canvas, or null while it or the model catalog has not loaded.
 */
function readCanvas(source: SpaceContextSource, space: ProjectSpace): FitInput | null {
  const name = docName.canvasSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const catalog = source.queryClient.getQueryData<ModelCatalog>(modelCatalogQuery().queryKey);
  if (catalog === undefined) return null;
  const doc = getDoc(name);
  const nodes = readNodes(doc);
  // A first voice that is not cached is left out: nothing is asked for here.
  const snapshot = snapshotOfPick(
    { nodes, edges: readEdges(doc) },
    nodes.map((n) => n.id),
    pickReaders(source.queryClient, catalog, doc),
  );
  if (snapshot === null) return { nodes: [], edges: [] };
  const selected = selectedOn(space.id, nodes);
  return {
    nodes: snapshot.nodes.map((entry) => {
      const kind = typeof entry.type === 'string' ? entry.type : '';
      const model = (entry.current as { model?: unknown } | undefined)?.model;
      const descriptors = isGenerationNodeType(kind)
        ? modelsForModality(catalog, kind).find((m) => m.name === model)?.params
        : undefined;
      return fitNodeOf(entry, descriptors, selected.has(entry.id));
    }),
    edges: snapshot.edges,
  };
}

/** Content kept, and how long it was before it was cut. */
interface ClippedSpaceContent {
  text: string;
  total: number;
}

/**
 * Keep the first `max` UTF-16 code units of a text -- the unit the server's
 * limit check counts in.
 *
 * A cut that falls between the two halves of a surrogate pair keeps one fewer,
 * so the text never ends on half a character: some model providers refuse a
 * request carrying a lone surrogate.
 * @param text - The text.
 * @param max - How many code units may go.
 * @returns The text kept and its length before the cut.
 */
function clipSpaceContent(text: string, max: number): ClippedSpaceContent {
  if (text.length <= max) return { text, total: text.length };
  return { text: text.slice(0, cutEnd(text, max)), total: text.length };
}

/**
 * An open document's top-level blocks that hold something.
 * @param source - Where the read starts from.
 * @param space - The document.
 * @returns Its blocks, or null while it has not loaded or has no editor yet.
 */
function documentBlocks(source: SpaceContextSource, space: ProjectSpace): ReadBlock[] | null {
  const name = docName.documentSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const handle = peekDocumentEditor(name);
  return handle === undefined ? null : readTopBlocks(handle.editor);
}

/** An open document as it goes: its content and the blocks the content shows. */
interface ClippedDocument {
  content: string;
  total: number;
  blocks: ChatDocumentBlock[];
}

/**
 * A document's blocks as one text, each behind the `<!-- b:N -->` marker that
 * numbers it, cut to the limit. The block the limit falls in goes cut and
 * marked partial, and none after it go; a block whose marker the cut would
 * split goes not at all.
 * @param blocks - The blocks.
 * @param max - The limit.
 * @returns The content, its length before the cut, and the blocks it shows.
 */
function clipDocument(blocks: readonly ReadBlock[], max: number): ClippedDocument {
  const pieces = blocks.map((b, i) => `${i === 0 ? '' : '\n\n'}<!-- b:${String(i + 1)} -->\n${b.markdown}`);
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let content = '';
  const shown: ChatDocumentBlock[] = [];
  for (const [i, piece] of pieces.entries()) {
    const { id, type, text, lossy } = blocks[i]!;
    if (content.length + piece.length <= max) {
      content += piece;
      shown.push({ id, type, text, lossy, partial: false });
      continue;
    }
    const kept = clipSpaceContent(piece, max - content.length).text;
    if (kept.length >= piece.length - blocks[i]!.markdown.length) {
      content += kept;
      shown.push({ id, type, text: '', lossy, partial: true });
    }
    break;
  }
  return { content, total, blocks: shown };
}

/**
 * The open Space as the message carries it.
 * @param source - Where the read starts from.
 * @param space - The open Space.
 * @returns What it holds, or why it holds nothing to read.
 */
function readCurrent(source: SpaceContextSource, space: ProjectSpace): ReadCurrentSpace {
  const base = listed(space);
  if (!spaceContentReadable(space.type)) return { ...base, state: 'unreadable' };
  if (space.type === 'canvas') {
    const canvas = readCanvas(source, space);
    return canvas === null ? { ...base, state: 'loading' } : { ...base, state: 'loaded', canvas };
  }
  const blocks = documentBlocks(source, space);
  return blocks === null ? { ...base, state: 'loading' } : { ...base, state: 'loaded', blocks };
}

/**
 * The reader's Spaces as they stand at the press. Synchronous, and reads only
 * what this tab holds.
 * @param source - Where the read starts from.
 * @returns The Spaces, and the open one when it goes.
 */
export function readSpaceContext(source: SpaceContextSource): ReadSpaces {
  const spaces = spacesNewestFirst(source.spaces).map(listed);
  const open = source.enabled ? source.activeSpace : undefined;
  return open === undefined ? { spaces } : { spaces, current: readCurrent(source, open) };
}

/**
 * The selected nodes that a canvas attachment of this message holds exactly
 * as they stand now: the attachment already gives them whole, so they go
 * with the rest. An attachment is a copy taken when it was added, so a node
 * changed since then stays selected.
 * @param nodes - The canvas's nodes.
 * @param attached - The message's attachments.
 * @returns The ids.
 */
function heldUnchanged(nodes: readonly FitNode[], attached: readonly ChatAttachedChip[]): Set<string> {
  const held = new Map<string, string>();
  for (const chip of attached) {
    if (chip.type !== 'canvas' || !Array.isArray(chip.data_snapshot.nodes)) continue;
    for (const entry of chip.data_snapshot.nodes as Array<{ id?: unknown }>) {
      if (typeof entry.id === 'string') held.set(entry.id, JSON.stringify(entry));
    }
  }
  return new Set(nodes.filter((n) => n.selected && held.get(n.id) === JSON.stringify(n.whole)).map((n) => n.id));
}

/**
 * The read Spaces cut to the limits the server reads: the newest Spaces up to
 * the list's limit, the start of an open document, and an open canvas fitted
 * by level of detail.
 * @param read - What was read at the press.
 * @param limits - The limits.
 * @param attached - The attachments the message goes with.
 * @returns What goes beside the message.
 */
export function clipSpaceContext(
  read: ReadSpaces,
  limits: SpaceContextLimits,
  attached: readonly ChatAttachedChip[],
): ChatSpaceContext {
  const out: ChatSpaceContext = {
    spaces: read.spaces.slice(0, limits.spaceListMaxItems),
    spaces_total: read.spaces.length,
  };
  const current = read.current;
  if (current === undefined) return out;
  if (current.state !== 'loaded') return { ...out, current_space: current };
  const { id, name, kind } = current;
  if (!('canvas' in current)) {
    const clipped = clipDocument(current.blocks, limits.currentSpaceMaxChars);
    return {
      ...out,
      current_space: { id, name, kind, state: 'loaded', content: clipped.content, total_chars: clipped.total, blocks: clipped.blocks },
    };
  }
  const held = heldUnchanged(current.canvas.nodes, attached);
  const nodes = current.canvas.nodes.map((n) => (held.has(n.id) ? { ...n, last: false } : n));
  const fitted = fitCanvas({ nodes, edges: current.canvas.edges }, limits.currentSpaceMaxChars);
  // A canvas with nothing on it goes as empty, as an empty document does.
  const content = nodes.length === 0 ? '' : fitted.text;
  return {
    ...out,
    current_space: {
      id,
      name,
      kind,
      state: 'loaded',
      content,
      total_chars: nodes.length === 0 ? 0 : fitted.total,
      detail: fitted.detail,
    },
  };
}
