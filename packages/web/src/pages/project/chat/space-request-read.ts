// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading the Spaces the Agent asked to look at, once the user allowed it
 * (inner#1552, DD 5.3).
 *
 * Each Space ends in one of five states, and the Agent is told each one. A
 * Space this tab already holds synced is read as it stands, with no
 * connection. Any other is read over a socket the read owns, never the tab's:
 * one socket for the whole request, a new Y.Doc and provider per Space,
 * presenting the read-only token so the read takes no seat; none of them is
 * in the tab's registry, and each is destroyed however the read ends.
 *
 * The packing is the open Space's (`space-context.ts`), so a Space reaches
 * the Agent the same way whether it was open or asked for; a part of a
 * document keeps the numbers the whole would show.
 */
import type { QueryClient } from '@tanstack/react-query';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { yXmlFragmentToBlocks } from '@blocknote/core/yjs';
import * as Y from 'yjs';
import { documentBodyFragment, documentCommentThreads, READ_ONLY_COLLAB_TOKEN } from '@breatic/shared';
import type { SharedSpace, SpaceRequestInput } from '@breatic/shared';

import { createCollabSocket } from '@web/data/yjs/collab-socket';
import { docName, getDoc } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { clipDocument, fitCanvasContent, holdsSynced, readCanvas } from '@web/pages/project/chat/space-context';
import { spaceContentReadable } from '@web/pages/project/space-type';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { anchoredMediaIds } from '@web/spaces/document/document-comment-media';
import type { ReadBlock } from '@web/spaces/document/document-blocks-read';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';

/** One Space as the request names it. */
type Asked = SpaceRequestInput['spaces'][number];

/** The limits a read keeps to, from `GET /chat/stream-config`. */
export interface SpaceReadLimits {
  /** How long each Space may take, in code units, once packed. */
  currentSpaceMaxChars: number;
  /** How long a Space may take to sync before it is given up on. */
  spaceReadTimeoutMs: number;
}

/** What a read of requested Spaces starts from. */
export interface RequestedSpacesSource {
  projectId: string;
  /** Every Space in the project. */
  spaces: readonly ProjectSpace[];
  /** The Spaces asked for, as the request names them. */
  requested: SpaceRequestInput['spaces'];
  /** Holds the model catalog and each model's first voice. */
  queryClient: QueryClient;
  /** The collaboration address the shared socket dials. */
  url: string;
  limits: SpaceReadLimits;
  /** Raised when the card stops waiting; the read then ends at once. */
  signal?: AbortSignal;
}

/** How a connection to one Space ended before anything was read. */
type Unsynced = 'gone' | 'timed_out';

/**
 * A document's top-level blocks read from its stored state, through a
 * throwaway editor built the way every document editor is, so they are the
 * blocks the open document would show (as `document-markdown.ts` reads).
 * @param doc - The document.
 * @returns Its blocks.
 */
function storedBlocks(doc: Y.Doc): ReadBlock[] {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()), extensions: [] });
  editor.replaceBlocks(editor.document, yXmlFragmentToBlocks(editor, documentBodyFragment(doc)));
  return readTopBlocks(editor, anchoredMediaIds(documentCommentThreads(doc)));
}

/**
 * Pack a synced Space as the Agent is given it.
 * @param doc - Its synced document.
 * @param name - Its document name, which finds an editor this tab holds.
 * @param space - The Space.
 * @param asked - What was asked of it.
 * @param source - Where the read starts from.
 * @returns It, read.
 * @throws {Error} When the model catalog cannot be had or packing fails.
 */
async function pack(
  doc: Y.Doc,
  name: string,
  space: ProjectSpace,
  asked: Asked,
  source: RequestedSpacesSource,
): Promise<SharedSpace> {
  const max = source.limits.currentSpaceMaxChars;
  const head = { id: space.id, name: space.name, kind: space.type, state: 'read' as const };
  if (space.type === 'canvas') {
    const catalog = await source.queryClient.ensureQueryData(modelCatalogQuery());
    const picked = asked.node_ids;
    const canvas = readCanvas(doc, space.id, source.queryClient, catalog, picked);
    const fitted = fitCanvasContent(canvas, max);
    if (picked === undefined) return { ...head, ...fitted };
    const present = new Set(canvas.nodes.map((n) => n.id));
    const missing = picked.filter((id) => !present.has(id)).length;
    return { ...head, part: { node_ids: picked }, ...fitted, nodes_missing: missing };
  }
  const editor = peekDocumentEditor(name)?.editor;
  const blocks = editor === undefined ? storedBlocks(doc) : readTopBlocks(editor, anchoredMediaIds(documentCommentThreads(doc)));
  const range = asked.blocks;
  if (range === undefined) {
    const clipped = clipDocument(blocks, max);
    return { ...head, content: clipped.content, total_chars: clipped.total };
  }
  const clipped = clipDocument(blocks.slice(range.from - 1, range.to), max, range.from);
  return { ...head, part: { blocks: range }, content: clipped.content, total_chars: clipped.total, blocks_total: blocks.length };
}

