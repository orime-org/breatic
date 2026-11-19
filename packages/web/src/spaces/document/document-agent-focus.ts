// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Marks the blocks external agents work on (#1488 design 19.2): a frame on
 * each block in the agent's colour and its name above, drawn by `index.css`.
 * The project page decides which blocks, from the agents' presence; this
 * plugin only paints what it is shown, and follows the blocks as the body
 * changes.
 */

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { userPaletteColor } from '@web/lib/user-color';

/** The class on a block an agent works on. */
export const AGENT_FOCUS_CLASS = 'doc-agent-focus';

/** One agent on one block. */
export interface AgentFocusEntry {
  blockId: string;
  connectionId: string;
  label: string;
}

interface AgentFocusState {
  entries: readonly AgentFocusEntry[];
  set: DecorationSet;
}

const KEY = new PluginKey<AgentFocusState>('documentAgentFocus');

/**
 * Frame each block an agent works on and name the agents on it.
 * @param doc - The body.
 * @param entries - Which agents work on which blocks.
 * @returns The decorations.
 */
export function agentFocusDecorations(doc: PMNode, entries: readonly AgentFocusEntry[]): DecorationSet {
  if (entries.length === 0) return DecorationSet.empty;
  const byBlock = new Map<string, AgentFocusEntry[]>();
  for (const e of entries) byBlock.set(e.blockId, [...(byBlock.get(e.blockId) ?? []), e]);
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true;
    const on = byBlock.get(node.attrs.id as string);
    if (on !== undefined) {
      found.push(Decoration.node(pos, pos + node.nodeSize, {
        class: AGENT_FOCUS_CLASS,
        'data-agent-label': on.map((e) => e.label).join(', '),
        style: `--agent-color: ${userPaletteColor(on[0]!.connectionId)}`,
      }));
    }
    return true;
  });
  return found.length > 0 ? DecorationSet.create(doc, found) : DecorationSet.empty;
}

/**
 * The plugin that holds and paints the agents' blocks.
 * @returns The plugin.
 */
export function agentFocusPlugin(): Plugin<AgentFocusState> {
  return new Plugin<AgentFocusState>({
    key: KEY,
    state: {
      init: () => ({ entries: [], set: DecorationSet.empty }),
      apply: (tr, value, _old, state) => {
        const shown = tr.getMeta(KEY) as readonly AgentFocusEntry[] | undefined;
        if (shown !== undefined) return { entries: shown, set: agentFocusDecorations(state.doc, shown) };
        return tr.docChanged ? { entries: value.entries, set: agentFocusDecorations(state.doc, value.entries) } : value;
      },
    },
    props: {
      decorations: (state) => KEY.getState(state)?.set,
    },
  });
}

/**
 * Show which blocks agents work on now.
 * @param view - The editor view, or anything holding its state and dispatch.
 * @param view.state - Its state.
 * @param view.dispatch - Applies a transaction.
 * @param entries - Which agents work on which blocks.
 */
export function showAgentFocus(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  entries: readonly AgentFocusEntry[],
): void {
  view.dispatch(view.state.tr.setMeta(KEY, entries).setMeta('addToHistory', false));
}

/**
 * The extension that registers the plugin with the editor.
 * @returns The extension.
 */
export function documentAgentFocusExtension(): ExtensionFactoryInstance {
  return createExtension(() => ({ key: 'documentAgentFocus', prosemirrorPlugins: [agentFocusPlugin()] }))();
}
