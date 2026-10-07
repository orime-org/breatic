// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A real ReactFlow canvas with media nodes that carry the crop box, for the
 * crop tests (inner#888 §7.4.1). jsdom has no layout, so the media's screen
 * box and layout box are stubbed from {@link IMG_BOX}, and the observers the
 * crop box listens to are recorded so a test can say "the layout changed".
 */

import { act, fireEvent, screen } from '@testing-library/react';
import { ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import * as React from 'react';
import { vi } from 'vitest';

import { NodeCropLayer } from '@web/spaces/canvas/crop/NodeCropLayer';

/** The media's box on screen, and its layout size unless {@link LAYOUT} says otherwise. Mutable. */
export const IMG_BOX = { left: 100, top: 50, width: 400, height: 300 };

/** The media's layout size when it differs from its screen size (a zoomed canvas). */
export const LAYOUT: { width?: number; height?: number } = {};

/** One media node of the test canvas. */
export interface MediaNodeData extends Record<string, unknown> {
  kind: 'img' | 'video';
  src: string;
}

/**
 * A media node as the canvas renders one: an outer positioned wrapper holding
 * the picture and the crop box.
 * @param props - ReactFlow node props.
 * @returns The node.
 */
function MediaNode({ id, data }: NodeProps<Node<MediaNodeData>>): React.JSX.Element {
  const wrapper = React.useRef<HTMLDivElement>(null);
  return (
    <div ref={wrapper} className='relative'>
      {data.kind === 'video' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- mirrors MediaPlayer's own element.
        <video data-testid='media-element' src={data.src} />
      ) : (
        <img data-testid='image-node-img' src={data.src} alt='' />
      )}
      <NodeCropLayer nodeId={id} wrapper={wrapper} />
    </div>
  );
}

const NODE_TYPES = { media: MediaNode };

/**
 * The canvas with its media nodes and whatever else the test mounts on it.
 * @param nodes - The media nodes, by id.
 * @param children - Rendered inside the ReactFlow, where canvas chrome lives.
 * @param zoom - The canvas zoom.
 * @returns The tree.
 */
export function cropCanvas(
  nodes: ReadonlyArray<{ id: string } & MediaNodeData>,
  children: React.ReactNode,
  zoom = 1,
): React.JSX.Element {
  return (
    <div data-region='space'>
      <ReactFlow
        nodes={nodes.map(({ id, ...data }) => ({ id, type: 'media', position: { x: 0, y: 0 }, data }))}
        edges={[]}
        nodeTypes={NODE_TYPES}
        defaultViewport={{ x: 0, y: 0, zoom }}
      >
        {children}
      </ReactFlow>
      <div data-testid='reference-pick-banner' tabIndex={-1} />
    </div>
  );
}

/** Callbacks of every ResizeObserver the crop box created. */
const observers: Array<() => void> = [];

/**
 * Stub the layout jsdom does not have. The media reports {@link IMG_BOX}
 * both as its screen box and as its layout size; everything else sits at the
 * origin. Call from `beforeEach`.
 */
export function installLayout(): void {
  observers.length = 0;
  delete LAYOUT.width;
  delete LAYOUT.height;
  IMG_BOX.left = 100;
  IMG_BOX.top = 50;
  IMG_BOX.width = 400;
  IMG_BOX.height = 300;
  const isMedia = (el: Element): boolean => el.tagName === 'IMG' || el.tagName === 'VIDEO';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const media = isMedia(this);
    return {
      x: media ? IMG_BOX.left : 0,
      y: media ? IMG_BOX.top : 0,
      left: media ? IMG_BOX.left : 0,
      top: media ? IMG_BOX.top : 0,
      right: media ? IMG_BOX.left + IMG_BOX.width : 1000,
      bottom: media ? IMG_BOX.top + IMG_BOX.height : 1000,
      width: media ? IMG_BOX.width : 1000,
      height: media ? IMG_BOX.height : 1000,
      toJSON: () => ({}),
    } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return isMedia(this) ? (LAYOUT.width ?? IMG_BOX.width) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isMedia(this) ? (LAYOUT.height ?? IMG_BOX.height) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(0);
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      /**
       * Record the callback.
       * @param callback - What a size change runs.
       */
      constructor(callback: () => void) {
        observers.push(callback);
      }

      /** Nothing to watch in jsdom. */
      observe(): void {}

      /** Nothing to stop watching. */
      unobserve(): void {}

      /** Nothing to release. */
      disconnect(): void {}
    },
  );
}

/**
 * The layout changed: run every size observer and let the DOM observers
 * deliver.
 */
export async function relayout(): Promise<void> {
  await act(async () => {
    for (const run of [...observers]) run();
    await Promise.resolve();
  });
}

/**
 * Draw a marquee from A to B on a crop box (screen coordinates).
 * @param from - Pointer-down point.
 * @param to - Pointer-up point.
 * @param prefix - Which crop box.
 */
export function draw(
  from: { x: number; y: number },
  to: { x: number; y: number },
  prefix = 'focus-crop',
): void {
  const layer = screen.getByTestId(`${prefix}-layer`);
  fireEvent.pointerDown(layer, { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(layer, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(layer);
}

/**
 * The marquee's geometry, rounded to whole layout pixels.
 * @param prefix - Which crop box.
 * @returns Its left, top, width and height.
 * @throws {Error} When no marquee is drawn.
 */
export function rectSize(prefix = 'focus-crop'): { width: number; height: number; left: number; top: number } {
  const el = screen.getByTestId(`${prefix}-rect`);
  return {
    width: Math.round(parseFloat(el.style.width)),
    height: Math.round(parseFloat(el.style.height)),
    left: Math.round(parseFloat(el.style.left)),
    top: Math.round(parseFloat(el.style.top)),
  };
}
