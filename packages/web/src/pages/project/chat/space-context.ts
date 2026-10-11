// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a message tells the Agent about the reader's Spaces (inner#1413).
 *
 * Read in two steps. At the press, synchronously and from what this tab
 * already holds: the project's Spaces, and the open one's content when the
 * reader has it on. Nothing is created and nothing is asked for, so what goes
 * is the Space as it stood when send was pressed. Then, once the limits are
 * read from the server, cut to them -- only a length calculation.
 */

import type { QueryClient } from '@tanstack/react-query';
import { clipSpaceContent, spacesNewestFirst } from '@breatic/shared';
import type { ChatSpace, ChatSpaceContext, ModelCatalog } from '@breatic/shared';

import { readNodes } from '@web/data/yjs/canvas-space';
import { readDocFacts } from '@web/data/yjs/collab-socket';
import { docName, getDoc, hasDoc } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { readPick } from '@web/spaces/canvas/pick-for-agent';
import { peekDocumentEditor } from '@web/spaces/document/document-editor-cache';

/** The open Space as read at the press, before its content is cut. */
export type ReadCurrentSpace = ChatSpace &
  ({ state: 'loaded'; text: string } | { state: 'loading' } | { state: 'unreadable' });

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
 * An open canvas's nodes and links, as indented JSON the way a canvas
 * attachment carries them.
 * @param source - Where the read starts from.
 * @param space - The canvas.
 * @returns Its text, empty when nothing on it can be handed over, or null
 *   while it or the model catalog has not loaded.
 */
function canvasText(source: SpaceContextSource, space: ProjectSpace): string | null {
  const name = docName.canvasSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const catalog = source.queryClient.getQueryData<ModelCatalog>(modelCatalogQuery().queryKey);
  if (catalog === undefined) return null;
  const doc = getDoc(name);
  // A first voice that is not cached is left out: nothing is asked for here.
  const item = readPick(source.queryClient, catalog, doc, readNodes(doc).map((n) => n.id));
  return item?.chip === undefined ? '' : JSON.stringify(item.chip.data_snapshot, null, 2);
}

/**
 * An open document's text, as Markdown.
 * @param source - Where the read starts from.
 * @param space - The document.
 * @returns Its text, empty when it holds only whitespace, or null while it
 *   has not loaded or has no editor yet.
 */
function documentText(source: SpaceContextSource, space: ProjectSpace): string | null {
  const name = docName.documentSpace(source.projectId, space.id);
  if (!holdsSynced(name)) return null;
  const handle = peekDocumentEditor(name);
  if (handle === undefined) return null;
  const markdown = handle.editor.blocksToMarkdownLossy(handle.editor.document);
  return markdown.trim() === '' ? '' : markdown.trimEnd();
}

/**
 * The open Space as the message carries it.
 * @param source - Where the read starts from.
 * @param space - The open Space.
 * @returns What it holds, or why it holds nothing to read.
 */
function readCurrent(source: SpaceContextSource, space: ProjectSpace): ReadCurrentSpace {
  const base = listed(space);
  if (space.type === 'timeline') return { ...base, state: 'unreadable' };
  const text = space.type === 'canvas' ? canvasText(source, space) : documentText(source, space);
  return text === null ? { ...base, state: 'loading' } : { ...base, state: 'loaded', text };
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
 * The read Spaces cut to the limits the server reads: the newest Spaces up to
 * the list's limit, and the start of the open Space's content up to its own.
 * @param read - What was read at the press.
 * @param limits - The limits.
 * @returns What goes beside the message.
 */
export function clipSpaceContext(read: ReadSpaces, limits: SpaceContextLimits): ChatSpaceContext {
  const out: ChatSpaceContext = {
    spaces: read.spaces.slice(0, limits.spaceListMaxItems),
    spaces_total: read.spaces.length,
  };
  const current = read.current;
  if (current === undefined) return out;
  if (current.state !== 'loaded') return { ...out, current_space: current };
  const { text, ...rest } = current;
  const clipped = clipSpaceContent(text, limits.currentSpaceMaxChars);
  return { ...out, current_space: { ...rest, content: clipped.text, total_chars: clipped.total } };
}
