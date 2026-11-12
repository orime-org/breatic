// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A stand-in for `react-moveable` (breatic#1410 design §4.3). jsdom lays nothing out, so the real handles cannot be
 * dragged; this records the props the Timeline gives the handles and replays the callbacks Moveable would call for a
 * gesture, with the event fields Moveable 0.56 documents (`declaration/types.d.ts`).
 *
 * A test file mocks the module with
 * `vi.mock('react-moveable', async () => (await import('@web/spaces/timeline/__tests__/helpers/moveable-mock')).moveableModule)`.
 */

import * as React from 'react';
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** The callbacks and options the Timeline passes to Moveable, as far as these tests read them. */
type Handler = ((event: Record<string, unknown>) => unknown) | undefined;
export interface MoveableMockProps {
  target?: unknown;
  draggable?: boolean;
  scalable?: boolean;
  rotatable?: boolean;
  keepRatio?: boolean;
  snappable?: boolean;
  snapThreshold?: number;
  verticalGuidelines?: unknown[];
  horizontalGuidelines?: unknown[];
  renderDirections?: string[];
  onDragStart?: Handler;
  onDrag?: Handler;
  onDragEnd?: Handler;
  onScaleStart?: Handler;
  onScale?: Handler;
  onScaleEnd?: Handler;
  onRotateStart?: Handler;
  onRotate?: Handler;
  onRotateEnd?: Handler;
  onClick?: Handler;
  [name: string]: unknown;
}

/** What the mounted handles were last given, and how many are mounted. */
export const moveableMock: { props: MoveableMockProps | null; mounted: number } = { props: null, mounted: 0 };

/**
 * Forget every mounted handle; call it before each test.
 * @throws {never} Never.
 */
export function resetMoveableMock(): void {
  moveableMock.props = null;
  moveableMock.mounted = 0;
}

/** The mocked Moveable: an inert element that publishes its props. */
class MoveableMock extends React.Component<MoveableMockProps> {
  stopDrag = vi.fn();
  updateRect = vi.fn();
  request = vi.fn();
  dragStart = vi.fn();
  isDragging = vi.fn(() => false);

  /**
   * Publish the first props.
   * @throws {never} Never.
   */
  componentDidMount(): void {
    moveableMock.mounted += 1;
    moveableMock.props = this.props;
  }

  /**
   * Publish the current props.
   * @throws {never} Never.
   */
  componentDidUpdate(): void {
    moveableMock.props = this.props;
  }

  /**
   * Withdraw the props once no handle is mounted.
   * @throws {never} Never.
   */
  componentWillUnmount(): void {
    moveableMock.mounted -= 1;
    if (moveableMock.mounted === 0) moveableMock.props = null;
  }

  /**
   * An inert element in place of the handles.
   * @returns It.
   * @throws {never} Never.
   */
  render(): React.JSX.Element {
    return <div data-testid='moveable-mock' />;
  }
}

/** The module `vi.mock('react-moveable')` returns. */
export const moveableModule = { default: MoveableMock, __esModule: true };

/**
 * The mounted handles' props.
 * @returns Them.
 * @throws {Error} When no handle is mounted.
 */
export function handleProps(): MoveableMockProps {
  if (moveableMock.props === null) throw new Error('No Moveable handles are mounted');
  return moveableMock.props;
}

/**
 * Call one Moveable callback as Moveable would, inside act.
 * @param name - The callback.
 * @param event - Its event.
 * @throws {Error} When no handle is mounted or the callback is missing.
 */
function emit(name: keyof MoveableMockProps & `on${string}`, event: Record<string, unknown>): void {
  const handler = handleProps()[name];
  if (typeof handler !== 'function') throw new Error(`Moveable was given no ${name}`);
  act(() => { handler(event); });
}

/**
 * The element the handles act on, as Moveable passes it in every event.
 * @returns The proxy, or null.
 * @throws {never} Never.
 */
function target(): Element | null {
  return document.querySelector('[data-testid="timeline-layer-proxy"]');
}

/**
 * A pointer event of the gesture.
 * @param type - The DOM event type.
 * @param clientX - Its x.
 * @param clientY - Its y.
 * @returns The event.
 * @throws {never} Never.
 */
function input(type: string, clientX = 0, clientY = 0): MouseEvent {
  return new MouseEvent(type, { clientX, clientY, bubbles: true });
}

/**
 * A drag event: `from` is the translate in display pixels when the gesture began, `by` how far it moved since.
 * @param by - The distance in display pixels.
 * @param from - The starting translate in display pixels.
 * @returns The event fields of `OnDrag`.
 * @throws {never} Never.
 */
