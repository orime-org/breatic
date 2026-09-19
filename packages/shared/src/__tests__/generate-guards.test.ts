// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  evaluateExecute,
  isExecuteButtonDisabled,
  refusalToastKey,
  REFUSAL_TOAST_KEY,
  type ExecuteGateInput,
  type ExecuteRefusal,
} from "@shared/generate-guards.js";

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

/**
 * Which precondition failed, without the detail a sentence would need.
 * @param input - What the gate weighs.
 * @returns The refusal, or null when every precondition holds.
 */
function refusalOf(input: ExecuteGateInput): ExecuteRefusal | null {
  return evaluateExecute(input)?.refusal ?? null;
}

describe('evaluateExecute — which precondition is the one that fails', () => {
  it('returns null when the prompt, model, idle status and non-submitting all hold', () => {
    expect(refusalOf(ok)).toBeNull();
  });

  it('trims surrounding whitespace before judging the prompt', () => {
    expect(refusalOf({ ...ok, promptText: '  hi  ' })).toBeNull();
  });

  it('names the prompt for an empty or whitespace-only one', () => {
    expect(refusalOf({ ...ok, promptText: '' })).toBe('prompt-missing');
    expect(refusalOf({ ...ok, promptText: '  \n\t ' })).toBe(
      'prompt-missing',
    );
  });

  it('lets an empty prompt through when the model consumes none (#1935)', () => {
    // The talking-head model declares `takes_prompt: false`, so demanding one
    // would be a requirement we invented: the caller asks the selected model
    // and passes the answer here. Whitespace-only counts as empty on both
    // sides of the switch, so the two paths differ in exactly one thing.
    expect(
      refusalOf({ ...ok, promptText: '', promptRequired: false }),
    ).toBeNull();
    expect(
      refusalOf({ ...ok, promptText: ' \n\t ', promptRequired: false }),
    ).toBeNull();
  });

  it('still weighs every other precondition when no prompt is required', () => {
    // Dropping the prompt requirement must not become a way past the model,
    // the node's existence, or the in-flight latch.
    const noPrompt = { ...ok, promptText: '', promptRequired: false };
    expect(refusalOf({ ...noPrompt, model: '' })).toBe('no-model');
    expect(refusalOf({ ...noPrompt, nodeStatus: undefined })).toBe(
      'node-gone',
    );
    expect(refusalOf({ ...noPrompt, isSubmitting: true })).toBe(
      'submitting',
    );
  });

  it('names the voice when the model needs one and none is chosen (#1960)', () => {
    // fish-s2-pro's reference_id defaults to null and its inline voice table
    // is empty, so a user who types and hits generate without ever opening
    // the picker sends no voice at all. Upstream succeeds — in its own
    // default voice — and nothing on screen said the choice went unmade.
    expect(refusalOf({ ...ok, voiceRequired: true, voiceChosen: false })).toBe(
      'voice-missing',
    );
  });

  it('lets a chosen voice through', () => {
    expect(
      refusalOf({ ...ok, voiceRequired: true, voiceChosen: true }),
    ).toBeNull();
  });

  it('ignores the voice for a model that takes none', () => {
    expect(
      refusalOf({ ...ok, voiceRequired: false, voiceChosen: false }),
    ).toBeNull();
  });

  it('names the prompt before the voice — the panel reads top to bottom', () => {
    // Both are the user's to fix, so the order follows the panel: the prompt
    // editor sits above the voice picker.
    expect(
      refusalOf({
        ...ok,
        promptText: '   ',
        voiceRequired: true,
        voiceChosen: false,
      }),
    ).toBe('prompt-missing');
  });

  it('names the model when none is selected (a mode that offers nothing)', () => {
    expect(refusalOf({ ...ok, model: '' })).toBe('no-model');
  });

  it('stays executable while handling — the click surfaces the gate toast (user 2026-07-18)', () => {
    // handling no longer greys the button; clicking it hits the node-state gate,
    // which shows the handling warn-toast (same pattern as a locked node) rather
    // than a silently-disabled button. The gate still blocks the actual submit.
    expect(refusalOf({ ...ok, nodeStatus: 'handling' })).toBeNull();
  });

  it('names the node when it no longer exists (status undefined = deleted)', () => {
    expect(refusalOf({ ...ok, nodeStatus: undefined })).toBe('node-gone');
  });

  it('stays executable after a prior failure so the user can retry', () => {
    expect(refusalOf({ ...ok, nodeStatus: 'error' })).toBeNull();
  });

  it('names the in-flight submission', () => {
    expect(refusalOf({ ...ok, isSubmitting: true })).toBe('submitting');
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
    expect(refusalOf({ ...ok, promptText: '', model: '' })).toBe(
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
      refusalOf({ ...ok, promptText: '', isSubmitting: true }),
    ).toBe('submitting');
  });

  it('names the missing node ahead of everything else', () => {
    // Nothing else is worth saying about a node that is gone.
    expect(
      refusalOf({
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
      refusalOf({ ...ok, model: '', isSubmitting: true }),
    ).toBe('no-model');
  });
});

describe('isExecuteButtonDisabled — only what the user cannot act on greys the button', () => {
  // Every panel asks this one function rather than each spelling the set out:
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
    //
    // 遍历那张表本身，而不是在这里手抄一份成员清单。成员齐不齐由那张表的键
    // 类型管（漏一个当场 typecheck 红），这里只管配对。
    for (const refusal of Object.keys(REFUSAL_TOAST_KEY) as ExecuteRefusal[]) {
      expect(refusalToastKey(refusal) != null, refusal).toBe(
        !isExecuteButtonDisabled(refusal),
      );
    }
  });
});

