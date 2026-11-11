// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 7 (inner#1790 web spec 23.4, 23.5): the
 * canvas TipTap editors and the document body opened on a handshaken
 * provider (`H7`, `handshake-server.ts`), their content written by a peer
 * and arriving as Update frames. The importing file installs the scripted
 * `WebSocket` (see `handshake-server.ts`) and mocks `@web/lib/toast`.
 */

import { Editor, Extension } from '@tiptap/core';
import { Plugin, type PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { yXmlFragmentToProseMirrorRootNode as tiptapRootNode } from '@tiptap/y-tiptap';
import { ySyncPluginKey as bodySyncKey } from 'y-prosemirror';
import * as Y from 'yjs';

import { CANVAS_NODES_KEY, documentBodyFragment } from '@breatic/shared';
import { expectHandshake, server, settle } from '@web/data/yjs/__tests__/helpers/handshake-server';
import { acquireDocProvider } from '@web/data/yjs/collab-socket';
import { getDoc } from '@web/data/yjs/manager';
import { ySyncPluginKey as tiptapSyncKey } from '@web/features/collab-editor/collab-plugin-keys';
import {
  CANVAS_NAME,
  DOCUMENT_NAME,
  MODE,
  NODE_ID,
  fragmentOf,
  mountBody,
  tiptapExtensions,
  type BlockInput,
  type OpenBody,
  type TiptapKind,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

/**
 * Opens a registered Space document on a handshaken provider.
 * @param name - Canonical document name.
 * @param rounds - The rounds of `settle` each wait takes.
 * @returns The document.
 * @throws {AssertionError} When a precondition of `H7` does not hold.
 */
export async function openH7(name: string, rounds?: number): Promise<Y.Doc> {
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc);
  await expectHandshake(name, doc, provider as never, { rounds });
  return doc;
}

/**
 * Lets microtasks run, without any timer.
 * @returns Resolves after them.
 * @throws {never} Never.
 */
export async function microtasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** A plugin that appends `!` once after the next sync-keyed root, when armed. */
export interface Bang {
  readonly plugin: Plugin;
  /** Arms it for the next sync-keyed root. */
  arm: () => void;
}

/**
 * A plugin that, once armed, appends `!` at the end of the last text block
 * after the next sync-keyed root (spec 23.5: only to drive the mechanism).
 * @param key - The editor's sync plugin key.
 * @returns The plugin and its trigger.
 * @throws {never} Never.
 */
export function makeBang(key: PluginKey): Bang {
  let armed = false;
  const plugin = new Plugin({
    appendTransaction: (transactions, _old, state) => {
      if (!armed || !transactions.some((tr) => tr.docChanged && tr.getMeta(key) !== undefined)) return null;
      armed = false;
      let end = -1;
      state.doc.descendants((node, pos) => {
        if (node.isTextblock) end = pos + node.nodeSize - 1;
        return true;
      });
      return end < 0 ? null : state.tr.insertText('!', end);
    },
  });
  return { plugin, arm: () => { armed = true; } };
}

/** An open canvas prompt editor on a handshaken provider. */
export interface OpenPrompt {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  editor: Editor;
  view: EditorView;
  bang: Bang;
}

const tiptapEditors: Editor[] = [];

/**
 * Destroys every TipTap editor these helpers built.
 * @throws {never} Never.
 */
export function destroyH7Editors(): void {
  tiptapEditors.splice(0).forEach((editor) => { editor.destroy(); });
}

/**
 * The canvas node with empty fragments, written by a peer.
 * @param peer - The peer's copy.
 * @throws {never} Never.
 */
export function peerNode(peer: Y.Doc): void {
  const data = new Y.Map<unknown>();
  data.set('body', new Y.XmlFragment());
  const prompts = new Y.Map<unknown>();
  prompts.set(MODE, new Y.XmlFragment());
  data.set('prompts', prompts);
  const lyrics = new Y.Map<unknown>();
  lyrics.set(MODE, new Y.XmlFragment());
  data.set('lyrics', lyrics);
  const node = new Y.Map<unknown>();
  node.set('id', NODE_ID);
  node.set('data', data);
  peer.getMap(CANVAS_NODES_KEY).set(NODE_ID, node);
}

/**
 * A peer's prompt editor writes content into its copy.
 * @param peer - The peer's copy.
 * @param content - The ProseMirror JSON.
 * @param kind - Which fragment.
 * @throws {never} Never.
 */
export function peerPrompt(peer: Y.Doc, content: Record<string, unknown>, kind: TiptapKind = 'prompt'): void {
  const editor = new Editor({ element: document.createElement('div'), extensions: tiptapExtensions(kind, fragmentOf(peer, kind)) });
  editor.commands.setContent(content);
  editor.destroy();
}

/**
 * Opens the canvas on `H7` with the node a peer wrote and one of its TipTap
 * editors on it (the prompt by default).
 * @param options - What the editor carries and holds.
 * @param options.kind - Which editor.
 * @param options.rounds - The rounds of `settle` each wait takes.
 * @param options.bang - Also carry the `!` plugin.
 * @param options.content - The prompt a peer writes first.
 * @returns The open editor.
 * @throws {AssertionError} When a precondition does not hold.
 */
export async function openPrompt(options: { bang?: boolean; content?: Record<string, unknown>; kind?: TiptapKind; rounds?: number } = {}): Promise<OpenPrompt> {
  const kind = options.kind ?? 'prompt';
  server.current.peer(CANVAS_NAME, peerNode);
  const doc = await openH7(CANVAS_NAME, options.rounds);
  const fragment = fragmentOf(doc, kind);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const extensions = tiptapExtensions(kind, fragment);
  const bang = makeBang(tiptapSyncKey);
  const carried = Extension.create({ name: 'appendsBangAfterRedraw', addProseMirrorPlugins: () => [bang.plugin] });
  const editor = new Editor({ element, extensions: options.bang === true ? [...extensions, carried] : extensions });
  tiptapEditors.push(editor);
  if (options.content !== undefined) {
    const content = options.content;
    server.current.peer(CANVAS_NAME, (peer) => { peerPrompt(peer, content, kind); });
  }
  await settle(options.rounds);
  return { doc, fragment, editor, view: editor.view, bang };
}

/**
 * Whether a prompt editor and its fragment show the same document.
 * @param open - The open editor.
 * @returns `PM == Y`.
 * @throws {never} Never.
 */
export function promptInStep(open: OpenPrompt): boolean {
  return tiptapRootNode(open.fragment, open.view.state.schema).eq(open.view.state.doc);
}

/**
 * Opens the document body on `H7`, its blocks written by a peer.
 * @param blocks - The blocks.
 * @param options - What the body carries.
 * @param options.bang - Also carry the `!` plugin (registered after mount).
 * @param options.rounds - The rounds of `settle` each wait takes.
 * @returns The open body.
 * @throws {AssertionError} When a precondition does not hold.
 */
export async function openBodyH7(blocks: BlockInput[], options: { bang?: boolean; rounds?: number } = {}): Promise<OpenBody & { bang: Bang }> {
  await openH7(DOCUMENT_NAME, options.rounds);
  const body = mountBody();
  server.current.peer(DOCUMENT_NAME, (peer) => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
    editor.mount(document.createElement('div'));
    editor.replaceBlocks(editor.document, blocks as never);
    editor.unmount();
  });
  const bang = makeBang(bodySyncKey);
  if (options.bang === true) (body.editor as unknown as { _tiptapEditor: Editor })._tiptapEditor.registerPlugin(bang.plugin);
  await settle(options.rounds);
  return { ...body, view: body.editor.prosemirrorView, bang };
}
