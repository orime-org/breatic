// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';

import { useTranscribePreference } from '@web/stores/transcribe-preference';

afterEach(() => useTranscribePreference.setState({ keepFillers: true }));

// inner#856: the filler switch starts on and remembers the reader's last
// choice for the whole page, across canvases and projects.
describe('the transcription filler switch', () => {
  it('starts on', () => {
    expect(useTranscribePreference.getState().keepFillers).toBe(true);
  });

  it('remembers what it was last set to', () => {
    useTranscribePreference.getState().setKeepFillers(false);
    expect(useTranscribePreference.getState().keepFillers).toBe(false);
  });
});
