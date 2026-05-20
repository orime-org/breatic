import { describe, it, expect } from 'vitest';

import {
  isContentNode,
  type AnnotationNodeData,
  type ImageNodeData,
} from '@/spaces/canvas/types/node';

describe('canvas node types', () => {
  it('isContentNode is true for the 4 modality nodes', () => {
    const image: ImageNodeData = { kind: 'image', status: 'idle' };
    expect(isContentNode(image)).toBe(true);
  });

  it('isContentNode is false for annotation', () => {
    const a: AnnotationNodeData = {
      kind: 'annotation',
      text: 'hi',
      authorId: 'u1',
      createdAt: new Date().toISOString(),
    };
    expect(isContentNode(a)).toBe(false);
  });
});
