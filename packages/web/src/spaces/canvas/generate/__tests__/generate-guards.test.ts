// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  evaluateExecute,
  isExecuteButtonDisabled,
  refusalToastKey,
} from '@web/spaces/canvas/generate/generate-guards';

/** A gate input where every condition is satisfied. */
const ok = {
  promptText: 'a cat',
  model: 'midjourney-v7',
  nodeStatus: 'idle' as string | undefined,
  isSubmitting: false,
  promptRequired: true,
  voiceRequired: false,
  voiceChosen: false,
};

describe('evaluateExecute — which precondition is the one that fails', () => {
  it('returns null when the prompt, model, idle status and non-submitting all hold', () => {
    expect(evaluateExecute(ok)).toBeNull();
  });

  it('trims surrounding whitespace before judging the prompt', () => {
    expect(evaluateExecute({ ...ok, promptText: '  hi  ' })).toBeNull();
  });

  it('names the prompt for an empty or whitespace-only one', () => {
    expect(evaluateExecute({ ...ok, promptText: '' })).toBe('prompt-missing');
    expect(evaluateExecute({ ...ok, promptText: '  \n\t ' })).toBe(
      'prompt-missing',
    );
  });

  it('lets an empty prompt through when the model consumes none (#1935)', () => {
    // The talking-head model declares `takes_prompt: false`, so demanding one
    // would be a requirement we invented: the caller asks the selected model
    // and passes the answer here. Whitespace-only counts as empty on both
    // sides of the switch, so the two paths differ in exactly one thing.
    expect(
      evaluateExecute({ ...ok, promptText: '', promptRequired: false }),
    ).toBeNull();
    expect(
      evaluateExecute({ ...ok, promptText: ' \n\t ', promptRequired: false }),
    ).toBeNull();
  });

  it('still weighs every other precondition when no prompt is required', () => {
    // Dropping the prompt requirement must not become a way past the model,
    // the node's existence, or the in-flight latch.
    const noPrompt = { ...ok, promptText: '', promptRequired: false };
    expect(evaluateExecute({ ...noPrompt, model: '' })).toBe('no-model');
    expect(evaluateExecute({ ...noPrompt, nodeStatus: undefined })).toBe(
      'node-gone',
    );
    expect(evaluateExecute({ ...noPrompt, isSubmitting: true })).toBe(
      'submitting',
    );
  });

  it('names the voice when the model needs one and none is chosen (#1960)', () => {
    // fish-s2-pro's reference_id defaults to null and its inline voice table
    // is empty, so a user who types and hits generate without ever opening
    // the picker sends no voice at all. Upstream succeeds — in its own
    // default voice — and nothing on screen said the choice went unmade.
    expect(evaluateExecute({ ...ok, voiceRequired: true, voiceChosen: false })).toBe(
      'voice-missing',
    );
  });

  it('lets a chosen voice through', () => {
    expect(
      evaluateExecute({ ...ok, voiceRequired: true, voiceChosen: true }),
    ).toBeNull();
  });

  it('ignores the voice for a model that takes none', () => {
    expect(
      evaluateExecute({ ...ok, voiceRequired: false, voiceChosen: false }),
    ).toBeNull();
  });

  it('names the prompt before the voice — the panel reads top to bottom', () => {
    // Both are the user's to fix, so the order follows the panel: the prompt
    // editor sits above the voice picker.
    expect(
      evaluateExecute({
        ...ok,
        promptText: '   ',
        voiceRequired: true,
        voiceChosen: false,
      }),
    ).toBe('prompt-missing');
  });

  it('names the model when none is selected (a mode that offers nothing)', () => {
    expect(evaluateExecute({ ...ok, model: '' })).toBe('no-model');
  });

  it('stays executable while handling — the click surfaces the gate toast (user 2026-07-18)', () => {
    // handling no longer greys the button; clicking it hits the node-state gate,
    // which shows the handling warn-toast (same pattern as a locked node) rather
    // than a silently-disabled button. The gate still blocks the actual submit.
    expect(evaluateExecute({ ...ok, nodeStatus: 'handling' })).toBeNull();
  });

  it('names the node when it no longer exists (status undefined = deleted)', () => {
    expect(evaluateExecute({ ...ok, nodeStatus: undefined })).toBe('node-gone');
  });

  it('stays executable after a prior failure so the user can retry', () => {
    expect(evaluateExecute({ ...ok, nodeStatus: 'error' })).toBeNull();
  });

  it('names the in-flight submission', () => {
    expect(evaluateExecute({ ...ok, isSubmitting: true })).toBe('submitting');
  });
});

