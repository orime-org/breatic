// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Scrolls the document body — or, for a table column drag, the table's own
 * frame — while something is dragged or a selection is pulled past its edge
 * (inner#1350 A2–A5, A7).
 *
 * Chrome's own drag autoscroll only acts inside a 20px band of the scroller
 * under the pointer and stops when the pointer leaves the window; the page gets
 * no drag events out there at all. So one loop driven by the last pointer
 * reading does the scrolling, the way Plane does for its editor.
 *
 * Inside the hitbox the step is Pragmatic drag and drop's (`get-scroll-change.ts`,
 * `configuration.ts`): a hitbox of a quarter of the scroller capped at 180px,
 * full speed over its outer half, 900px/s normalised by frame time, ramped in
 * over 400ms. Past the edge it is Chrome's selection autoscroll step
 * (`20 + distance`, per frame) plus that 15px maximum, so pushing further out
 * is never slower than Chrome's own band added to ours.
 *
 * A selection pulled past the edge (a press the browser does not own) takes
 * Chrome's selection step alone, so it feels the same as one Chrome scrolls.
 */

import type { EditorView } from '@tiptap/pm/view';

/** The element a scroll area scrolls. */
export const SCROLL_VIEWPORT = '[data-radix-scroll-area-viewport]';

/**
 * The element the body scrolls in.
 * @param view - The editor view.
 * @returns The scroller, or null when the body is not in one.
 */
export function bodyScrollerOf(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>(SCROLL_VIEWPORT);
}

/** The box of a scroller, in client coordinates. */
export interface EdgeBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** A pointer position, in client coordinates. */
export interface PointerAt {
  readonly x: number;
  readonly y: number;
}

/** The axis a scroller moves along. */
export type ScrollAxis = 'x' | 'y';

/** Where the pointer is against a scroller's edges along one axis. */
export interface EdgeReading {
  /** Towards which edge: -1 the start, 1 the end, 0 neither. */
  readonly dir: -1 | 0 | 1;
  /** 0–1 through the hitbox; 1 over its outer half and past the edge. */
  readonly factor: number;
  /** How far past the edge, in px; 0 inside the scroller. */
  readonly beyond: number;
}

/** What a drag session scrolls. */
export interface DragTarget {
  readonly el: HTMLElement;
  readonly axis: ScrollAxis;
  /** Whether the pointer must sit within the scroller across the other axis. */
  readonly gate: boolean;
}

/** What the session needs from the page. */
export interface AutoScrollDeps {
  readonly requestFrame: (cb: (time: number) => void) => number;
  readonly cancelFrame: (id: number) => void;
  readonly viewport: () => { width: number; height: number };
}

/** Share of the scroller the hitbox takes, before the cap. */
const HITBOX_SHARE = 0.25;
/** The hitbox's largest size, in px. */
const HITBOX_CAP = 180;
/** Share of the hitbox, at its outer end, that scrolls at full speed. */
const FULL_SHARE = 0.5;
/** Full speed inside the hitbox, px per second. */
const MAX_PER_SECOND = 900;
/** The most one frame moves inside the hitbox: full speed at 60fps. */
const MAX_STEP = MAX_PER_SECOND / 60;
/** Time from the pointer coming over the scroller to full speed, in ms. */
const RAMP_MS = 400;
/** Chrome's autoscroll band, in px (`autoscroll_controller.cc`). */
const NATIVE_BAND = 20;

/** A reading of nothing. */
const STILL: EdgeReading = { dir: 0, factor: 0, beyond: 0 };

/**
 * Reads where the pointer is against a scroller's edges along one axis.
 * @param box - The scroller's box.
 * @param at - The pointer.
 * @param axis - The axis it scrolls along.
 * @param gate - Whether a pointer outside the box across the other axis reads nothing.
 * @returns The reading.
 */
export function readEdge(box: EdgeBox, at: PointerAt, axis: ScrollAxis, gate: boolean): EdgeReading {
  const [start, end, along] = axis === 'y' ? [box.top, box.bottom, at.y] : [box.left, box.right, at.x];
  if (!isOver(box, at, axis, gate)) return STILL;
  if (along < start) return { dir: -1, factor: 1, beyond: start - along };
  if (along > end) return { dir: 1, factor: 1, beyond: along - end };
  const hitbox = Math.min((end - start) * HITBOX_SHARE, HITBOX_CAP);
  const ramp = hitbox * (1 - FULL_SHARE);
  if (along < start + hitbox) return { dir: -1, factor: Math.min(1, (start + hitbox - along) / ramp), beyond: 0 };
  if (along > end - hitbox) return { dir: 1, factor: Math.min(1, (along - (end - hitbox)) / ramp), beyond: 0 };
  return STILL;
}

