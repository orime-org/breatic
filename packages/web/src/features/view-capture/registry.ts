// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The capture each open Space offers (#1488 §19.1): what it draws right now
 * and the data of what is on screen, registered while it is mounted.
 */

/** What a Space hands back: its picture and what is on screen. */
export interface CapturedView {
  canvas: HTMLCanvasElement;
  /** The on-screen data the agent reads beside the picture (visible ids, camera, playhead). */
  view: Record<string, unknown>;
}

/** Draws a Space as it is on screen. */
export type ViewCapturer = () => Promise<CapturedView>;

const capturers = new Map<string, ViewCapturer>();

/**
 * Offer a Space's capture while it is mounted.
 * @param spaceId - The Space.
 * @param capturer - Draws it.
 * @returns Takes the offer back.
 */
export function registerViewCapture(spaceId: string, capturer: ViewCapturer): () => void {
  capturers.set(spaceId, capturer);
  return (): void => {
    if (capturers.get(spaceId) === capturer) capturers.delete(spaceId);
  };
}

/**
 * The capture a Space offers.
 * @param spaceId - The Space.
 * @returns Its capturer, or undefined when it offers none.
 */
export function viewCapturerOf(spaceId: string): ViewCapturer | undefined {
  return capturers.get(spaceId);
}
