// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** One audio element for every sample a panel offers. */
export interface SamplePlayer {
  /** The key of the sample playing, or null. */
  readonly playing: string | null;
  /** Start a sample, stopping whatever was playing; the same key again stops it. */
  readonly toggle: (key: string, url: string) => void;
  /** Stop whatever is playing. */
  readonly stop: () => void;
}

/**
 * Samples played through one element, so starting one stops the last: two
 * voices over each other and neither is the one being judged.
 * @returns The player.
 */
export function useSamplePlayer(): SamplePlayer {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  // Which attempt is the current one. `play()` settles whenever it settles,
  // and a rejection from an attempt the reader has already moved on from must
  // not darken the button of the sample now on the speakers.
  const attemptRef = React.useRef(0);

  React.useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const stop = React.useCallback(() => {
    audioRef.current?.pause();
    setPlaying(null);
  }, []);

  const toggle = React.useCallback(
    (key: string, url: string) => {
      audioRef.current?.pause();
      if (playing === key) {
        setPlaying(null);
        return;
      }
      const attempt = ++attemptRef.current;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener('ended', () => setPlaying(null));
      setPlaying(key);
      void audio.play().catch(() => {
        // Autoplay policy, a dead url, an unsupported codec: the sample is a
        // convenience, and the voice stays pickable either way.
        if (attemptRef.current === attempt) setPlaying(null);
      });
    },
    [playing],
  );

  return React.useMemo(() => ({ playing, toggle, stop }), [playing, toggle, stop]);
}
