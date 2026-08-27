// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { GeometryNode } from '@web/spaces/canvas/local-gesture';
import { gestureGeometry, gestureNodeIds } from '@web/spaces/canvas/local-gesture';
import type { GestureBatch } from '@web/spaces/canvas/gesture-table';
import type { GesturePublisher } from '@web/spaces/canvas/use-publish-presence';

/** What a gesture tells the canvas as it runs. */
export interface GestureBroadcast {
  /**
   * A gesture has taken hold: work out everything it moves and publish where
   * those nodes start. What it holds and which Group it resizes stay fixed for
   * the rest of the gesture, so neither is asked for again.
   * @param seedIds - What the gesture moves at the top level.
   * @param resizedGroupId - The Group being resized, or null during a drag.
   */
  begin: (seedIds: ReadonlyArray<string>, resizedGroupId: string | null) => void;
  /** The gesture moved: publish the whole batch again. */
  update: () => void;
  /**
   * The gesture was released. Publishes the final geometry, runs the document
   * write, then takes the field down — in that order (design §5.6).
   * @param writeDocument - Commits the final geometry to the document.
   */
  end: (writeDocument: () => void) => void;
  /** The gesture was cut short: drop the whole batch, with no final value. */
  abandon: () => void;
  /** Whether a gesture is currently held. */
  isRunning: () => boolean;
}

/**
 * Drive the gesture field from the canvas's own drag and resize callbacks.
 *
 * One place owns the field's lifetime, so its states line up with the gesture's:
 * it holds a batch exactly while a gesture is running, and the same set of node
 * ids is what the merge stage keeps off the document.
 * @param publisher - The awareness publisher's gesture commands.
 * @param onScreen - Reads the render buffer as the canvas is drawing it.
 * @param onHeldChange - Hands out the nodes this gesture moves, every time that
 *   set changes. The commands need it synchronously, so it lives in a ref here;
 *   the merge stage needs React to see it change, which is what this is for.
 *   Without it a gesture that ends with no document write — an abandon — would
 *   leave its nodes frozen in the buffer until some unrelated change happened
 *   to come along.
 * @returns The commands the canvas callbacks drive it with.
 */
export function useGestureBroadcast(
  publisher: GesturePublisher,
  onScreen: () => ReadonlyArray<GeometryNode>,
  onHeldChange: (ids: ReadonlySet<string>) => void,
): GestureBroadcast {
  // Which Group the gesture is resizing, settled when it starts and read back
  // on every later call.
  const resizedGroup = React.useRef<string | null>(null);
  const activeIds = React.useRef<ReadonlySet<string>>(new Set());
  return React.useMemo((): GestureBroadcast => {
    /**
     * The geometry to publish for whatever the gesture currently holds.
     * @returns The batch, read off the buffer as it stands right now.
     */
    const batch = (): GestureBatch =>
      gestureGeometry(
        activeIds.current,
        onScreen(),
        resizedGroup.current,
      );
    /** Forget the gesture and take its field down. */
    const drop = (): void => {
      activeIds.current = new Set();
      resizedGroup.current = null;
      publisher.clearGesture();
      onHeldChange(activeIds.current);
    };
    return {
      begin: (seedIds, resizedGroupId): void => {
        resizedGroup.current = resizedGroupId;
        activeIds.current = gestureNodeIds(seedIds, onScreen());
        publisher.publishGesture(batch());
        onHeldChange(activeIds.current);
      },
      update: (): void => {
        // xyflow keeps its auto-pan frame loop alive through an aborted drag
        // (`@xyflow/system:2263-2272` returns before cancelling it), so this
        // keeps arriving after the gesture is gone.
        if (activeIds.current.size === 0) return;
        publisher.publishGesture(batch());
      },
      end: (writeDocument): void => {
        publisher.publishGestureNow(batch());
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
  }, [publisher, onScreen, onHeldChange]);
}
