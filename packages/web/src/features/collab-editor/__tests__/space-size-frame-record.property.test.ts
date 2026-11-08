// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 7 (inner#1790 web spec 23.4 W7-18, the DD
 * conclusion on the web side, Q28: editor entries only): on the frame record
 * of a handshaken provider (`H7`), from the `seen(s)` of a full push until
 * the `seen` of the next push that is not full, every Update the client
 * sends is a pure deletion (`D` or `R`), and only `R` when push `s` was at or
 * over the ceiling. Every push is acknowledged, so the windows exist.
 *
 * Each run opens a document body and a canvas text node body, then plays
 * 1 to 30 random actions: typing, pasting, deleting a character, deleting
 * across blocks, Backspace in an empty block, undo, redo, a plain click, a
 * push of any fixture, a peer's update.
 */

import fc from 'fast-check';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { documentBodyFragment } from '@breatic/shared';
import { PUSHES_V2, type DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { destroyH7Editors, openBodyH7, openPrompt } from '@web/features/collab-editor/__tests__/helpers/h7-editors';
import {
  CANVAS_NAME,
  DOCUMENT_NAME,
  backspaceChar,
  fragmentOf,
  pBlock as p,
  paragraphs,
  press,
  resetHarness,
  select,
  typeText,
} from '@web/features/collab-editor/__tests__/helpers/space-editor-harness';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const { resetServer, settle } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;

/** The rounds of `settle` after each step: the provider's 1 ms window and the server's answers. */
const ROUNDS = 2;

/** Which editor an action works in. */
type Target = 'body' | 'text';

/** One random action. */
type Action =
  | { op: 'type' | 'paste' | 'deleteChar' | 'click'; target: Target; at: number }
  | { op: 'crossDelete' | 'emptyBackspace' | 'undo' | 'redo' | 'peer'; target: Target }
  | { op: 'push'; target: Target; fixture: keyof typeof PUSHES_V2 };

const target = fc.constantFrom<Target>('body', 'text');
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ op: fc.constantFrom('type' as const, 'paste' as const, 'deleteChar' as const, 'click' as const), target, at: fc.nat() }),
  fc.record({ op: fc.constantFrom('crossDelete' as const, 'emptyBackspace' as const, 'undo' as const, 'redo' as const, 'peer' as const), target }),
  fc.record({ op: fc.constant('push' as const), target, fixture: fc.constantFrom(...(Object.keys(PUSHES_V2) as Array<keyof typeof PUSHES_V2>)) }),
);

/**
 * Every position inside a text block.
 * @param doc - The document.
 * @returns The positions, in order.
 * @throws {never} Never.
 */
function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (let at = pos + 1; at < pos + node.nodeSize; at += 1) out.push(at);
    return false;
  });
  return out;
}

/**
 * The text blocks' inner ranges.
 * @param doc - The document.
 * @returns `[from, to]` of each text block's content.
 * @throws {never} Never.
 */
function textBlocks(doc: PMNode): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    out.push([pos + 1, pos + node.nodeSize - 1]);
    return false;
  });
  return out;
}

/**
 * Asserts the spec W7-18 window rule on one document's frames, and that every push was acknowledged.
 * @param server - The scripted server.
 * @param name - Canonical document name.
 * @param pushed - Each push sent, by `seq`.
 * @throws {AssertionError} When it does not hold.
 */
function expectWindows(server: ScriptedServer, name: string, pushed: Map<number, DocSizePushV2>): void {
  const kinds = server.kinds(name);
  for (const seq of pushed.keys()) expect(kinds).toContain(`seen(${seq})`);
  let window: { over: boolean } | null = null;
  for (const { frame } of server.frames) {
    if (frame.name !== name) continue;
    const kind = h7.kindOf(frame);
    if (kind.startsWith('seen(')) {
      const push = pushed.get(Number(kind.slice(5, -1)));
      window = push?.phase === 'full' ? { over: push.bytes >= push.ceiling } : null;
      continue;
    }
    if (frame.kind !== 'update' || window === null) continue;
    if (window.over) expect(frame.shape).toBe('R');
    else expect(['D', 'R']).toContain(frame.shape);
  }
}

afterEach(() => {
  destroyH7Editors();
  _resetCollabSocketForTests();
  resetHarness();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('23.4 the frame record while full holds only deletions', () => {
  it('W7-18 random editor actions, pushes and peer updates: inside each acknowledged full window every Update is D or R (R only at the ceiling)', async () => {
    changeLocale('en');
    await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 30 }), async (actions) => {
      destroyH7Editors();
      _resetCollabSocketForTests();
      resetHarness();
      const server = resetServer();
      const body = await openBodyH7([p('alpha beta'), p('gamma delta'), p('')], { rounds: ROUNDS });
      const text = await openPrompt({ kind: 'textBody', content: paragraphs('one two', 'three', ''), rounds: ROUNDS });
      const views: Record<Target, EditorView> = { body: body.view, text: text.view };
      const names: Record<Target, string> = { body: DOCUMENT_NAME, text: CANVAS_NAME };
      const pushed: Record<Target, Map<number, DocSizePushV2>> = { body: new Map(), text: new Map() };
      for (const step of actions) {
        const view = views[step.target];
        const name = names[step.target];
        if (step.op === 'push') {
          const fixture = PUSHES_V2[step.fixture];
          pushed[step.target].set(server.push(name, fixture), fixture);
        } else if (step.op === 'peer') {
          server.peer(name, (peer) => {
            if (step.target === 'text') {
              const paragraph = new Y.XmlElement('paragraph');
              paragraph.insert(0, [new Y.XmlText('peer')]);
              fragmentOf(peer, 'textBody').push([paragraph]);
              return;
            }
            const editor = buildDocumentEditor({ fragment: documentBodyFragment(peer) });
            editor.mount(document.createElement('div'));
            editor.insertBlocks([{ type: 'paragraph', content: 'peer' }] as never, editor.document.at(-1)!, 'after');
            editor.unmount();
          });
        } else if (step.op === 'undo' || step.op === 'redo') {
          press(view, 'z', { mod: true, shift: step.op === 'redo' });
        } else if (step.op === 'crossDelete') {
          const blocks = textBlocks(view.state.doc);
          if (blocks.length >= 2) {
            select(view, Math.min(blocks[0]![0] + 2, blocks[0]![1]), Math.min(blocks[1]![0] + 2, blocks[1]![1]));
            press(view, 'Backspace');
          }
        } else if (step.op === 'emptyBackspace') {
          const empty = textBlocks(view.state.doc).find(([from, to]) => from === to);
          if (empty !== undefined) {
            select(view, empty[0]);
            press(view, 'Backspace');
          }
        } else if ('at' in step) {
          const positions = textPositions(view.state.doc);
          if (positions.length > 0) {
            select(view, positions[step.at % positions.length]!);
            if (step.op === 'type') typeText(view, 'k');
            else if (step.op === 'paste') view.pasteText('pq');
            else if (step.op === 'deleteChar' && view.state.selection.$from.parentOffset > 0) backspaceChar(view);
          }
        }
        await settle(ROUNDS);
      }
      expectWindows(server, DOCUMENT_NAME, pushed.body);
      expectWindows(server, CANVAS_NAME, pushed.text);
    }), { numRuns: 300 });
  }, 1_800_000);
});
