// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Keeping a collaborator's in-flight coordinates out of the document (#2010,
 * design §5.7 and invariant 7).
 *
 * The render buffer holds what is drawn, remote gestures included. Every path
 * that reads geometry out of it on the way to a document write comes through
 * here first.
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import type { DocumentPlace } from '@web/spaces/canvas/doc-geometry-view';
import { docGeometryView } from '@web/spaces/canvas/doc-geometry-view';
import type { GestureTable } from '@web/spaces/canvas/gesture-table';

/** No remote is moving anything. */
const NOBODY: GestureTable = new Map();

/**
 * Build a render-buffer node.
 * @param id - Its id.
 * @param x - Its x in the buffer.
 * @param y - Its y in the buffer.
 * @param extra - Anything else to put on it.
 * @returns The node.
 */
function node(id: string, x: number, y: number, extra: Partial<Node> = {}): Node {
  return { id, type: 'image', position: { x, y }, data: {}, ...extra };
}

/**
 * Build the document's idea of where a node sits.
 * @param id - Its id.
 * @param x - Its x in the document.
 * @param y - Its y in the document.
 * @returns The document place.
 */
function doc(id: string, x: number, y: number): DocumentPlace {
  return { id, position: { x, y } };
}

/**
 * Build a remote gesture table.
 * @param ids - The nodes remote gestures are moving.
 * @returns The table.
 */
function moving(...ids: string[]): GestureTable {
  return new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
}

describe('docGeometryView', () => {
  it('hands back the buffer itself when no remote is gesturing', () => {
    const buffer = [node('n1', 500, 500), node('n2', 5, 5)];
    expect(docGeometryView(buffer, [doc('n1', 0, 0), doc('n2', 5, 5)], NOBODY)).toBe(
      buffer,
    );
  });

  it('puts a node a remote is dragging back where the document has it', () => {
    const buffer = [node('n1', 500, 500)];
    const [seen] = docGeometryView(buffer, [doc('n1', 10, 20)], moving('n1'));
    expect(seen?.position).toEqual({ x: 10, y: 20 });
  });

  it('keeps the size the buffer measured', () => {
    const measured = { width: 640, height: 480 };
    const buffer = [node('n1', 500, 500, { measured })];
    const [seen] = docGeometryView(buffer, [doc('n1', 10, 20)], moving('n1'));
    expect(seen?.measured).toEqual(measured);
  });

  it('keeps a Group stored size while putting its position back', () => {
    const buffer = [
      node('g1', 500, 500, { type: 'group', width: 400, height: 300 }),
    ];
    const [seen] = docGeometryView(buffer, [doc('g1', 10, 20)], moving('g1'));
    expect(seen?.position).toEqual({ x: 10, y: 20 });
    expect(seen?.width).toBe(400);
    expect(seen?.height).toBe(300);
  });

  it('leaves this client own drag alone', () => {
    // The local gesture is exactly what these call sites are committing, so its
    // coordinates are the ones that belong in the document.
    const buffer = [node('mine', 500, 500)];
    const [seen] = docGeometryView(buffer, [doc('mine', 0, 0)], moving('theirs'));
    expect(seen?.position).toEqual({ x: 500, y: 500 });
  });

  it('puts a Group member back at its position relative to the Group', () => {
    // Both sides of this are relative to the Group: the merge stage already
    // measured the remote's absolute coordinates back against the Group origin.
    const buffer = [
      node('g1', 100, 200, { type: 'group', width: 400, height: 300 }),
      node('m1', 88, 99, { parentId: 'g1' }),
    ];
    const seen = docGeometryView(
      buffer,
      [doc('g1', 100, 200), doc('m1', 10, 20)],
      moving('m1'),
    );
    expect(seen[1]?.position).toEqual({ x: 10, y: 20 });
  });

  it('leaves a node the document no longer has where the buffer has it', () => {
    const buffer = [node('n1', 500, 500)];
    const [seen] = docGeometryView(buffer, [], moving('n1'));
    expect(seen?.position).toEqual({ x: 500, y: 500 });
  });

  it('keeps the object of every node no remote is moving', () => {
    const buffer = [node('n1', 500, 500), node('n2', 5, 5)];
    const seen = docGeometryView(
      buffer,
      [doc('n1', 0, 0), doc('n2', 5, 5)],
      moving('n1'),
    );
    expect(seen[0]).not.toBe(buffer[0]);
    expect(seen[1]).toBe(buffer[1]);
  });

  it('puts a whole batch back at once', () => {
    const buffer = [node('n1', 500, 500), node('n2', 600, 600)];
    const seen = docGeometryView(
      buffer,
      [doc('n1', 1, 2), doc('n2', 3, 4)],
      moving('n1', 'n2'),
    );
    expect(seen.map((n) => n.position)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });
});
