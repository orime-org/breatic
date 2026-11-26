// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { videoPresentationResponseSchema } from '@breatic/shared';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

const url = 'https://assets.example.test/video/source.webm';
const binding = presentedBinding(url, { width: 96, height: 64, duration: 3, mimeType: 'video/webm' });

// The fixtures the web presentation tests share are real wire values: a fixture the schema refuses would let a test pass
// against a response production never receives (web-unit-testing: a mock has the real return shape).
describe('presentation wire fixtures', () => {
  it.each([
    ['nothing selected or prepared', presentedResponse(binding)],
    ['a preparation in progress', presentedResponse(binding, { preparation: presentedPreparation(null, 'encode') })],
    ['a failed preparation', presentedResponse(binding, { preparation: presentedPreparation('presentation_invalid') })],
    ['a selected bundle', presentedResponse(binding, { presentation: presentedBundle(url) })],
    ['a selected bundle and a target preparation beside it', presentedResponse(binding, { presentation: presentedBundle(url), preparation: presentedPreparation(null, 'encode') })],
    ['a selected alpha-packed bundle', presentedResponse(binding, { presentation: presentedBundle(url, { playback: { kind: 'alpha-packed',
      carrier: { storageKey: 'video/source.webm.packed.mp4', url: `${url}.packed.mp4`, etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' },
      manifest: { storageKey: 'video/source.webm.manifest.json', url: `${url}.manifest.json`, etag: '"manifest"', size: 300, sha256: '8'.repeat(64), contentType: 'application/json' } } }) })],
  ])('%s parses as a presentation response', (_name, response) => {
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });
});