/**
 * Whether the pointer is over the scroller, or past its edge along the axis it
 * scrolls: the reach over which a drag's ramp is kept.
 * @param box - The scroller's box.
 * @param at - The pointer.
 * @param axis - The axis it scrolls along.
 * @param gate - Whether the pointer must sit within it across the other axis.
 * @returns Whether it is.
 */
function isOver(box: EdgeBox, at: PointerAt, axis: ScrollAxis, gate: boolean): boolean {
  if (!gate) return true;
  const [crossStart, crossEnd, across] = axis === 'y' ? [box.left, box.right, at.x] : [box.top, box.bottom, at.y];
  return across >= crossStart && across <= crossEnd;
}

/**
 * The pixels one frame of a drag moves.
 * @param reading - Where the pointer is.
 * @param sinceEngagedMs - Time since the pointer came over the scroller.
 * @param frameMs - Time since the last frame.
 * @returns The signed step.
 */
export function dragStep(reading: EdgeReading, sinceEngagedMs: number, frameMs: number): number {
  if (reading.dir === 0) return 0;
  const ramp = rampAt(sinceEngagedMs);
  if (reading.beyond > 0) return pastEdgeStep(reading, ramp);
  const cap = Math.min(Math.ceil((MAX_PER_SECOND / 1000) * frameMs), MAX_STEP);
  return reading.dir * Math.max(cap * reading.factor * ramp, 1);
}

/**
 * How far into the ramp a drag is.
 * @param sinceEngagedMs - Time since the pointer came over the scroller.
 * @returns 0–1.
 */
function rampAt(sinceEngagedMs: number): number {
  return Math.min(1, Math.max(0, sinceEngagedMs) / RAMP_MS);
}

/**
 * The step past the edge: Chrome's selection step plus the hitbox's maximum,
 * per frame.
 * @param reading - Where the pointer is.
 * @param ramp - How far into the ramp.
 * @returns The signed step.
 */
function pastEdgeStep(reading: EdgeReading, ramp: number): number {
  return reading.dir * Math.max((MAX_STEP + NATIVE_BAND + reading.beyond) * ramp, 1);
}

/**
 * The pixels one frame of a pulled selection moves: Chrome's selection
 * autoscroll, which reads only the vertical position.
 * @param box - The body scroller's box.
 * @param at - The pointer.
 * @returns The signed step.
 */
export function pressStep(box: EdgeBox, at: PointerAt): number {
  if (at.y < box.top) return -(NATIVE_BAND + (box.top - at.y));
  if (at.y < box.top + NATIVE_BAND) return -(NATIVE_BAND - (at.y - box.top));
  if (at.y > box.bottom) return NATIVE_BAND + (at.y - box.bottom);
  if (at.y > box.bottom - NATIVE_BAND) return NATIVE_BAND - (box.bottom - at.y);
  return 0;
}

/**
 * Whether a drag that left the window carries on scrolling. The page gets the
 * same `dragleave` for leaving and for an Esc, so only a pointer that was past
 * the edge — or at full speed against an edge that is the window's own —
 * counts as having left.
 * @param last - The reading before the pointer left.
 * @param edgeIsWindowEdge - Whether that edge of the scroller is the window's.
 * @returns Whether to keep scrolling.
 */
export function carriesOutside(last: EdgeReading, edgeIsWindowEdge: boolean): boolean {
  if (last.dir === 0) return false;
  return last.beyond > 0 || (edgeIsWindowEdge && last.factor >= 1);
}

/** What a session was started by. */
export type AutoScrollSource = 'drag' | 'press';

/** Where a session stands (design §5.3). */
export type AutoScrollState = 'idle' | 'tracking' | 'outside';

/** One running session. */
interface Session {
  readonly source: AutoScrollSource;
  readonly target: DragTarget;
  at: PointerAt | null;
  /** The reading the pointer left the window with. */
  last: EdgeReading;
  engagedAt: number | null;
  lastFrame: number | null;
  outside: boolean;
  carry: boolean;
}

/**
 * The single loop that scrolls while a drag or a pulled selection is on. Its
 * own methods are the only writers of its state.
 */
export class BodyAutoScroll {
  private session: Session | null = null;
  private frame: number | null = null;

  /**
   * Creates an idle loop.
   * @param deps - Frames and the window size.
   */
  constructor(private readonly deps: AutoScrollDeps) {}

  /**
   * Where the session stands.
   * @returns The state.
   */
  get state(): AutoScrollState {
    if (this.session === null) return 'idle';
    return this.session.outside ? 'outside' : 'tracking';
  }