describe('evaluateExecute — text the model will not take (#1960 A17)', () => {
  // A cap the catalog states, from the model vendor's own documentation.
  const capped = { ...ok, maxInputChars: 10 };

  it('names the length once the text is past the cap', () => {
    expect(refusalOf({ ...capped, promptText: 'x'.repeat(11) })).toBe(
      'prompt-too-long',
    );
  });

  it('lets text exactly at the cap through', () => {
    expect(refusalOf({ ...capped, promptText: 'x'.repeat(10) })).toBeNull();
  });

  // Absent means uncapped: fish states no per-request limit, and inventing one
  // would refuse text its upstream accepts.
  it('never refuses on length when the model states no cap', () => {
    expect(
      refusalOf({ ...ok, promptText: 'x'.repeat(100_000) }),
    ).toBeNull();
  });

  // The worker cleans the prompt before the vendor sees it — `extractPromptText`
  // trims the ends, folds runs of spaces into one and collapses blank lines —
  // so counting the raw editor text refuses messages the upstream would take.
  it('does not count whitespace the worker strips before sending', () => {
    expect(refusalOf({ ...capped, promptText: `  ${'x'.repeat(9)}  ` })).toBeNull();
  });

  it('does not count the runs of spaces the worker folds into one', () => {
    // 11 raw characters, 9 once the run between the words is one space.
    expect(refusalOf({ ...capped, promptText: 'xxxx   xxxx' })).toBeNull();
  });

  it('still refuses when the cleaned text is what goes over', () => {
    // Nothing here folds: 11 characters reach the vendor as 11.
    expect(refusalOf({ ...capped, promptText: 'x'.repeat(11) })).toBe(
      'prompt-too-long',
    );
  });

  // Vendors count characters; JS string length counts UTF-16 units, which is
  // two for every emoji and every rarer CJK glyph. Counting units would refuse
  // a message half the length of the one the vendor would accept.
  it('counts characters, not UTF-16 units', () => {
    const tenEmoji = '🎙'.repeat(10);
    expect(tenEmoji.length).toBe(20);
    expect(refusalOf({ ...capped, promptText: tenEmoji })).toBeNull();
  });

  // Order: an empty prompt is empty whatever the cap says, and a cap of zero
  // must not turn "write something" into "that is too long".
  it('still names an empty prompt first', () => {
    expect(refusalOf({ ...capped, promptText: '' })).toBe(
      'prompt-missing',
    );
  });

  // A model that consumes no prompt has nothing to measure, and its panel
  // offers no editor to shorten.
  it('leaves a model that takes no prompt alone', () => {
    expect(
      refusalOf({
        ...capped,
        promptRequired: false,
        promptText: 'x'.repeat(50),
      }),
    ).toBeNull();
  });

  it('leaves the button live, because the user can shorten the text', () => {
    expect(isExecuteButtonDisabled('prompt-too-long')).toBe(false);
    expect(refusalToastKey('prompt-too-long')).toBe(
      'canvas.generatePanel.refuseExecuteTooLong',
    );
  });
});

/**
 * The reference audio a cloning model needs (#1960 PR2).
 *
 * Same shape as `voice-missing`, and for the same reason: it is a condition the
 * user can act on, so the button stays live and the click says what is missing.
 * A greyed-out button would never tell them a slot is empty.
 */