describe('evaluateExecute — order: environment facts first, what the user can fix last', () => {
  // The order is the whole reason this returns a reason rather than a boolean,
  // and it is what the design adversarial round changed (#1949). Putting
  // `prompt-missing` first reads as "name what the user can act on", but it
  // produces a button that invites a click, issues an instruction, and then
  // greys out once the instruction is followed.

  it('names the model, not the prompt, when a mode offers no model at all', () => {
    // `promptRequired` is `true` when no model resolves (video-panel-view-model
    // says so in as many words), and `pickModelForMode` yields '' for a mode
    // with an empty list — so these two conditions are not a coincidence, they
    // arrive together every time such a mode is opened. Answering
    // `prompt-missing` here would un-grey the button, tell the user to write a
    // prompt, and grey out again the moment they did.
    expect(evaluateExecute({ ...ok, promptText: '', model: '' })).toBe(
      'no-model',
    );
  });

  it('names the in-flight submission, not the prompt, when the prompt is cleared mid-flight', () => {
    // The prompt editor is not disabled while a submit is in flight, and the
    // prompt is a collaborative fragment — either this user or a collaborator
    // can empty it during that window. Answering `prompt-missing` would swap
    // the spinner back to a clickable arrow while the POST is still out, and
    // that click dies silently on the submitting latch.
    expect(
      evaluateExecute({ ...ok, promptText: '', isSubmitting: true }),
    ).toBe('submitting');
  });

  it('names the missing node ahead of everything else', () => {
    // Nothing else is worth saying about a node that is gone.
    expect(
      evaluateExecute({
        ...ok,
        promptText: '',
        model: '',
        nodeStatus: undefined,
        isSubmitting: true,
      }),
    ).toBe('node-gone');
  });

  it('names the model ahead of the in-flight submission', () => {
    expect(
      evaluateExecute({ ...ok, model: '', isSubmitting: true }),
    ).toBe('no-model');
  });
});

describe('isExecuteButtonDisabled — only what the user cannot act on greys the button', () => {
  // Both panels ask this one function rather than each spelling the set out:
  // two copies of "which refusals grey the button" would drift, and that drift
  // is the shape #1949 set out to remove.

  it('leaves the button clickable when nothing refuses', () => {
    expect(isExecuteButtonDisabled(null)).toBe(false);
  });

  it('leaves the button clickable for a missing prompt — the click explains it', () => {
    expect(isExecuteButtonDisabled('prompt-missing')).toBe(false);
  });

  it('leaves the button clickable for a missing voice, for the same reason', () => {
    expect(isExecuteButtonDisabled('voice-missing')).toBe(false);
  });

  it('greys the button for the three the user cannot act on', () => {
    expect(isExecuteButtonDisabled('node-gone')).toBe(true);
    expect(isExecuteButtonDisabled('no-model')).toBe(true);
    expect(isExecuteButtonDisabled('submitting')).toBe(true);
  });
});

describe('refusalToastKey — which refusal says something out loud', () => {
  // The other half of the policy `isExecuteButtonDisabled` holds: both panels
  // ask these two rather than each spelling the sets out. The two halves must
  // agree — anything that speaks has to be reachable by a click, and only
  // `prompt-missing` leaves the button live.

  it('names the prompt key for the one refusal the user can act on', () => {
    expect(refusalToastKey('prompt-missing')).toBe(
      'canvas.generatePanel.refuseExecuteNoPrompt',
    );
  });

  it('names the voice key when the model needs a voice and has none', () => {
    expect(refusalToastKey('voice-missing')).toBe(
      'canvas.generatePanel.refuseExecuteNoVoice',
    );
  });

  it('says nothing for the three that keep the button disabled', () => {
    expect(refusalToastKey('node-gone')).toBeNull();
    expect(refusalToastKey('no-model')).toBeNull();
    expect(refusalToastKey('submitting')).toBeNull();
  });

  it('speaks exactly for the refusals that leave the button clickable', () => {
    // The invariant tying the two halves together: a refusal that says
    // something must be one a click can reach, and one that stays silent must
    // be one the button already refuses. Drift either way and a user gets
    // either a dead click or a message about a button they cannot press.
    const all = [
      'node-gone',
      'no-model',
      'submitting',
      'prompt-missing',
    ] as const;
    for (const refusal of all) {
      expect(refusalToastKey(refusal) != null).toBe(
        !isExecuteButtonDisabled(refusal),
      );
    }
  });
});
