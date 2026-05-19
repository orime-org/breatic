import { describe, it, expect, vi } from 'vitest';

import { applyAsNewNode } from '../apply-as-new-node';

describe('applyAsNewNode (unified Apply contract)', () => {
  it('creates a new sibling node placed 320px to the right of the source', () => {
    const out = applyAsNewNode({
      sourceNode: { id: 'src', position: { x: 100, y: 200 } },
      toolId: 'polish',
      newId: () => 'new-1',
    });
    expect(out.newNode.id).toBe('new-1');
    expect(out.newNode.position).toEqual({ x: 420, y: 200 });
  });

  it('new node inherits the tool output modality + handling status', () => {
    const out = applyAsNewNode({
      sourceNode: { id: 'src', position: { x: 0, y: 0 } },
      toolId: 'text-to-image',
      newId: () => 'n',
    });
    expect(out.newNode.data.kind).toBe('image');
    expect(out.newNode.data.status).toBe('handling');
  });

  it('emits a primary edge linking source → new node with the toolId', () => {
    const out = applyAsNewNode({
      sourceNode: { id: 'src', position: { x: 0, y: 0 } },
      toolId: 'transcribe',
      newId: () => 'n',
    });
    expect(out.edge).toEqual({
      id: 'src->n',
      source: 'src',
      target: 'n',
      kind: 'primary',
      toolId: 'transcribe',
    });
  });

  it('throws on an unknown tool id', () => {
    expect(() =>
      applyAsNewNode({
        sourceNode: { id: 'src', position: { x: 0, y: 0 } },
        toolId: 'does-not-exist',
        newId: () => 'n',
      }),
    ).toThrow(/Unknown mini-tool/);
  });

  it('fires the commit hook with the produced mutation', () => {
    const commit = vi.fn();
    applyAsNewNode({
      sourceNode: { id: 'src', position: { x: 0, y: 0 } },
      toolId: 'polish',
      newId: () => 'n',
      commit,
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0].newNode.id).toBe('n');
  });
});
