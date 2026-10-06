// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The audio Generate panel's canvas integration: everything the presentational
 * panel needs, read off live Yjs and the model catalog.
 *
 * Its own container rather than a branch in the video one, for the same reason
 * that one is not a branch of the image one: what a panel READS differs. This
 * one reads a live voice list off an endpoint and resolves the voice param
 * under whichever name the active vendor gave it. What the three do share —
 * the task envelope, the execute gate, the prompt editor, the reference rail —
 * they share by calling the same code.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import type { Voice } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { voicesApi } from '@web/data/api/voices';
import { firstVoiceKey, firstVoiceQuery } from '@web/spaces/canvas/generate/first-voice-query';
import {
  getLyricsFragment,
  getPromptFragment,
  isNodeLocked,
  readCanvasGraph,
  setNodeMode,
  setNodeModel,
  setNodeParams,
} from '@web/data/yjs/canvas-space';
import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useTextBodies } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import {
  audioMissing,
  audioSlotsForModel,
  modelTakesLyrics,
  AUDIO_SLOTS,
} from '@web/spaces/canvas/generate/audio-slots';
import { slotForPurpose, slotRefusalKey } from '@web/spaces/canvas/generate/slots';
import { useEndPickWhenSlotGone } from '@web/spaces/canvas/generate/use-end-pick-when-slot-gone';
import { NO_REFERENCE_KINDS } from '@web/spaces/canvas/generate/reference-urls';
import type { AudioSlot } from '@web/spaces/canvas/generate/audio-slots';
import {
  AUDIO_MODE_OPTIONS,
  audioModeOption,
} from '@web/spaces/canvas/generate/audio-mode-options';
import {
  buildAudioPanelViewModel,
  withListDefaultVoice,
} from '@web/spaces/canvas/generate/audio-panel-view-model';
import { useCreditText } from '@web/spaces/canvas/generate/use-credit-estimate';
import { audioEstimateInput, buildAudioTaskPayload } from '@web/spaces/canvas/generate/audio-task-payload';
import { AudioGeneratePanel } from '@web/spaces/canvas/generate/AudioGeneratePanel';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import {
  evaluateExecute,
  extractPromptText,
} from '@breatic/shared';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { resolveModelSwitch, resolveParamsEdit } from '@web/spaces/canvas/generate/model-params';
import {
  filterAvailableModes,
  filterModelsByMode,
  resolveAvailableMode,
  resolveModeSwitch,
} from '@web/spaces/canvas/generate/mode-selection';
import { modelsForModality } from '@web/spaces/canvas/generate/modality-buckets';
import { PromptEditor } from '@web/spaces/canvas/generate/PromptEditor';
import { removeReferenceRow } from '@web/spaces/canvas/generate/remove-reference-row';
import { clearSlot } from '@web/spaces/canvas/generate/slot-write';
import { useContentStable } from '@web/spaces/canvas/generate/use-content-stable';
import { useGenerateSubmitState } from '@web/spaces/canvas/generate/use-generate-submit-state';
import { useVoiceList } from '@web/spaces/canvas/generate/use-voice-list';
import { voiceParamName } from '@web/spaces/canvas/generate/voice-param';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import { asContentView } from '@web/data/yjs/node-view';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';

/** Empty text map, for the pass that only needs to know WHICH rows exist. */
const EMPTY_TEXT: ReadonlyMap<string, string> = new Map();


interface AudioGeneratePanelContainerProps {
  /** Live canvas node views (target + reference sources). */
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>;
  /** Live canvas edges (incoming = references). */
  edges: ReadonlyArray<CanvasEdge>;
  /** Project the canvas space belongs to. */
  projectId: string;
  /** Canvas space id. */
  spaceId: string;
  /** Reads who made the newest document write, for the message a mode switch shows. */
  getLastWriteWasLocal: () => boolean;
}