function dragEvent(by: readonly [number, number], from: readonly [number, number]): Record<string, unknown> {
  const translate = [from[0] + by[0], from[1] + by[1]];
  return {
    target: target(), currentTarget: null, inputEvent: input('mousemove'), isPinch: false,
    beforeTranslate: translate, translate, beforeDist: [...by], dist: [...by], beforeDelta: [...by], delta: [...by],
    left: translate[0], top: translate[1], transform: `translate(${translate[0]}px, ${translate[1]}px)`,
  };
}

/** The start of every gesture. */
const start = (): Record<string, unknown> => ({
  target: target(), currentTarget: null, inputEvent: input('mousedown'), isPinch: false,
  set: vi.fn(), setTransform: vi.fn(), setTransformIndex: vi.fn(), setFixedDirection: vi.fn(), setRatio: vi.fn(), setMinScaleSize: vi.fn(), setMaxScaleSize: vi.fn(),
});

/** The end of a gesture that moved. */
const end = (lastEvent: Record<string, unknown> | undefined): Record<string, unknown> => ({
  target: target(), currentTarget: null, inputEvent: input('mouseup'), isDrag: lastEvent !== undefined, isDouble: false, lastEvent,
});

/** One gesture on the handles, step by step. */
export const gesture = {
  /** Press inside the box. */
  dragStart(): void { emit('onDragStart', start()); },
  /**
   * Move the pointer.
   * @param by - Display pixels moved since the press.
   * @param from - The translate in display pixels at the press.
   * @returns The event sent.
   */
  drag(by: readonly [number, number], from: readonly [number, number] = [0, 0]): Record<string, unknown> {
    const event = dragEvent(by, from);
    emit('onDrag', event);
    return event;
  },
  /**
   * Release.
   * @param lastEvent - The last move, or undefined for a press that never moved.
   */
  dragEnd(lastEvent?: Record<string, unknown>): void { emit('onDragEnd', end(lastEvent)); },
  /**
   * Press a scale handle.
   * @param direction - Its direction: a corner has two non-zero parts, an edge one.
   */
  scaleStart(direction: readonly [number, number]): void { emit('onScaleStart', { ...start(), direction: [...direction], dragStart: start() }); },
  /**
   * Move a scale handle.
   * @param scale - The scale now, relative to an unscaled layer that started at scale 1.
   * @param direction - The handle's direction.
   * @param translate - Display pixels the centre moved so the opposite side stays put.
   * @param from - The translate in display pixels at the press.
   * @returns The event sent.
   */
  scale(scale: readonly [number, number], direction: readonly [number, number], translate: readonly [number, number] = [0, 0], from: readonly [number, number] = [0, 0]): Record<string, unknown> {
    const drag = dragEvent(translate, from);
    const event = {
      target: target(), currentTarget: null, inputEvent: input('mousemove'), isPinch: false, direction: [...direction],
      scale: [...scale], dist: [...scale], delta: [...scale], offsetWidth: 0, offsetHeight: 0, drag, transform: `${String(drag.transform)} scale(${scale[0]}, ${scale[1]})`,
    };
    emit('onScale', event);
    return event;
  },
  /**
   * Release a scale handle.
   * @param lastEvent - The last move.
   */
  scaleEnd(lastEvent?: Record<string, unknown>): void { emit('onScaleEnd', end(lastEvent)); },
  /** Press the rotation handle. */
  rotateStart(): void { emit('onRotateStart', { ...start(), dragStart: start() }); },
  /**
   * Turn the rotation handle.
   * @param rotation - The angle now in degrees, from an unrotated layer.
   * @param from - The translate in display pixels at the press.
   * @returns The event sent.
   */
  rotate(rotation: number, from: readonly [number, number] = [0, 0]): Record<string, unknown> {
    const drag = dragEvent([0, 0], from);
    const event = {
      target: target(), currentTarget: null, inputEvent: input('mousemove'), isPinch: false,
      rotation, beforeRotation: rotation, absoluteRotation: rotation, dist: rotation, beforeDist: rotation, delta: rotation, beforeDelta: rotation,
      drag, transform: `${String(drag.transform)} rotate(${rotation}deg)`,
    };
    emit('onRotate', event);
    return event;
  },
  /**
   * Release the rotation handle.
   * @param lastEvent - The last move.
   */
  rotateEnd(lastEvent?: Record<string, unknown>): void { emit('onRotateEnd', end(lastEvent)); },
  /**
   * A press inside the selected box that did not move, at these client coordinates.
   * @param clientX - Its x.
   * @param clientY - Its y.
   * @returns The input event Moveable reports.
   */
  click(clientX: number, clientY: number): MouseEvent {
    const event = input('click', clientX, clientY);
    const proxy = target();
    emit('onClick', { target: proxy, currentTarget: null, inputEvent: event, inputTarget: proxy, moveableTarget: proxy, isTarget: true, containsTarget: true, isDouble: false });
    return event;
  },
};