  /**
   * What started the running session.
   * @returns The source, or null when idle.
   */
  get source(): AutoScrollSource | null {
    return this.session?.source ?? null;
  }

  /**
   * What the running session scrolls.
   * @returns The target, or null when idle.
   */
  get target(): DragTarget | null {
    return this.session?.target ?? null;
  }

  /**
   * Starts a drag session; one already running is replaced.
   * @param target - What it scrolls.
   */
  beginDrag(target: DragTarget): void {
    this.start('drag', target);
  }

  /**
   * Starts a pulled-selection session on the body scroller.
   * @param el - The body scroller.
   * @param at - The pointer to start from; null for a press that has not
   * moved, which Chrome does not scroll until it is dragged.
   */
  beginPress(el: HTMLElement, at: PointerAt | null): void {
    this.start('press', { el, axis: 'y', gate: false });
    if (at !== null) this.follow(at);
  }

  /**
   * Takes the pointer's latest position; inside the window again after it left.
   * @param at - The pointer.
   */
  follow(at: PointerAt): void {
    const { session } = this;
    if (session === null) return;
    session.at = at;
    session.outside = false;
  }

  /** The pointer left the window during a drag. */
  leaveWindow(): void {
    const { session } = this;
    if (session === null || session.source !== 'drag') return;
    session.outside = true;
    // Outside the window the loop goes on from the last dragover, which no
    // frame may have read yet.
    const { target } = session;
    const left = session.at === null ? STILL : readEdge(target.el.getBoundingClientRect(), session.at, target.axis, target.gate);
    session.last = left;
    session.carry = carriesOutside(left, this.edgeIsWindowEdge(target, left.dir));
  }

  /**
   * Ends the session.
   * @param source - Ends it only when it was started by this; any when omitted.
   */
  end(source?: AutoScrollSource): void {
    if (this.session === null || (source !== undefined && this.session.source !== source)) return;
    this.session = null;
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
  }

  /**
   * Starts a session and its loop.
   * @param source - What started it.
   * @param target - What it scrolls.
   */
  private start(source: AutoScrollSource, target: DragTarget): void {
    this.end();
    this.session = { source, target, at: null, last: STILL, engagedAt: null, lastFrame: null, outside: false, carry: false };
    this.schedule();
  }

  /** Asks for the next frame. */
  private schedule(): void {
    this.frame = this.deps.requestFrame((time) => {
      this.step(time);
    });
  }

  /**
   * Moves the scroller one frame.
   * @param time - The frame's time.
   */
  private step(time: number): void {
    const { session } = this;
    if (session === null) return;
    const frameMs = session.lastFrame === null ? 1000 / 60 : time - session.lastFrame;
    session.lastFrame = time;
    const delta = this.delta(session, time, frameMs);
    if (delta !== 0) {
      const { el, axis } = session.target;
      if (axis === 'y') el.scrollTop += delta;
      else el.scrollLeft += delta;
    }
    this.schedule();
  }

  /**
   * The step this frame, and the ramp bookkeeping behind it.
   * @param session - The session.
   * @param time - The frame's time.
   * @param frameMs - Time since the last frame.
   * @returns The signed step.
   */
  private delta(session: Session, time: number, frameMs: number): number {
    const { target } = session;
    if (session.outside) {
      // Outside the window the scroll goes on at the step past the edge, from
      // the distance the pointer had when it left.
      if (!session.carry) return 0;
      // A pointer flung out before any frame saw it over the scroller starts
      // its ramp here.
      session.engagedAt ??= time;
      return pastEdgeStep(session.last, rampAt(time - session.engagedAt));
    }
    if (session.at === null) return 0;
    const box = target.el.getBoundingClientRect();
    if (session.source === 'press') return pressStep(box, session.at);
    if (!isOver(box, session.at, target.axis, target.gate)) {
      session.engagedAt = null;
      return 0;
    }
    // Pragmatic starts the ramp as soon as the pointer is over the scroller,
    // not when it enters the hitbox (`try-scroll.ts`, `engagement-history.ts`).
    session.engagedAt ??= time;
    return dragStep(readEdge(box, session.at, target.axis, target.gate), time - session.engagedAt, frameMs);
  }

  /**
   * Whether a scroller's edge towards a direction is the window's own edge.
   * @param target - The scroller.
   * @param dir - Towards which edge.
   * @returns Whether it is.
   */
  private edgeIsWindowEdge(target: DragTarget, dir: EdgeReading['dir']): boolean {
    const box = target.el.getBoundingClientRect();
    const { width, height } = this.deps.viewport();
    if (target.axis === 'y') return dir < 0 ? box.top <= 1 : box.bottom >= height - 1;
    return dir < 0 ? box.left <= 1 : box.right >= width - 1;
  }
}
