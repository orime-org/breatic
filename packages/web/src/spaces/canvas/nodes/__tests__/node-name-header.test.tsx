// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';

import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { AudioNode } from '@web/spaces/canvas/nodes/AudioNode';
import { GroupNode } from '@web/spaces/canvas/nodes/GroupNode';
import { ImageNode } from '@web/spaces/canvas/nodes/ImageNode';
import { TextNode } from '@web/spaces/canvas/nodes/TextNode';
import { ThreeDNode } from '@web/spaces/canvas/nodes/ThreeDNode';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { WebNode } from '@web/spaces/canvas/nodes/WebNode';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

// Each content node renders the name header (icon + name above the body);
// blank name falls back to the fixed-English modality label. annotation
// (own sticky header) and group (container) deliberately do NOT.
const CONTENT_NODES: ReadonlyArray<{
  name: string;
  Comp: ComponentType<{ data: NodeView }>;
  data: NodeView;
  label: string;
}> = [
  {
    name: 'TextNode',
    Comp: TextNode as ComponentType<{ data: NodeView }>,
    data: { kind: 'text', content: '', status: 'idle' },
    label: 'Text',
  },
  {
    name: 'ImageNode',
    Comp: ImageNode as ComponentType<{ data: NodeView }>,
    data: { kind: 'image', status: 'idle' },
    label: 'Image',
  },
  {
    name: 'AudioNode',
    Comp: AudioNode as ComponentType<{ data: NodeView }>,
    data: { kind: 'audio', status: 'idle' },
    label: 'Audio',
  },
  {
    name: 'VideoNode',
    Comp: VideoNode as ComponentType<{ data: NodeView }>,
    data: { kind: 'video', status: 'idle' },
    label: 'Video',
  },
  {
    name: 'ThreeDNode',
    Comp: ThreeDNode as ComponentType<{ data: NodeView }>,
    data: { kind: '3d', status: 'idle' },
    label: '3D',
  },
  {
    name: 'WebNode',
    Comp: WebNode as ComponentType<{ data: NodeView }>,
    data: { kind: 'web', status: 'idle' },
    label: 'Web',
  },
];

describe('node name header', () => {
  CONTENT_NODES.forEach(({ name, Comp, data, label }) => {
    it(`${name} renders the name header with the modality label fallback`, () => {
      render(<Comp data={data} />);
      expect(screen.getByTestId('node-header')).toHaveTextContent(label);
    });
  });

  it('content node shows its name when present', () => {
    render(
      <ImageNode data={{ kind: 'image', status: 'idle', name: 'Hero shot' }} />,
    );
    expect(screen.getByTestId('node-header')).toHaveTextContent('Hero shot');
  });

  it('AnnotationNode does NOT render the name header (it has its own)', () => {
    render(
      <AnnotationNode
        data={{
          kind: 'annotation',
          content: 'note',
          createdBy: 'u1',
          createdAt: 0,
        }}
      />,
    );
    expect(screen.queryByTestId('node-header')).toBeNull();
  });

  it('GroupNode does NOT render the name header (it is a container)', () => {
    render(<GroupNode data={{ kind: 'group' }} />);
    expect(screen.queryByTestId('node-header')).toBeNull();
  });
});