describe('evaluateExecute — the reference-audio slot', () => {
  /** A cloning model with nothing picked yet. */
  const cloning = {
    ...ok,
    requiredSlots: ['refAudio'],
    filledSlots: [] as readonly string[],
  };

  it('names the empty slot when the mode needs an audio source', () => {
    expect(refusalOf(cloning)).toBe('source-missing');
  });

  it('passes once something is picked', () => {
    expect(refusalOf({ ...cloning, filledSlots: ['refAudio'] })).toBeNull();
  });

  it('says nothing about it on a mode that needs no audio source', () => {
    // Text to speech declares no audio source, so an unfilled slot it never shows
    // must not refuse anything.
    expect(
      refusalOf({ ...ok, requiredSlots: [], filledSlots: [] }),
    ).toBeNull();
  });

  it('reports the prompt first, the panel order', () => {
    // The editor sits above the toolbar's slot, so an empty prompt is what the
    // user is told about first — the same ordering `voice-missing` follows.
    expect(refusalOf({ ...cloning, promptText: '' })).toBe('prompt-missing');
  });

  it('leaves the button live and speaks on click', () => {
    expect(isExecuteButtonDisabled('source-missing')).toBe(false);
    expect(refusalToastKey('source-missing')).toBe(
      'canvas.generatePanel.errorNoRefAudio',
    );
  });

  it('keeps every refusal the user can act on clickable', () => {
    // The set, stated once. A new refusal added to the union without a place
    // in this list is one nobody decided the button behaviour for.
    const actionable: ExecuteRefusal[] = [
      'prompt-missing',
      'prompt-too-long',
      'voice-missing',
      'source-missing',
      'sources-missing',
      'lyrics-missing',
    ];
    for (const refusal of actionable) {
      expect(isExecuteButtonDisabled(refusal), refusal).toBe(false);
      expect(refusalToastKey(refusal), refusal).not.toBeNull();
    }
  });
});

/**
 * A mode that offers several slots and needs any one of them (#1960 A6).
 *
 * Reference to music collects a whole song, a vocal line and a backing track,
 * and one is enough — the vendor takes whichever are given. The gate weighed a
 * single `refAudioRequired` / `refAudioChosen` pair before, so a user who
 * filled all three of these still faced a greyed-out button: none of them is
 * named `refAudio`.
 */
describe('evaluateExecute — a mode with several slots takes any one', () => {
  const MUSIC_SLOTS = ['musicSong', 'musicVoice', 'musicInstrumental'];
  /** Reference to music with all three slots empty. */
  const a2m = {
    ...ok,
    requiredSlots: MUSIC_SLOTS,
    filledSlots: [] as readonly string[],
    sourceRule: 'any_of' as const,
  };

  it('asks for a reference while every slot is empty', () => {
    expect(refusalOf(a2m)).toBe('sources-missing');
  });

  it('passes on any one of the three, not just the first', () => {
    for (const slot of MUSIC_SLOTS) {
      expect(refusalOf({ ...a2m, filledSlots: [slot] }), slot).toBeNull();
    }
  });

  it('passes with several filled', () => {
    expect(refusalOf({ ...a2m, filledSlots: MUSIC_SLOTS })).toBeNull();
  });

  it('ignores a pick that is not one of this mode\'s slots', () => {
    // A voice sample picked on the cloning mode stays on the node when the
    // user switches to music. It is not one of the three this mode collects,
    // so it must not stand in for one.
    expect(refusalOf({ ...a2m, filledSlots: ['refAudio'] })).toBe(
      'sources-missing',
    );
  });

  it('says "any one of these" rather than naming the voice sample', () => {
    expect(isExecuteButtonDisabled('sources-missing')).toBe(false);
    expect(refusalToastKey('sources-missing')).toBe(
      'canvas.generatePanel.refuseExecuteNoReference',
    );
  });
});

/**
 * Lyrics on text to music (#1960 A12).
 *
 * The upstream refuses a request without them — measured on 2026-09-05, the
 * gateway answers `invalid params, lyrics is required` — so the user would
 * otherwise watch a generation start, spin, and fail. The vendor page's "leave
 * empty for auto-generated lyrics" is not what the gateway does.
 *
 * Both music modes demand them (measured 2026-09-05), and no other mode shows
 * the box at all, so this is asked of the mode rather than of the panel.
 */
