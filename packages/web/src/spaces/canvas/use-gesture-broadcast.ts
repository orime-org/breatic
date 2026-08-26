// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { GeometryNode } from '@web/spaces/canvas/local-gesture';
import { gestureGeometry, gestureNodeIds } from '@web/spaces/canvas/local-gesture';
import type { GestureBatch, GesturePublisher } from '@web/spaces/canvas/use-publish-presence';

/** What a gesture tells the canvas as it runs. */
export interface GestureBroadcast {
  /**
   * A gesture has taken hold: work out everything it moves and publish where
   * those nodes start.
   * @param seedIds - What the gesture grabbed: the dragged nodes, or the resized Group.
   * @param resizedGroupId - The Group being resized, or null during a drag.
   */
  begin: (seedIds: ReadonlyArray<string>, resizedGroupId: string | null) => void;
  /**
   * The gesture moved: publish the whole batch again.
   * @param resizedGroupId - The Group being resized, or null during a drag.
   */
  update: (resizedGroupId: string | null) => void;
  /**
   * The gesture was released. Publishes the final geometry, runs the document
   * write, then takes the field down — in that order (design §5.6).
   * @param resizedGroupId - The Group being resized, or null during a drag.
   * @param writeDocument - Commits the final geometry to the document.
   */
  end: (resizedGroupId: string | null, writeDocument: () => void) => void;
  /** The gesture was cut short: drop the whole batch, with no final value. */
  abandon: () => void;
  /** Whether a gesture is running right now. */
  isRunning: () => boolean;
}

/**
 * Drive the gesture field from the canvas's own drag and resize callbacks.
 *
 * One place owns the field's lifetime, so its states line up with the gesture's:
 * it holds a batch exactly while a gesture is running, and the same set of node
 * ids is what the merge stage keeps off the document.
 * @param publisher - The awareness publisher's gesture commands.
 * @param bufferRef - The render buffer the geometry is read out of.
 * @param activeIds - Holds the nodes this gesture moves; the merge stage reads
 *   the same ref, which is what makes it one set computed in one place.
 * @returns The commands the canvas callbacks drive it with.
 */
export function useGestureBroadcast(
  publisher: GesturePublisher,
  bufferRef: React.RefObject<ReadonlyArray<GeometryNode>>,
  activeIds: React.RefObject<ReadonlySet<string>>,
): GestureBroadcast {
  return React.useMemo((): GestureBroadcast => {
    /**
     * The geometry to publish for whatever the gesture currently holds.
     * @param resizedGroupId - The Group being resized, or null during a drag.
     * @returns The batch, read off the buffer as it stands right now.
     */
    const batch = (resizedGroupId: string | null): GestureBatch =>
      gestureGeometry(activeIds.current, bufferRef.current ?? [], resizedGroupId);
    /** Forget the gesture and take its field down. */
    const drop = (): void => {
      activeIds.current = new Set();
      publisher.clearGesture();
    };
    return {
      begin: (seedIds, resizedGroupId): void => {
        activeIds.current = gestureNodeIds(seedIds, bufferRef.current ?? []);
        publisher.publishGesture(batch(resizedGroupId));
      },
      update: (resizedGroupId): void => {
        publisher.publishGesture(batch(resizedGroupId));
      },
      end: (resizedGroupId, writeDocument): void => {
        publisher.publishGestureNow(batch(resizedGroupId));
        // The field comes down whatever the write does. Leaving it standing
        // would freeze these nodes on every other screen for as long as this
        // client stays connected.
        try {
          writeDocument();
        } finally {
          drop();
        }
      },
      abandon: (): void => {
        if (activeIds.current.size === 0) return;
        drop();
      },
      isRunning: () => activeIds.current.size > 0,
    };
  }, [publisher, bufferRef, activeIds]);
}