/**
 * The panel body, mounted once a catalog is in hand.
 * @param root0 - Container props plus the node the panel is open on.
 * @param root0.nodeId - The node the panel is open on.
 * @param root0.nodes - Live canvas node views.
 * @param root0.edges - Live canvas edges.
 * @param root0.projectId - Project the canvas space belongs to.
 * @param root0.spaceId - Canvas space id.
 * @param root0.getLastWriteWasLocal - Reads who made the newest document write.
 * @returns The wired audio panel.
 */
function AudioGeneratePanelBody({
  nodeId,
  nodes,
  edges,
  projectId,
  spaceId,
  getLastWriteWasLocal,
}: AudioGeneratePanelContainerProps & { nodeId: string }): React.JSX.Element {
  const t = useTranslation();
  const closeActivePanel = useCanvasSession((s) => s.closeActivePanel);
  const endPick = useCanvasSession((s) => s.endPick);
  const startReferencePick = useCanvasSession((s) => s.startReferencePick);
  const startRefAudioPick = useCanvasSession((s) => s.startRefAudioPick);
  const startMusicSongPick = useCanvasSession((s) => s.startMusicSongPick);
  const startCoverSongPick = useCanvasSession((s) => s.startCoverSongPick);
  const startMusicMelodyPick = useCanvasSession((s) => s.startMusicMelodyPick);
  const startMusicVocalPick = useCanvasSession((s) => s.startMusicVocalPick);
  const startSoundVideoPick = useCanvasSession((s) => s.startSoundVideoPick);
  const startMoodImagePick = useCanvasSession((s) => s.startMoodImagePick);
  /** Which store action starts each slot's pick. */
  const startPick = React.useMemo(
    (): Record<AudioSlot, (id: string) => void> => ({
      refAudio: startRefAudioPick,
      soundVideo: startSoundVideoPick,
      moodImage: startMoodImagePick,
      musicSong: startMusicSongPick,
      coverSong: startCoverSongPick,
      musicMelody: startMusicMelodyPick,
      musicVocal: startMusicVocalPick,
    }),
    [
      startRefAudioPick,
      startSoundVideoPick,
      startMoodImagePick,
      startMusicSongPick,
      startCoverSongPick,
      startMusicMelodyPick,
      startMusicVocalPick,
    ],
  );
  const referencePicking = useCanvasSession(
    (s) => s.pickSession?.nodeId === nodeId && s.pickSession.purpose === 'reference',
  );
  const { caretProvider } = useCanvasContext();

  const queryClient = useQueryClient();
  const { data: catalog } = useQuery(modelCatalogQuery());
  const models = React.useMemo(() => modelsForModality(catalog, 'audio'), [catalog]);
  const availableModes = React.useMemo(
    () => filterAvailableModes(AUDIO_MODE_OPTIONS, models),
    [models],
  );
  // The node's own mode, kept only while this deployment still offers it: a
  // mode whose models all went away falls back rather than opening a panel
  // with nothing to run, and putting the models back reads as that mode again.
  const storedMode = React.useMemo(
    () => asContentView(nodes.find((n) => n.id === nodeId)?.data)?.mode,
    [nodes, nodeId],
  );
  const mode = resolveAvailableMode(storedMode, availableModes) ?? '';
  // What the picker offers has to be what this mode can run. The union of both
  // buckets is the right input for the availability gate above and for the view
  // model's own narrowing; handing it to the picker lists sound-effect, music
  // and vocal-remover models under text to speech, where selecting one writes a
  // model the next render resolves straight back.
  const modeModels = React.useMemo(
    () => filterModelsByMode(models, mode),
    [models, mode],
  );

  const {
    lyricsText,
    lyricsTextRef,
    onLyricsChange,
    lyricsEditorRef,
    promptText,
    promptTextRef,
    onPromptChange,
    promptEditorRef,
    isSubmitting,
    setIsSubmitting,
    submittingRef,
  } = useGenerateSubmitState();

  // Read during render: `getPromptFragment` is a synchronous document read with
  // no side effect, and null means the node has no seeded prompt for this mode — the panel
  // then says so instead of offering an editor that stores nothing. Resolving
  // it after the first commit would make that sentence the first thing every
  // modern node's panel renders.
  // Each mode keeps its own prompt (#2218), so a mode switch binds the editor
  // to that mode's words.
  const fragment = React.useMemo(
    () => getPromptFragment(projectId, spaceId, nodeId, mode),
    [projectId, spaceId, nodeId, mode],
  );

  // The ids come off `deriveReferences` itself, so the followed set and the
  // rendered rows cannot drift. Following every text node on the board instead
  // would rebuild this on every keystroke anyone types anywhere.
  const textNodeIds = React.useMemo(
    () => [
      ...new Set(
        deriveReferences(nodeId, nodes, edges, EMPTY_TEXT)
          .filter((row) => row.sourceNodeType === 'text')
          .map((row) => row.sourceNodeId),
      ),
    ],
    [nodeId, nodes, edges],
  );
  const textById = useTextBodies(projectId, spaceId, textNodeIds);
  const derivedReferences = React.useMemo(
    () => deriveReferences(nodeId, nodes, edges, textById),
    [nodeId, nodes, edges, textById],
  );

  const nodeVm = React.useMemo(
    () => buildAudioPanelViewModel({ nodeId, nodes, models, mode }),
    [nodeId, nodes, models, mode],
  );
  // With no voice held, the first voice of the model's list is the voice
  // (user 2026-09-29). Asked for only while it would be used.
  const { data: firstVoice } = useQuery({
    ...firstVoiceQuery(queryClient, nodeVm.model),
    enabled: nodeVm.model !== '' && nodeVm.voiceRequired && !nodeVm.voiceChosen,
  });
  const vm = React.useMemo(
    () => withListDefaultVoice(nodeVm, firstVoice),
    [nodeVm, firstVoice],
  );

  // Read during render for the same reason the prompt fragment is: a
  // synchronous document read, seeded with the node, never created here.
  const lyricsFragment = React.useMemo(
    () => getLyricsFragment(projectId, spaceId, nodeId, mode),
    [projectId, spaceId, nodeId, mode],
  );
  // What this mode's boxes are called, which is this panel's to word.
  const modeOption = audioModeOption(mode);
  // Both off the model: which places it collects material in, and whether it
  // keeps the words to sing in a box of its own. A mode two models serve
  // differently is drawn differently for each.
  const slots = React.useMemo(
    () => audioSlotsForModel(vm.modelEntry, mode),
    [vm.modelEntry, mode],
  );
  /** Whether this run shows a lyrics box, and so insists on what goes in it. */
  const lyrics = modelTakesLyrics(vm.modelEntry, mode);
  /** The slot whose pick is running on this node, if any. */
  const activeSlot = useCanvasSession((s) => {
    const session = s.pickSession;
    if (session?.nodeId !== nodeId) return undefined;
    const name = slotForPurpose(session.purpose);
    return name !== undefined && name in AUDIO_SLOTS
      ? (name as AudioSlot)
      : undefined;
  });
  const sessionStore = useCanvasSessionStore();
  const onPickSlot = React.useCallback(
    (slot: AudioSlot) => {
      const session = sessionStore.getState().pickSession;
      const purpose = AUDIO_SLOTS[slot].purpose;
      // Clicking the slot whose pick is already running ends it; clicking
      // another one moves the pick to that slot.
      if (session?.nodeId === nodeId && session.purpose === purpose) {
        endPick();
        return;
      }
      startPick[slot](nodeId);
    },
    [sessionStore, startPick, endPick, nodeId],
  );
  // A slot's ✕: clears the node's pick-time copy, and deliberately leaves a
  // running pick running — the ✕ renders whenever the slot holds something,
  // pick or no pick, so that a stale copy is always removable
  // (`generate-tools.tsx`). Clearing mid-pick lands on empty with the canvas
  // still offering candidates, which is the state the user asked for.
  const onClearSlot = React.useCallback(
    (slot: AudioSlot) => clearSlot(projectId, spaceId, nodeId, AUDIO_SLOTS[slot]),
    [projectId, spaceId, nodeId],
  );
  useEndPickWhenSlotGone(nodeId, slots, getLastWriteWasLocal);

  // Both rebuild with the view model, which rebuilds on every canvas mutation
  // — every frame of any node drag — and both flow into React.memo components
  // (the panel, and the rail and params picker under it).
  const references = useContentStable(derivedReferences);
  const params = useContentStable(vm.params);
  // The picked slot URLs and what to paint for them are two more fresh objects
  // per view-model build. One unstable prop is enough to make the panel's memo
  // — and every memoised child under it — re-render on every frame of a drag.
  const stableSlotUrls = useContentStable(vm.slotUrls);
  const stableSlotThumbnails = useContentStable(vm.slotThumbnails);

  // Every write re-derives from live Yjs at click time: the render closure goes
  // stale the moment a collaborator edits the node, and writing off it would
  // clobber their edit.
  const freshContent = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
  }, [projectId, spaceId, nodeId]);
  const freshVm = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    const built = buildAudioPanelViewModel({ nodeId, nodes: graph.nodes, models, mode });
    // The same default the render applied, read off the cache at click time.
    return withListDefaultVoice(
      built,
      queryClient.getQueryData<Voice | null>(firstVoiceKey(built.model)),
    );
  }, [projectId, spaceId, nodeId, models, mode, queryClient]);

  const voices = useVoiceList(vm.model);
  // The stored voice is an id; the trigger shows a name. One fetch per stored
  // id, cached by react-query — the list itself may not have been opened, and
  // when it has, the id may be on a page nobody scrolled to.
  const { data: selectedVoice } = useQuery({
    queryKey: ['voice', vm.model, vm.voiceSelectedId],
    queryFn: () => voicesApi.get(vm.model, vm.voiceSelectedId ?? ''),
    enabled: vm.model !== '' && vm.voiceSelectedId !== null,
  });

  const onToggleMode = React.useCallback(
    (next: string) => {
      // Read the node fresh — a collaborator may have changed its per-mode
      // model memory or its params since this render — and write the switch in
      // one transaction.
      const { model, paramsByModel } = resolveModeSwitch(freshContent(), next, models);
      // An empty model would clobber the node's stored model AND every model's
      // records. Unreachable while the picker offers only modes that resolve
      // one; kept as defence against a layer above breaking.
      if (!model) return;
      setNodeMode(projectId, spaceId, nodeId, next, model, paramsByModel);
    },
    [models, projectId, spaceId, nodeId, freshContent],
  );

  const onSelectModel = React.useCallback(
    (modelId: string) => {
      const picked = models.find((m) => m.name === modelId);
      if (!picked) {
        // The catalog refetched and dropped this model between render and
        // click — say so rather than silently ignore the selection.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const { paramsByModel } = resolveModelSwitch(freshContent(), picked);
      setNodeModel(projectId, spaceId, nodeId, mode, modelId, paramsByModel);
    },
    [models, projectId, spaceId, nodeId, mode, freshContent, t],
  );

  const onChangeParams = React.useCallback(
    (partial: object) => {
      // Keyed on the RESOLVED model — the one whose controls were just used.
      // The node's stored model can be absent or no longer offered, and keying
      // the record on that would write the edit where the panel never reads it.
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        partial,
        freshVm().model,
      );
      setNodeParams(projectId, spaceId, nodeId, paramsByModel);
    },
    [projectId, spaceId, nodeId, freshVm, freshContent],
  );

  const onVoicePick = React.useCallback(
    (voice: Voice) => {
      const fresh = freshVm();
      // The list belongs to the model the panel rendered with. A collaborator
      // switching the model between that render and this click leaves an id
      // from the outgoing vendor's domain in hand, and the incoming model's
      // record is no place for it.
      if (fresh.model !== vm.model) {
        toast.warning(t('canvas.generatePanel.voiceModelChanged'));
        return;
      }
      const name = voiceParamName(fresh.modelEntry);
      // A model with no voice param has no picker open, so this is unreachable
      // from the UI; writing under a made-up key would put a value where the
      // submit reads none.
      if (!name) return;
      // The row carries the name the trigger shows. Seeding it here is what
      // keeps that trigger off a round trip whose only job is to fetch back
      // what the user just clicked.
      queryClient.setQueryData(['voice', fresh.model, voice.id], voice);
      const paramsByModel = resolveParamsEdit(
        freshContent(),
        { [name]: voice.id },
        fresh.model,
      );
      setNodeParams(projectId, spaceId, nodeId, paramsByModel);
      // Closing the voice list is the settings pill's own doing (it closes on
      // pick), so this callback has no reason to reach for the list handle.
    },
    [projectId, spaceId, nodeId, freshVm, freshContent, vm.model, queryClient, t],
  );

  const onAddReference = React.useCallback(() => {
    const session = sessionStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'reference') {
      endPick();
    } else {
      startReferencePick(nodeId);
    }
  }, [sessionStore, startReferencePick, endPick, nodeId]);

  const onRemoveReference = React.useCallback(
    (item: ReferenceRailItem) => {
      removeReferenceRow({ item, projectId, spaceId, nodeId });
    },
    [projectId, spaceId, nodeId],
  );
  // Which box the caret was last in. Clicking a rail row keeps the caret where
  // it is (`ReferenceRail` preventDefaults the mousedown, which is what lets
  // the chip land at the caret rather than at the end), but plenty of other
  // things take focus first: tabbing to the row, the model picker, the params
  // popover. In every one of those neither editor is focused, so which box to
  // insert into has to be remembered rather than read at click time.
  const lastFocusedBox = React.useRef<'prompt' | 'lyrics'>('prompt');
  const onPromptFocus = React.useCallback(() => {
    lastFocusedBox.current = 'prompt';
  }, []);
  const onLyricsFocus = React.useCallback(() => {
    lastFocusedBox.current = 'lyrics';
  }, []);
  const onInsertReference = React.useCallback(
    (item: ReferenceRailItem) => {
      const target =
        lastFocusedBox.current === 'lyrics' && lyricsEditorRef.current
          ? lyricsEditorRef.current
          : promptEditorRef.current;
      target?.insertReference(item);
    },
    [promptEditorRef, lyricsEditorRef],
  );

  const onExecute = React.useCallback(async () => {
    // Every execute-critical value is read synchronously here, never from a
    // render closure that batching and live collaboration make stale.
    if (submittingRef.current) return;
    const gateBlock = evaluateNodeGate({
      locked: isNodeLocked(projectId, spaceId, nodeId),
    });
    if (gateBlock) {
      warnNodeGate(t(gateBlock.toastKey));
      return;
    }
    const fresh = freshVm();
    // Serialize at click time: a text chip substitutes its source node's
    // CURRENT words, and that node may have been edited since the last
    // keystroke here.
    const freshPrompt = fresh.promptRequired
      ? (promptEditorRef.current?.serializePrompt() ?? promptTextRef.current)
      : '';
    const freshLyrics = lyrics
      ? (lyricsEditorRef.current?.serializePrompt() ?? lyricsTextRef.current)
      : undefined;
    const maxInputChars = fresh.modelEntry?.max_input_chars;
    const verdict = evaluateExecute({
      promptText: freshPrompt,
      model: fresh.model,
      nodeStatus: fresh.nodeStatus,
      // The synchronous latch above already answered this, and earlier than a
      // state flag can.
      isSubmitting: false,
      promptRequired: fresh.promptRequired,
      maxInputChars,
      voiceRequired: fresh.voiceRequired,
      voiceChosen: fresh.voiceChosen,
      speakersShort: fresh.speakersShort,
      missing: audioMissing(fresh.modelEntry, mode, fresh.slotUrls),
      lyricsRequired: lyrics,
      lyricsText: freshLyrics,
    });
    if (verdict != null) {
      const key = slotRefusalKey(
        AUDIO_SLOTS,
        audioSlotsForModel(fresh.modelEntry, mode),
        verdict,
      );
      // `max` comes from the same value the gate judged by, so the sentence
      // can never name a limit other than the one that refused.
      if (key) toast.warning(t(key, { max: maxInputChars ?? 0 }));
      return;
    }
    // Unreachable past the gate above — `no-model` covers it — and stated so
    // the payload builder gets an entry rather than undefined.
    if (!fresh.modelEntry) return;

    submittingRef.current = true;
    // Which opening of the panel this submit came from: the answer may land
    // after the reader closed or replaced this panel, and then it closes
    // nothing they opened since.
    const session = sessionStore.getState().panelSession;
    setIsSubmitting(true);
    try {
      const payload = buildAudioTaskPayload({
        nodeId,
        projectId,
        spaceId,
        model: fresh.modelEntry,
        params: fresh.params,
        // The same mode the view model above was built for.
        generation: { mode, declared: fresh.modelEntry.params },
        promptText: freshPrompt,
        // Read off the same fresh view model the gate judged, so the payload
        // can only ever carry the pick that passed it.
        slotUrls: fresh.slotUrls,
        // The mode's own slots, so a pick made for the other mode cannot ride
        // this submit: a pick survives a mode switch by design.
        slots,
        // Only on a mode that collects them; absent leaves the field out of
        // the request rather than sending it empty.
        ...(freshLyrics !== undefined ? { lyricsText: freshLyrics } : {}),
      });
      await canvasApi.createTask(payload);
      sessionStore.getState().closePanelOfSession(session);
    } catch (err) {
      // Unconditional: a submit that failed after the user closed the panel
      // still explains itself.
      toast.error(
        executeErrorMessage(err instanceof ApiException ? err.status : undefined, t),
      );
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [sessionStore,
    nodeId,
    projectId,
    spaceId,
    freshVm,
    t,
    lyrics,
    mode,
    slots,
    // Stable for this mount's lifetime; listed because they come from a hook,
    // where the linter cannot see that for itself.
    lyricsEditorRef,
    lyricsTextRef,
    promptEditorRef,
    promptTextRef,
    setIsSubmitting,
    submittingRef,
  ]);

  // Depended on BY VALUE, not via `t`: `t` is a stable module-level function
  // whose identity never changes on an in-session locale switch, so depending
  // on it alone would freeze this copy in the old language.
  // What the box asks for rides on the mode (`audio-mode-options`): the two
  // speech modes ask for lines to speak, sound effects for a description of a
  // sound. The fallback is where the types land rather than a state to expect:
  // `mode` is only empty when no mode is available, and `CatalogGatedFrame`
  // holds the panel shut in that case (`generate-panel-frame.tsx`).
  const promptPlaceholder = t(modeOption.placeholderKey);
  const promptLabel =
    modeOption.promptLabelKey === undefined ? undefined : t(modeOption.promptLabelKey);
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
  const promptSlot = React.useMemo(
    () =>
      fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          // Half height on a music mode: a style brief is a line or two, and
          // the box grows with whatever is typed into it either way.
          startingHeight={lyrics ? 'half' : 'full'}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={onPromptChange}
          // An audio node collects only text rows, and a text chip serializes
          // into the prompt itself — no id ever becomes a model input here.
          onAtMentionsChange={noop}
          onFocus={onPromptFocus}
          references={references}
          // A media `@` chip is a model input on the other two panels; here
          // no audio model declares a pool for one to travel in.
          referenceKinds={NO_REFERENCE_KINDS}
          mentionEmptyLabel={mentionEmptyLabel}
          caretProvider={caretProvider}
        />
      ) : null,
    [
      fragment,
      promptPlaceholder,
      onPromptChange,
      onPromptFocus,
      references,
      mentionEmptyLabel,
      caretProvider,
      lyrics,
      promptEditorRef,
    ],
  );

  const lyricsPlaceholder = t('canvas.generatePanel.musicLyricsPlaceholder');
  const lyricsSlot = React.useMemo(
    () =>
      lyrics && lyricsFragment ? (
        <PromptEditor
          ref={lyricsEditorRef}
          testId='generate-lyrics-editor'
          // One newline per line the user made. The prompt default puts a
          // blank line between blocks, which reads as prose; here the line
          // structure is the content and the vendor is handed it as typed.
          blockSeparator={'\n'}
          fragment={lyricsFragment}
          placeholder={lyricsPlaceholder}
          onTextChange={onLyricsChange}
          // The `@` chip carries no id to the vendor here; it substitutes the
          // source node's words into the lyrics string, the way it does in the
          // box above.
          onAtMentionsChange={noop}
          onFocus={onLyricsFocus}
          // The same pool the style box reads: a song's words are often
          // already written in a text node on the canvas, and `@` is how they
          // get in (user 2026-09-06).
          references={references}
          referenceKinds={NO_REFERENCE_KINDS}
          mentionEmptyLabel={mentionEmptyLabel}
          caretProvider={caretProvider}
        />
      ) : null,
    [
      lyrics,
      lyricsFragment,
      lyricsPlaceholder,
      onLyricsChange,
      onLyricsFocus,
      references,
      mentionEmptyLabel,
      caretProvider,
      lyricsEditorRef,
    ],
  );

  const creditText = useCreditText(
    vm.modelEntry,
    audioEstimateInput({ ...vm, params }, slots, extractPromptText(promptText)),
    catalog?.credit_multiplier ?? 1,
  );

  return (
    <AudioGeneratePanel
      models={modeModels}
      model={vm.model}
      currentModel={vm.modelEntry}
      creditText={creditText}
      modelTakesPrompt={vm.promptRequired}
      mode={mode}
      modeOptions={availableModes}
      voiceList={voices.state}
      voiceSelectedId={vm.voiceSelectedId}
      voiceSelectedName={selectedVoice?.name ?? null}
      references={references}
      referencePicking={referencePicking}
      slots={slots}
      slotUrls={stableSlotUrls}
      slotThumbnails={stableSlotThumbnails}
      activeSlot={activeSlot}
      onPickSlot={onPickSlot}
      onClearSlot={onClearSlot}
      params={params}
      executeRefusal={evaluateExecute({
        promptText,
        model: vm.model,
        nodeStatus: vm.nodeStatus,
        isSubmitting,
        promptRequired: vm.promptRequired,
        maxInputChars: vm.modelEntry?.max_input_chars,
        voiceRequired: vm.voiceRequired,
        voiceChosen: vm.voiceChosen,
        speakersShort: vm.speakersShort,
        missing: audioMissing(vm.modelEntry, mode, vm.slotUrls),
        lyricsRequired: lyrics,
        lyricsText,
      })?.refusal ?? null}
      promptSlot={promptSlot}
      lyricsSlot={lyricsSlot}
      promptLabel={promptLabel}
      onToggleMode={onToggleMode}
      onSelectModel={onSelectModel}
      onVoiceOpenChange={voices.onOpenChange}
      onVoiceQueryChange={voices.onQueryChange}
      onVoicePick={onVoicePick}
      onVoiceLoadMore={voices.onLoadMore}
      onAddReference={onAddReference}
      onRemoveReference={onRemoveReference}
      onInsertReference={onInsertReference}
      onChangeParams={onChangeParams}
      onExit={closeActivePanel}
      onExecute={onExecute}
    />
  );
}

/**
 * Does nothing, stably.
 */
function noop(): void {
  // Intentionally empty.
}

/**
 * The audio Generate panel's canvas integration point. Rendered once inside the
 * ReactFlow subtree; shows nothing until an audio node's Generate panel is
 * opened, then floats {@link AudioGeneratePanel} below that node.
 * @param props - Live nodes and edges, and the project / space ids.
 * @returns The floating panel, or null when none is open.
 */
export function AudioGeneratePanelContainer(
  props: AudioGeneratePanelContainerProps,
): React.JSX.Element | null {
  const nodeId = useOpenPanelNode('generateAudio', props.nodes);
  if (nodeId == null) return null;
  return (
    <CatalogGatedFrame nodeId={nodeId} modality='audio'>
      {/* key={nodeId} makes switching the panel to another node a full REMOUNT,
          so a prompt typed for node A can never be submitted to node B. */}
      <AudioGeneratePanelBody {...props} nodeId={nodeId} key={nodeId} />
    </CatalogGatedFrame>
  );
}
