// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a Generate panel reads at the instant its execute button is clicked.
 *
 * Each of the three panels (image, video, audio) keeps the same six things,
 * and each one is here for a reason a click makes: the prompt and the
 * in-flight flag are mirrored into refs because React state lags a frame and
 * the handler reads them synchronously; the editor handle is what serializes
 * the prompt at that instant; and the mount flag is how a submit already on
 * its way tells that the panel it started from has gone.
 *
 * Held together rather than declared per panel because they are one mechanism:
 * a fourth panel that copied five of the six would look right and drop a
 * guarantee.
 *
 * The state halves are not spare copies of the refs. Each panel's button runs
 * `evaluateExecute` on them, so the button and the click judge the same
 * question of their own inputs (#1949) — and a panel is a shallow `React.memo`,
 * which only re-renders on the transition because the state changed.
 */

import * as React from 'react';

import type { PromptEditorHandle } from '@web/spaces/canvas/generate/PromptEditor';

/** The submit-time state one Generate panel keeps. */
export interface GenerateSubmitState {
  /** The prompt as state — what the button's enabled look is drawn from. */
  promptText: string;
  /** The same prompt, readable synchronously inside the click handler. */
  promptTextRef: React.RefObject<string>;
  /** Records a prompt change in both. Stable across renders. */
  onPromptChange: (text: string) => void;
  /** The mounted prompt editor, which serializes the prompt at click time. */
  promptEditorRef: React.RefObject<PromptEditorHandle | null>;
  /** Whether a submit is out — what the button draws a spinner from. */
  isSubmitting: boolean;
  /** Sets the flag above; the ref below is the one a click reads. */
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  /** The synchronous re-entry latch: state cannot answer soon enough. */
  submittingRef: React.RefObject<boolean>;
  /** False once this mount is gone, for a submit still on its way back. */
  isMountedRef: React.RefObject<boolean>;
}

/**
 * Builds the submit-time state for one Generate panel.
 * @returns The prompt mirrors, the editor handle, the in-flight mirrors, and
 *   this mount's liveness flag.
 */
export function useGenerateSubmitState(): GenerateSubmitState {
  const [promptText, setPromptText] = React.useState('');
  const promptTextRef = React.useRef('');
  const onPromptChange = React.useCallback((text: string) => {
    promptTextRef.current = text;
    setPromptText(text);
  }, []);
  const promptEditorRef = React.useRef<PromptEditorHandle>(null);

  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);

  // Marks THIS mount stale on unmount. The panel body is keyed by node id, so
  // closing and reopening on the same node remounts a fresh instance, and an
  // in-flight submit from the old one must not close the new panel. Set to
  // true on mount as well, because Strict Mode runs the cleanup once before
  // the effect that matters.
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return {
    promptText,
    promptTextRef,
    onPromptChange,
    promptEditorRef,
    isSubmitting,
    setIsSubmitting,
    submittingRef,
    isMountedRef,
  };
}
