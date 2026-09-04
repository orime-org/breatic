// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the audio panel renders from, derived off the live canvas graph.
 *
 * Everything the panel shows about the node — which model, which params, which
 * voice, whether it may submit — is read here, in one pass, so the panel and
 * the submit cannot answer the same question differently.
 *
 * The voice is the one thing this panel has that the others do not, and it is
 * asked in two parts: whether the active model TAKES one (a param the catalog
 * marked `remote_source: voices`), and whether the node's record HOLDS one.
 * The second reads the record rather than the resolved value on purpose —
 * resolving falls back to the yaml default, and neither vendor's default is a
 * value every deployment accepts, so a resolved read would call a voice chosen
 * that the user never saw.
 */

import type { ModelEntry } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import type { AudioSlotUrls } from '@web/spaces/canvas/generate/audio-slots';
import {
  filterModelsByMode,
  pickModelForMode,
} from '@web/spaces/canvas/generate/mode-selection';
import {
  readSlotThumbnails,
  readSlotUrls,
} from '@web/spaces/canvas/generate/slots';
import { resolveModelSwitch } from '@web/spaces/canvas/generate/model-params';
import {
  isVoiceChosen,
  voiceParamName,
} from '@web/spaces/canvas/generate/voice-param';
import { asContentView } from '@web/spaces/canvas/types/node-view';

/** Everything the audio panel and its submit read off the node. */
export interface AudioPanelViewModel {
  /** Effective model id (stored, else the first offered). Empty when the mode offers none. */
  model: string;
  /**
   * The model entry itself. The submit needs it whole — the task type comes
   * off its modality — and the panel reads its rate from it.
   */
  modelEntry: ModelEntry | undefined;
  /** Effective params, resolved against the current model's own record. */
  params: Record<string, unknown>;
  /** The target node's display status — gates execute (no submit while handling). */
  nodeStatus: string | undefined;
  /** Whether the active model consumes the prompt. */
  promptRequired: boolean;
  /** Whether the active model takes a voice at all. */
  voiceRequired: boolean;
  /** Whether the node's record for this model holds one. */
  voiceChosen: boolean;
  /** The held voice id, or null when none is held (or none is taken). */
  voiceSelectedId: string | null;
  /**
   * Whether this mode needs an audio source — the reference recording voice
   * cloning speaks in (#1960 PR2).
   *
   * Read off the catalog's own `sourcesByMode` rather than a table here: the
   * server computes the same field from the same config and refuses a task
   * that arrives without the source (`violatesSourceRequirement`), so the slot
   * the toolbar shows and the condition the backend enforces come from one
   * rule. A second table would be a second answer.
   *
   * Kept apart from {@link AudioPanelViewModel.voiceRequired}, which asks a
   * different question — whether the model picks a voice from a preset
   * catalog. A cloning model answers no to that and yes to this.
   */
  refAudioRequired: boolean;
  /** What is picked, by slot; a slot missing from here renders empty. */
  slotUrls: AudioSlotUrls;
  /**
   * What to PAINT for each pick. A slot missing from here is not empty — it
   * covers itself with the asset node's icon instead (#1946). Fullness is
   * {@link AudioPanelViewModel.slotUrls}, never this.
   */
  slotThumbnails: AudioSlotUrls;
}

/**
 * Derives what the audio panel renders from.
 * @param input - The node, the graph, the offered models and the active mode.
 * @param input.nodeId - The node the panel is open on.
 * @param input.nodes - Live canvas node views.
 * @param input.models - The models this panel offers.
 * @param input.mode - The active generation mode.
 * @returns The derived view model.
 */
export function buildAudioPanelViewModel(input: {
  nodeId: string;
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  models: ModelEntry[];
  mode: string;
}): AudioPanelViewModel {
  const { nodeId, nodes, mode } = input;
  const content = asContentView(nodes.find((n) => n.id === nodeId)?.data);

  const models = filterModelsByMode(input.models, mode);
  const model = pickModelForMode(
    content?.model,
    mode,
    content?.modelByMode,
    models,
  );
  const current = models.find((m) => m.name === model);

  // Resolved from the model's OWN record, which is also what keeps one model's
  // voice from ever reaching another: the records share no path, so switching
  // models reads that model's own (or nothing), never the outgoing one's.
  const params = current ? resolveModelSwitch(content, current).params : {};

  const voiceParam = voiceParamName(current);
  const storedRecord = content?.paramsByModel?.[model];
  const voiceChosen =
    voiceParam !== null && isVoiceChosen(storedRecord, voiceParam);

  return {
    model,
    modelEntry: current,
    params,
    nodeStatus: content?.status,
    promptRequired: current?.takes_prompt ?? true,
    voiceRequired: voiceParam !== null,
    voiceChosen,
    voiceSelectedId: voiceChosen
      ? (storedRecord?.[voiceParam as string] as string)
      : null,
    refAudioRequired: current?.sourcesByMode[mode]?.includes('audio') ?? false,
    slotUrls: readSlotUrls(AUDIO_SLOTS, content),
    slotThumbnails: readSlotThumbnails(AUDIO_SLOTS, content),
  };
}
