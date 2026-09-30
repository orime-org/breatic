// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One prompt per mode, and one storyboard per video mode (#2218).
 *
 * Every mode's prompt is born with the node for the reason the single prompt
 * was (#1880): two clients creating a container on demand each mint their own
 * and one disappears with its words. The same goes for each shot of a
 * storyboard, which is inserted whole with its own fragment.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import {
  AUDIO_GENERATION_MODES,
  GENERATION_NODE_MODES,
  VIDEO_GENERATION_MODES,
  type CanvasNodeFields,
  type NodeType,
} from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, getLyricsFragment, getPromptFragment } from '@web/data/yjs/canvas-space';
import {
  addStoryboardShot,
  enterStoryboardShots,
  readStoryboard,
  removeStoryboardShot,
  retotalStoryboard,
  setStoryboardKind,
  stepStoryboardShot,
} from '@web/data/yjs/node-storyboard';

const PID = 'p1';
const SID = 's1';

/**
 * A node fixture of the given modality.
 * @param type - The node's modality.
 * @returns The wire node.
 */
function nodeOf(type: NodeType): CanvasNodeFields {
  return {
    id: 'gen',
    type,
    position: { x: 0, y: 0 },
    data: { name: 'G', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  };
}

/**
 * Appends a paragraph to a fragment.
 * @param fragment - Where to type.
 * @param text - What to type.
 */
function typeInto(fragment: Y.XmlFragment | null, text: string): void {
  if (!fragment) throw new Error('no fragment');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

/**
 * A fragment's text.
 * @param fragment - The fragment.
 * @returns Its blocks' text joined.
 */
function textOf(fragment: Y.XmlFragment | null): string {
  return fragment?.toArray().map((block) => block.toString()).join('') ?? '';
}

beforeEach(() => {
  _resetForTests();
});

describe('one prompt per mode', () => {
  it('is born for every mode of every generating modality', () => {
    for (const type of ['image', 'video', 'audio'] as const) {
      _resetForTests();
      addNode(PID, SID, nodeOf(type));
      for (const mode of GENERATION_NODE_MODES[type]) {
        expect(getPromptFragment(PID, SID, 'gen', mode)).toBeInstanceOf(Y.XmlFragment);
      }
    }
  });

  it('keeps what is written in one mode out of every other', () => {
    addNode(PID, SID, nodeOf('video'));
    typeInto(getPromptFragment(PID, SID, 'gen', 't2v'), 'a boat');
    expect(textOf(getPromptFragment(PID, SID, 'gen', 't2v'))).toContain('a boat');
    expect(textOf(getPromptFragment(PID, SID, 'gen', 'i2v'))).toBe('');
  });

  it('gives each music mode its own lyrics', () => {
    addNode(PID, SID, nodeOf('audio'));
    for (const mode of AUDIO_GENERATION_MODES) {
      expect(getLyricsFragment(PID, SID, 'gen', mode)).toBeInstanceOf(Y.XmlFragment);
    }
    typeInto(getLyricsFragment(PID, SID, 'gen', 't2m'), 'la la');
    expect(textOf(getLyricsFragment(PID, SID, 'gen', 'a2m'))).toBe('');
  });
});

describe('one storyboard per video mode', () => {
  it('is born off, with no shots, for every video mode', () => {
    addNode(PID, SID, nodeOf('video'));
    for (const mode of VIDEO_GENERATION_MODES) {
      expect(readStoryboard(PID, SID, 'gen', mode)).toEqual({ kind: 'off', shots: [] });
    }
  });

  it('switches tier and keeps its shots when switched off', () => {
    addNode(PID, SID, nodeOf('video'));
    enterStoryboardShots(PID, SID, 'gen', 't2v', 5);
    setStoryboardKind(PID, SID, 'gen', 't2v', 'off');
    const board = readStoryboard(PID, SID, 'gen', 't2v');
    expect(board?.kind).toBe('off');
    expect(board?.shots.map((shot) => shot.duration)).toEqual([2, 3]);
  });

  it('enters the per-shot tier with two shots, each with its own fragment', () => {
    addNode(PID, SID, nodeOf('video'));
    enterStoryboardShots(PID, SID, 'gen', 't2v', 5);
    const board = readStoryboard(PID, SID, 'gen', 't2v');
    expect(board?.kind).toBe('custom');
    expect(board?.shots.map((shot) => shot.duration)).toEqual([2, 3]);
    expect(board?.shots[0]?.prompt).toBeInstanceOf(Y.XmlFragment);
    expect(board?.shots[0]?.prompt).not.toBe(board?.shots[1]?.prompt);
  });

  it('adds, steps, removes and re-totals through the shared rules', () => {
    addNode(PID, SID, nodeOf('video'));
    enterStoryboardShots(PID, SID, 'gen', 't2v', 5);
    addStoryboardShot(PID, SID, 'gen', 't2v', 5, 6);
    const durations = (): number[] =>
      readStoryboard(PID, SID, 'gen', 't2v')?.shots.map((shot) => shot.duration) ?? [];
    expect(durations()).toEqual([2, 2, 1]);
    retotalStoryboard(PID, SID, 'gen', 't2v', 10);
    expect(durations()).toEqual([4, 4, 2]);
    const first = readStoryboard(PID, SID, 'gen', 't2v')?.shots[0]?.id ?? '';
    stepStoryboardShot(PID, SID, 'gen', 't2v', first, -1);
    expect(durations()).toEqual([3, 5, 2]);
    const last = readStoryboard(PID, SID, 'gen', 't2v')?.shots[2]?.id ?? '';
    removeStoryboardShot(PID, SID, 'gen', 't2v', last, 10);
    expect(durations()).toEqual([3, 7]);
  });

  it('keeps both shots when two people add one at the same time', () => {
    addNode(PID, SID, nodeOf('video'));
    enterStoryboardShots(PID, SID, 'gen', 't2v', 10);
    const doc = (): Y.Doc => getDoc(docName.canvasSpace(PID, SID));
    const baseline = Y.encodeStateAsUpdate(doc());
    addStoryboardShot(PID, SID, 'gen', 't2v', 10, 6);
    const afterA = Y.encodeStateAsUpdate(doc());
    _resetForTests();
    Y.applyUpdate(doc(), baseline);
    addStoryboardShot(PID, SID, 'gen', 't2v', 10, 6);
    Y.applyUpdate(doc(), afterA);
    expect(readStoryboard(PID, SID, 'gen', 't2v')?.shots).toHaveLength(4);
  });
});
