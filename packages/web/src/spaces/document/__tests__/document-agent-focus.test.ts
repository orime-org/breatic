// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks an external agent works on, marked in the body (#1488 design
 * 19.2): a frame on each block and the agent's name on it.
 */

import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import { describe, expect, it } from 'vitest';

import {
  AGENT_FOCUS_CLASS,
  agentFocusDecorations,
  agentFocusPlugin,
  showAgentFocus,
} from '@web/spaces/document/document-agent-focus';

const schema = new Schema({
  nodes: {
    doc: { content: 'blockContainer+' },
    blockContainer: { content: 'paragraph', attrs: { id: { default: null } } },
    paragraph: { content: 'text*' },
    text: {},
  },
});

const body = schema.node('doc', null, [
  schema.node('blockContainer', { id: 'b1' }, [schema.node('paragraph', null, [schema.text('one')])]),
  schema.node('blockContainer', { id: 'b2' }, [schema.node('paragraph', null, [schema.text('two')])]),
]);

/**
 * The attributes a decoration set puts on each block.
 * @param set - The decorations.
 * @returns Block id to its attributes.
 */
function painted(set: DecorationSet): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const d of set.find()) {
    const node = body.nodeAt(d.from);
    out.set(node?.attrs.id as string, (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs);
  }
  return out;
}

describe('agentFocusDecorations', () => {
  it('frames each block an agent works on and names the agent on it', () => {
    const set = agentFocusDecorations(body, [{ blockId: 'b2', connectionId: 'c1', label: 'Claude Code · Mika' }]);
    const attrs = painted(set);
    expect([...attrs.keys()]).toEqual(['b2']);
    expect(attrs.get('b2')?.class).toBe(AGENT_FOCUS_CLASS);
    expect(attrs.get('b2')?.['data-agent-label']).toBe('Claude Code · Mika');
  });

  it('names every agent on a block they share', () => {
    const set = agentFocusDecorations(body, [
      { blockId: 'b1', connectionId: 'c1', label: 'A · Mika' },
      { blockId: 'b1', connectionId: 'c2', label: 'B · Lei' },
    ]);
    expect(painted(set).get('b1')?.['data-agent-label']).toBe('A · Mika, B · Lei');
  });
});

describe('agentFocusPlugin', () => {
  it('paints what it is shown, and nothing before', () => {
    const plugin = agentFocusPlugin();
    let state = EditorState.create({ doc: body, plugins: [plugin] });
    expect(plugin.getState(state)?.set.find()).toHaveLength(0);
    const view = { state, dispatch: (tr: Parameters<EditorState['apply']>[0]): void => { state = state.apply(tr); } };
    showAgentFocus(view, [{ blockId: 'b1', connectionId: 'c1', label: 'A · Mika' }]);
    expect(plugin.getState(state)?.set.find()).toHaveLength(1);
    showAgentFocus(view, []);
    expect(plugin.getState(state)?.set.find()).toHaveLength(0);
  });
});
