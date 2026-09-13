// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import * as React from 'react';

import { useFollowColumn, type ReaderAction } from '@web/pages/project/chat/use-follow-column';

/** Undos owed at the end of the current test, newest first. */
const undos: Array<() => void> = [];

afterEach(() => {
  for (const undo of undos.splice(0).reverse()) undo();
});

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/**
 * State the scroll geometry jsdom does not lay out, live.
 *
 * Read on every access, so a test can grow `scrollHeight` the way a reply
 * arriving does. Writes to `scrollTop` land in the same object, so what the
 * column asks for is what the next read returns -- and the browser's clamp is
 * modelled too, because half the questions here turn on it.
 * @param geometry - The values to report, mutated by the caller as it goes.
 * @returns The recorded writes and their reset.
 */
function stateGeometry(geometry: Geometry): { writes: () => number[]; reset: () => void } {
  let writes: number[] = [];
  const keys = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
  const originals = keys.map(
    (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
  );
  for (const k of keys) {
    Object.defineProperty(HTMLElement.prototype, k, {
      get: () => geometry[k],
      set:
        k === 'scrollTop'
          ? function (this: HTMLElement, v: number) {
            const max = geometry.scrollHeight - geometry.clientHeight;
            geometry.scrollTop = Math.max(0, Math.min(v, max));
            writes.push(geometry.scrollTop);
          }
          : undefined,
      configurable: true,
    });
  }
  undos.push(() => {
    for (const [k, d] of originals) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  });
  return {
    writes: () => writes,
    reset: () => {
      writes = [];
    },
  };
}

/**
 * Stand in for the observer, so a test says when a box changed size.
 *
 * Observing delivers a callback straight away, the way a browser's does: that
 * first reading is what everything after it is measured against, and a
 * stand-in that withholds it makes the first real change look like the
 * baseline instead.
 * @returns Firing for one target or all.
 */
function observableResize(): { fire: (match?: (target: Element) => boolean) => void } {
  const watching: Array<{ cb: ResizeObserverCallback; target: Element }> = [];
  const deliver = (cb: ResizeObserverCallback, target: Element): void => {
    const height = target.hasAttribute('data-viewport') ? target.clientHeight : target.scrollHeight;
    cb([{ target, contentRect: { height } }] as unknown as ResizeObserverEntry[], {
      disconnect: () => {},
    } as unknown as ResizeObserver);
  };
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      watching.push({ cb: this.cb, target });
      deliver(this.cb, target);
    }
    unobserve(): void {}
    disconnect(): void {
      for (let i = watching.length - 1; i >= 0; i -= 1) {
        if (watching[i]?.cb === this.cb) watching.splice(i, 1);
      }
    }
  } as unknown as typeof ResizeObserver;
  undos.push(() => {
    globalThis.ResizeObserver = original;
  });
  return {
    fire: (match) => {
      for (const w of [...watching]) {
        if (match && !match(w.target)) continue;
        deliver(w.cb, w.target);
      }
    },
  };
}

/** Let the frames the glide runs on, and the state they publish, come round. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

/**
 * The smallest thing that uses the hook: a scroller, a box inside it, and the
 * way back when it is offered.
 * @param root0 - The props.
 * @param root0.actions - Actions to expose as buttons, so a test can send one.
 * @returns The host.
 */
function Host({ actions = [] }: { actions?: ReaderAction[] }): React.JSX.Element {
  const column = useFollowColumn();
  return (
    <div data-testid='viewport' data-viewport ref={column.setViewport}>
      <div data-testid='content' ref={column.setContent} />
      {column.showWayBack ? (
        <button
          type='button'
          data-testid='way-back'
          onClick={() => {
            column.send('wayBackPressed');
          }}
        />
      ) : null}
      {actions.map((action) => (
        <button
          key={action}
          type='button'
          data-testid={`send-${action}`}
          onClick={() => {
            column.send(action);
          }}
        />
      ))}
    </div>
  );
}

/**
 * Put the column somewhere and tell it, the way the browser would.
 * @param geometry - The live geometry.
 * @param viewport - The scroller.
 * @param top - Where the reader left it.
 */
function readerScrollsTo(geometry: Geometry, viewport: HTMLElement, top: number): void {
  geometry.scrollTop = top;
  fireEvent.scroll(viewport);
}

