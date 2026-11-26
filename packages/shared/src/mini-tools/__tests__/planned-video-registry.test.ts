// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { VIDEO_TOOL_IDS } from '../video-draft.js';
import { miniToolById, servedMiniToolsFor } from '../derive.js';
import { outputsOf } from '../outputs.js';
import { miniToolRequestSchema } from '../request-schema.js';

describe('complete video plans remain outside the legacy execution route', () => {
  it.each(VIDEO_TOOL_IDS)('declares %s as a planned tool available without the model catalog', (id) => {
    expect(miniToolById(id)?.run.kind).toBe('planned');
    expect(servedMiniToolsFor('video', undefined).map((tool) => tool.id)).toContain(id);
  });
  it.each(VIDEO_TOOL_IDS)('refuses to derive %s output counts from editable draft parameters', (id) => {
    const spec = miniToolById(id);
    expect(spec?.id).toBe(id);
    if (spec !== undefined) expect(() => outputsOf(spec, {})).toThrow('execution plan');
  });
  it.each(VIDEO_TOOL_IDS)('rejects %s at the old single-source mini-tool route', (id) => {
    expect(miniToolRequestSchema.safeParse({ tool: id, source: { url: 'https://media.example.test/source.mp4' }, params: {}, project_id: '10000000-0000-4000-8000-000000000001', space_id: '10000000-0000-4000-8000-000000000002', node_ids: ['10000000-0000-4000-8000-000000000003'] }).success).toBe(false);
  });
});
