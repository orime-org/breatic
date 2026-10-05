// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The envelope every panel's Generate goes out in, and the one place a param
 * set in another mode is left behind: params are stored per model across
 * modes, and a control the panel hides in this mode does not send its value.
 */

import { describe, it, expect } from 'vitest';
import type { ParamDescriptor } from '@breatic/shared';

import { buildOverwriteTaskPayload } from '@web/spaces/canvas/generate/overwrite-task-payload';

const DECLARED: Record<string, ParamDescriptor> = {
  duration: { description: '', default: 5, values: [5], fill: 'panel' },
  auto_shots: { description: '', default: false, values: [true, false], modes: ['t2v'], fill: 'panel' },
};

/**
 * The payload for a run in one mode.
 * @param mode - The mode the run is in.
 * @returns The request body.
 */
function payloadIn(mode: string): ReturnType<typeof buildOverwriteTaskPayload> {
  return buildOverwriteTaskPayload({
    taskType: 'video',
    nodeId: 'n',
    projectId: 'p',
    spaceId: 's',
    model: 'kling',
    params: { duration: 5, auto_shots: true, prompt: 'a boat' },
    generation: { mode, declared: DECLARED },
  });
}

describe('the overwrite task envelope', () => {
  it('sends a param declared for the mode the run is in', () => {
    expect(payloadIn('t2v').params).toEqual({ duration: 5, auto_shots: true, prompt: 'a boat' });
  });

  it('leaves a param declared only for other modes behind', () => {
    expect(payloadIn('multi_shot').params).toEqual({ duration: 5, prompt: 'a boat' });
  });

  it('wraps the run in the overwrite envelope', () => {
    expect(payloadIn('t2v')).toMatchObject({ task_type: 'video', model: 'kling', node_ids: ['n'], target_node_id: 'n', mode: 'overwrite' });
  });
});
