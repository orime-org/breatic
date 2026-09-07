// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { NOTICE_LINGERS_MS } from '@web/pages/project/chat/notice-timing';

interface AtLimitNotice {
  /** Whether the panel is saying the box is full right now. */
  showing: boolean;
  /** Say it, for a keystroke the box has just refused in silence. */
  sayAgain: () => void;
}

/**
 * Saying, on the moment it happens, that the box will take no more.
 *
 * A thing that happened rather than a state the box is in, which is what
 * every other word this panel says is, and what keeps it from sitting there
 * as a label on a full box. It is said when the text first reaches the limit,
 * and again whenever a keystroke is turned away after that: `maxLength`
 * refuses one without a word and without an `input` event, so a reader who
 * kept typing past the first time would otherwise be typing into silence.
 * @param length - How long the draft is.
 * @param limit - How long it may be.
 * @returns Whether to say it, and a way to say it again.
 */
export function useAtLimitNotice(length: number, limit: number): AtLimitNotice {
  const [pulse, setPulse] = React.useState(0);
  const full = length >= limit;
  const wasFull = React.useRef(full);

  React.useEffect(() => {
    if (full && !wasFull.current) setPulse((p) => p + 1);
    if (!full) setPulse(0);
    wasFull.current = full;
  }, [full]);

  React.useEffect(() => {
    if (pulse === 0) return undefined;
    const forgetting = setTimeout(() => setPulse(0), NOTICE_LINGERS_MS);
    return () => clearTimeout(forgetting);
  }, [pulse]);

  const sayAgain = React.useCallback(() => {
    setPulse((p) => p + 1);
  }, []);

  return { showing: pulse > 0, sayAgain };
}