/**
 * Connect to one Space on the read's socket and wait for it to sync, then
 * use it; the provider and Y.Doc are destroyed however it ends.
 * @param name - The document name.
 * @param socket - The read's socket.
 * @param source - Where the read starts from.
 * @param withSynced - What to do with the synced document.
 * @returns What `withSynced` made of it, or how the connection ended without a sync.
 * @throws {unknown} The signal's reason once it is raised, or what `withSynced` threw.
 */
async function overConnection(
  name: string,
  socket: HocuspocusProviderWebsocket,
  source: RequestedSpacesSource,
  withSynced: (doc: Y.Doc) => Promise<SharedSpace>,
): Promise<SharedSpace | Unsynced> {
  const { signal } = source;
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: doc, token: READ_ONLY_COLLAB_TOKEN });
  try {
    const ending = await new Promise<'synced' | Unsynced>((resolve, reject) => {
      /** Stop on the card's word. */
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      /**
       * Settle on the first ending; a later one is ignored.
       * @param how - The ending.
       */
      const end = (how: 'synced' | Unsynced): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(how);
      };
      const timer = setTimeout(() => end('timed_out'), source.limits.spaceReadTimeoutMs);
      provider.on('synced', () => end('synced'));
      provider.on('authenticationFailed', () => end('gone'));
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      // A provider handed a socket does not attach itself.
      provider.attach();
    });
    return ending === 'synced' ? await withSynced(doc) : ending;
  } finally {
    provider.destroy();
    doc.destroy();
  }
}

/**
 * Read one requested Space.
 * @param asked - What was asked of it.
 * @param source - Where the read starts from.
 * @param socketOf - The read's socket, opened on first use.
 * @returns How it ended.
 * @throws {unknown} The signal's reason once it is raised.
 */
async function readOne(
  asked: Asked,
  source: RequestedSpacesSource,
  socketOf: () => HocuspocusProviderWebsocket,
): Promise<SharedSpace> {
  const part = asked.blocks !== undefined ? { part: { blocks: asked.blocks } } : asked.node_ids !== undefined ? { part: { node_ids: asked.node_ids } } : {};
  const space = source.spaces.find((s) => s.id === asked.id);
  if (space === undefined) return { id: asked.id, state: 'gone', ...part };
  const base = { id: space.id, name: space.name, kind: space.type, ...part };
  if (!spaceContentReadable(space.type)) return { ...base, state: 'unreadable' };
  const name =
    space.type === 'canvas'
      ? docName.canvasSpace(source.projectId, space.id)
      : docName.documentSpace(source.projectId, space.id);
  /**
   * Pack it, or say it failed.
   * @param doc - Its synced document.
   * @returns It, read or failed.
   */
  const packed = async (doc: Y.Doc): Promise<SharedSpace> => {
    try {
      return await pack(doc, name, space, asked, source);
    } catch (failed) {
      // Told to the Agent as failed; written down for whoever looks into it.
      console.error('[chat] a requested Space could not be packed', { spaceId: space.id, failed });
      return { ...base, state: 'failed' };
    }
  };
  if (holdsSynced(name)) return packed(getDoc(name));
  const ended = await overConnection(name, socketOf(), source, packed);
  return typeof ended === 'string' ? { ...base, state: ended } : ended;
}

/**
 * Read the Spaces a request asks for, each to one of five endings, in the
 * order asked.
 * @param source - Where the read starts from.
 * @returns Each Space as the Agent is given it.
 * @throws {unknown} The signal's reason once it is raised; nothing is kept.
 */
export async function readRequestedSpaces(source: RequestedSpacesSource): Promise<SharedSpace[]> {
  let socket: HocuspocusProviderWebsocket | null = null;
  /**
   * The read's socket, opened the first time a Space needs a connection.
   * @returns It.
   */
  const socketOf = (): HocuspocusProviderWebsocket => {
    socket ??= createCollabSocket(source.url);
    return socket;
  };
  try {
    return await Promise.all(source.requested.map((asked) => readOne(asked, source, socketOf)));
  } finally {
    (socket as HocuspocusProviderWebsocket | null)?.destroy();
  }
}
