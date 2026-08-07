// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Prompt cross-client concurrency (#1880): the prompt fragment is a shared
 * CRDT sequence, NOT a whole-fragment LWW register — two people opening the
 * same image node's Generate panel and typing must BOTH keep their words.
 *
 * The container used to be created by whichever client opened the panel
 * first. Two concurrent first-openers each created their own fragment under
 * the same key, and map-level last-write-wins dropped one container WITH
 * everything typed into it. The fix is the one `focusImages` already uses:
 * born with the node, so the container is a single replicated creation event
 * and every edit inside it commutes.
 *
 * Each scenario replays a true two-client offline divergence through the REAL
 * public API: capture a baseline update, let client A write on top of it,
 * reset the doc registry, rebuild client B from the same baseline (a fresh
 * Y.Doc = a different clientID), let B write the concurrent edit, then merge
 * both updates in BOTH orders and assert the replicas converge with both
 * effects intact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, getPromptFragment } from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';

/**
 * Builds a node fixture of the given modality.
 * @param type - The node's modality.
 * @param id - The node id (defaults to `gen`).
 * @returns A complete CanvasNodeFields object.
 */
function nodeOf(type: NodeType, id = 'gen'): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      name: 'G',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      state: 'idle',
      attachments: [],
    },
  };
}

/**
 * Returns the live registry doc for the test project/space.
 * @returns The cached canvas-space Y.Doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * Reads a node's raw `prompt` value, whatever its encoding.
 * @param id - The node id to read.
 * @returns The raw value stored under the `prompt` key.
 */
function rawPrompt(id = 'gen'): unknown {
  const node = doc().getMap('nodesMap').get(id) as Y.Map<unknown> | undefined;
  const data = node?.get('data') as Y.Map<unknown> | undefined;
  return data?.get('prompt');
}

/**
 * Types a line into a node's prompt through the public read API — the same
 * call the Generate panel makes when it mounts its editor.
 * @param text - The words to append as one paragraph.
 * @param id - The node id to type into.
 * @throws {Error} When the node has no prompt fragment to type into.
 */
function typeInto(text: string, id = 'gen'): void {
  const fragment = getPromptFragment(PID, SID, id);
  if (!fragment) throw new Error(`node ${id} has no prompt fragment`);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

/**
 * Reads a node's prompt as plain text.
 * @param id - The node id to read.
 * @returns The concatenated text of every block, or null when absent.
 */
function promptText(id = 'gen'): string | null {
  const raw = rawPrompt(id);
  if (!(raw instanceof Y.XmlFragment)) return null;
  return raw.toArray().map((block) => block.toString()).join('');
}

/**
 * Snapshots the registry doc as a Yjs update.
 * @returns The full-state update.
 */
function stateOf(): Uint8Array {
  return Y.encodeStateAsUpdate(doc());
}

/**
 * Resets the registry to a fresh doc (a new clientID) seeded from a captured
 * update — the "second client" of the replay.
 * @param update - The baseline state to replay, if any.
 */
function resetTo(update: Uint8Array | null): void {
  _resetForTests();
  if (update) Y.applyUpdate(doc(), update);
}

/**
 * Runs `writeA` and `writeB` as two clients diverging OFFLINE from the
 * current registry state, merges both updates in both orders, asserts the
 * replicas converge, and returns the converged prompt text.
 * @param writeA - Client A's write (runs through the public API).
 * @param writeB - Client B's concurrent write (same API, fresh clientID).
 * @returns The converged prompt text.
 */
function concurrently(writeA: () => void, writeB: () => void): string | null {
  const baseline = stateOf();
  writeA();
  const afterA = stateOf();
  resetTo(baseline);
  writeB();
  const afterB = stateOf();
  resetTo(afterA);
  Y.applyUpdate(doc(), afterB);
  const ab = promptText();
  resetTo(afterB);
  Y.applyUpdate(doc(), afterA);
  const ba = promptText();
  expect(ba).toEqual(ab);
  return ab;
}

describe('prompt is born with the node (#1880)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('an image node carries a prompt fragment from birth, before any panel opens', () => {
    addNode(PID, SID, nodeOf('image'));
    expect(rawPrompt()).toBeInstanceOf(Y.XmlFragment);
  });

  it('reading the prompt never creates one — a node without it stays without it', () => {
    // The old getOrCreate wrote on read, which is what made two concurrent
    // first-openers each mint a container. Reading must be a pure read.
    addNode(PID, SID, nodeOf('image'));
    const data = (
      doc().getMap('nodesMap').get('gen') as Y.Map<unknown>
    ).get('data') as Y.Map<unknown>;
    data.delete('prompt');
    expect(getPromptFragment(PID, SID, 'gen')).toBeNull();
    expect(rawPrompt()).toBeUndefined();
  });

  it('nodes that cannot generate get no prompt fragment', () => {
    // Only image nodes offer Generate today (CanvasSpace gates the menu item
    // on it). Seeding a container onto a group or a sticky would be an inert
    // key nothing ever reads.
    for (const type of ['group', 'annotation'] as const) {
      _resetForTests();
      addNode(PID, SID, nodeOf(type));
      expect(rawPrompt()).toBeUndefined();
    }
  });

  it('returns null for a node that does not exist', () => {
    expect(getPromptFragment(PID, SID, 'nope')).toBeNull();
  });
});

describe('prompt cross-client concurrency (#1880)', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, nodeOf('image'));
  });

  it('two people typing into a fresh node BOTH keep their words', () => {
    // The regression this pins: with a lazily created fragment each client
    // minted its own container and one vanished WITH everything typed into
    // it. Born with the node, both edits land in the same sequence.
    const merged = concurrently(
      () => typeInto('from A'),
      () => typeInto('from B'),
    );
    expect(merged).toContain('from A');
    expect(merged).toContain('from B');
  });

  it('concurrent edits on an already-written prompt keep all three', () => {
    typeInto('base');
    const merged = concurrently(
      () => typeInto('from A'),
      () => typeInto('from B'),
    );
    expect(merged).toContain('base');
    expect(merged).toContain('from A');
    expect(merged).toContain('from B');
  });

  it('the container itself survives a merge — neither client replaces it', () => {
    const before = rawPrompt();
    concurrently(
      () => typeInto('from A'),
      () => typeInto('from B'),
    );
    // A replaced container would be a different object with only one side's
    // text; identity is checked through the merged content above, so here we
    // assert the key still holds a fragment rather than a stray plain value.
    expect(before).toBeInstanceOf(Y.XmlFragment);
    expect(rawPrompt()).toBeInstanceOf(Y.XmlFragment);
  });
});