describe('useFollowColumn', () => {
  it('opens at the end', async () => {
    const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    stateGeometry(geometry);
    observableResize();
    render(<Host />);
    await settle();
    expect(geometry.scrollTop).toBe(1600);
  });

  it('keeps up with content that arrives while it is following', async () => {
    const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const column = stateGeometry(geometry);
    const resize = observableResize();
    render(<Host />);
    await settle();
    column.reset();

    geometry.scrollHeight = 2400;
    act(() => {
      resize.fire();
    });
    await settle();
    expect(geometry.scrollTop).toBe(2000);
  });

  describe('a reader who takes the column', () => {
    it('keeps it, whatever moved it', async () => {
      // No wheel, no key, no pointer -- just the column somewhere else and a
      // scroll event, which is all some of the ways to move it produce.
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      const column = stateGeometry(geometry);
      const resize = observableResize();
      render(<Host />);
      await settle();

      readerScrollsTo(geometry, screen.getByTestId('viewport'), 900);
      column.reset();

      geometry.scrollHeight = 2400;
      act(() => {
        resize.fire();
      });
      await settle();
      expect(geometry.scrollTop).toBe(900);
      expect(column.writes()).toEqual([]);
    });

    it('is offered the way back as soon as it is off the end at all', async () => {
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      stateGeometry(geometry);
      observableResize();
      render(<Host />);
      await settle();
      expect(screen.queryByTestId('way-back')).toBeNull();

      // Two pixels: inside every band the old reading called "near enough",
      // and the reader is the one who put it there.
      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 1598);
      });
      expect(screen.getByTestId('way-back')).toBeInTheDocument();
    });

    it('gets it back by bringing the column to the end themselves', async () => {
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      const column = stateGeometry(geometry);
      const resize = observableResize();
      render(<Host />);
      await settle();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 900);
      });
      expect(screen.getByTestId('way-back')).toBeInTheDocument();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 1600);
      });
      expect(screen.queryByTestId('way-back')).toBeNull();

      column.reset();
      geometry.scrollHeight = 2400;
      act(() => {
        resize.fire();
      });
      await settle();
      expect(geometry.scrollTop).toBe(2000);
    });
  });

  describe('what the browser does on its own', () => {
    it('does not hand the column back when a clamp carries a held reader onto the end', async () => {
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      const column = stateGeometry(geometry);
      const resize = observableResize();
      render(<Host />);
      await settle();

      // Sixty pixels up: held, and near enough to the end that losing content
      // will carry them onto it.
      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 1540);
      });
      expect(screen.getByTestId('way-back')).toBeInTheDocument();

      column.reset();
      geometry.scrollHeight = 1700; // the end is now 1300, above where they sit
      geometry.scrollTop = 1300; // the browser clamps
      act(() => {
        resize.fire();
      });
      await act(async () => {
        fireEvent.scroll(screen.getByTestId('viewport'));
      });
      await settle();

      // The reader never came back, so the column is still theirs, and the
      // arrow is gone because there is nothing below to go to.
      expect(screen.queryByTestId('way-back')).toBeNull();
      expect(column.writes()).toEqual([]);

      // What settles it: the next chunk does not carry them off.
      geometry.scrollHeight = 2100;
      act(() => {
        resize.fire();
      });
      await settle();
      expect(geometry.scrollTop).toBe(1300);
      expect(screen.getByTestId('way-back')).toBeInTheDocument();
    });
  });

  describe('the way back', () => {
    it('travels rather than arrives, and is not cut short by a chunk landing', async () => {
      const geometry: Geometry = { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 };
      stateGeometry(geometry);
      const resize = observableResize();
      render(<Host />);
      await settle();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('way-back'));
      });

      // Two frames in, it has started but is nowhere near arrived. Two
      // because the first carries no elapsed time -- it is the stamp every
      // frame after it is measured against.
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      const underway = geometry.scrollTop;
      expect(underway).toBeGreaterThan(0);
      expect(underway).toBeLessThan(3600);

      // A chunk lands mid-journey. It moves the end, and the journey follows
      // it there rather than jumping.
      geometry.scrollHeight = 4400;
      act(() => {
        resize.fire();
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      expect(geometry.scrollTop).toBeLessThan(4000);

      // The spring takes the better part of a second to settle onto the end,
      // so this waits for the arrival rather than for a fixed stretch.
      await waitFor(() => {
        expect(geometry.scrollTop).toBe(4000);
      }, { timeout: 3000 });
      await settle();
      expect(screen.queryByTestId('way-back')).toBeNull();
    });

    it('takes the better part of a second over it', async () => {
      // The journey is a spring, and a spring is what "travels rather than
      // arrives" means here: it eases in, eases out, and takes enough frames
      // for the reader to see where they were taken from. A step that grows
      // on itself instead of being spent each frame covers the same ground in
      // a handful of frames, which reads as a jump.
      const geometry: Geometry = { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 };
      stateGeometry(geometry);
      observableResize();
      render(<Host />);
      await settle();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('way-back'));
      });

      let frames = 0;
      await act(async () => {
        while (geometry.scrollTop < 3600 && frames < 300) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          frames += 1;
        }
      });
      expect(geometry.scrollTop).toBe(3600);
      expect(frames).toBeGreaterThan(20);
    });

    it('gives the column up to a reader who moves during the journey', async () => {
      const geometry: Geometry = { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 };
      stateGeometry(geometry);
      observableResize();
      render(<Host />);
      await settle();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('way-back'));
      });
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 200);
      });
      const whereTheyLeftIt = geometry.scrollTop;
      await settle();

      expect(geometry.scrollTop).toBe(whereTheyLeftIt);
      expect(screen.getByTestId('way-back')).toBeInTheDocument();
    });
  });

  describe('what the reader does elsewhere', () => {
    it('takes the column back to the end when they send', async () => {
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      stateGeometry(geometry);
      observableResize();
      render(<Host actions={['messageSent']} />);
      await settle();

      await act(async () => {
        readerScrollsTo(geometry, screen.getByTestId('viewport'), 200);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('send-messageSent'));
      });
      expect(geometry.scrollTop).toBe(1600);
      expect(screen.queryByTestId('way-back')).toBeNull();
    });

    it('leaves the column where it is when they open a thinking block', async () => {
      const geometry: Geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
      const column = stateGeometry(geometry);
      const resize = observableResize();
      render(<Host actions={['thinkingOpened']} />);
      await settle();

      await act(async () => {
        fireEvent.click(screen.getByTestId('send-thinkingOpened'));
      });
      column.reset();

      geometry.scrollHeight = 2400;
      act(() => {
        resize.fire();
      });
      await settle();
      expect(geometry.scrollTop).toBe(1600);
      expect(column.writes()).toEqual([]);
    });
  });

  it('stops watching and stops travelling when it goes away', async () => {
    const geometry: Geometry = { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 };
    const column = stateGeometry(geometry);
    observableResize();
    const { unmount } = render(<Host />);
    await settle();

    await act(async () => {
      readerScrollsTo(geometry, screen.getByTestId('viewport'), 0);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('way-back'));
    });
    column.reset();
    unmount();
    await settle();
    expect(column.writes()).toEqual([]);
  });
});