describe('evaluateExecute — the lyrics box', () => {
  /** Text to music with a style written and the lyrics box still empty. */
  const t2m = { ...ok, lyricsRequired: true, lyricsText: '' };

  it('names the lyrics when the box is empty', () => {
    expect(refusalOf(t2m)).toBe('lyrics-missing');
  });

  it('treats whitespace as empty, the way it treats the prompt', () => {
    expect(refusalOf({ ...t2m, lyricsText: '  \n\t ' })).toBe('lyrics-missing');
  });

  it('passes once something is written', () => {
    expect(refusalOf({ ...t2m, lyricsText: '[Verse]\nmorning light' })).toBeNull();
  });

  // 有歌词框时，上面那个框在屏幕上叫「风格」，不叫「提示词」——面板上没有任何
  // 东西叫后者，而被命名的那个框正是用户已经填好的。所以这一档空掉上面那个框，
  // 拒绝语要指得到它。
  it('names the style box, which is what the screen calls it here', () => {
    expect(refusalOf({ ...t2m, promptText: '', lyricsText: 'la' })).toBe(
      'style-missing',
    );
    expect(refusalToastKey('style-missing')).toBe(
      'canvas.generatePanel.refuseExecuteNoStyle',
    );
  });

  it('still names the prompt on the modes that show one box', () => {
    expect(refusalOf({ ...ok, promptText: '' })).toBe('prompt-missing');
  });

  // Judged on the text the vendor will actually receive, the same rule the
  // prompt's own length check follows: the worker cleans every AIGC prompt
  // through `extractPromptText` before the request goes out, and everything
  // that function does shortens. A box holding only characters it strips is a
  // box the vendor reads as empty, and `2013 - invalid params` is what the
  // user would watch the generation fail with.
  it('sees through characters the vendor never receives', () => {
    // A zero-width space survives `.trim()` and is stripped on the way out.
    expect(refusalOf({ ...t2m, lyricsText: '\u200B' })).toBe(
      'lyrics-missing',
    );
    expect(refusalOf({ ...t2m, lyricsText: '<!-- a note -->' })).toBe(
      'lyrics-missing',
    );
  });

  it('says nothing about lyrics on a mode that does not ask for them', () => {
    expect(refusalOf({ ...ok, lyricsRequired: false, lyricsText: '' })).toBeNull();
  });

  it('reports the style box first, the panel order', () => {
    // The style box sits above the lyrics box, so an empty one is what the
    // user is told about first.
    expect(refusalOf({ ...t2m, promptText: '' })).toBe('style-missing');
  });

  it('leaves the button live and speaks on click', () => {
    expect(isExecuteButtonDisabled('lyrics-missing')).toBe(false);
    expect(refusalToastKey('lyrics-missing')).toBe(
      'canvas.generatePanel.lyricsMissing',
    );
  });

  // Measured against the gateway on 2026-09-05: `is_instrumental: true` with
  // an empty `lyrics` is accepted and completes. Demanding words to sing for a
  // track the user marked vocal-free is our own rule, not the vendor's.
  it('asks for no lyrics once the track is marked instrumental', () => {
    expect(refusalOf({ ...t2m, instrumental: true })).toBeNull();
  });

  it('asks for them again the moment that switch goes back off', () => {
    expect(refusalOf({ ...t2m, instrumental: false })).toBe('lyrics-missing');
  });

  it('says nothing about the switch on a mode that collects no lyrics', () => {
    // Text to speech declares no lyrics box, so the switch it never shows
    // must not turn into a condition here.
    expect(
      refusalOf({ ...ok, lyricsRequired: false, instrumental: true }),
    ).toBeNull();
  });
});

describe('evaluateExecute — a mode that takes every place it offers', () => {
  // The video panel's own rule until #269: first-and-last-frame needs both
  // frames, and reference-to-video needs a reference mentioned in the prompt.
  // The catalog says which it is; absent reads as all of them.
  const frames = {
    ...ok,
    requiredSlots: ['image', 'endImage'] as readonly string[],
    filledSlots: [] as readonly string[],
  };

  it('names the first empty place, in the order the panel offers them', () => {
    expect(evaluateExecute(frames)).toMatchObject({
      refusal: 'sources-missing',
      slot: 'image',
    });
    expect(evaluateExecute({ ...frames, filledSlots: ['image'] })).toMatchObject({
      slot: 'endImage',
    });
  });

  it('refuses one filled place, where a mode taking any one would pass', () => {
    const filled = { ...frames, filledSlots: ['image'] as readonly string[] };
    expect(refusalOf(filled)).toBe('sources-missing');
    expect(refusalOf({ ...filled, sourceRule: 'any_of' })).toBeNull();
  });

  it('passes once every one of them holds something', () => {
    expect(refusalOf({ ...frames, filledSlots: ['image', 'endImage'] })).toBeNull();
  });

  it('names the one place a single-place mode takes', () => {
    const one = { ...ok, requiredSlots: ['image'], filledSlots: [] };
    expect(evaluateExecute(one)).toMatchObject({ refusal: 'source-missing', slot: 'image' });
  });
});

describe('evaluateExecute — more references than the model takes', () => {
  const pooled = { ...ok, poolCount: 8, poolCap: 7 };

  it('names the limit, which is the only way to find it without guessing', () => {
    expect(evaluateExecute(pooled)).toEqual({
      refusal: 'too-many-references',
      over: { limit: 7 },
    });
  });

  it('passes at the cap and where the model states none', () => {
    expect(refusalOf({ ...pooled, poolCount: 7 })).toBeNull();
    expect(refusalOf({ ...pooled, poolCap: undefined })).toBeNull();
  });

  it('asks for the missing material first, the panel order', () => {
    // Over the cap and an empty slot cannot both be acted on at once, and the
    // empty one is what the mode cannot run without.
    expect(refusalOf({ ...pooled, requiredSlots: ['image'], filledSlots: [] })).toBe(
      'source-missing',
    );
  });
});
