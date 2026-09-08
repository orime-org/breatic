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
import { AUDIO_SLOTS } from '@web/spaces/canvas/generate/audio-slots';
import { slotForPurpose } from '@web/spaces/canvas/generate/slots';
import type { AudioSlot } from '@web/spaces/canvas/generate/audio-slots';
import {
  AUDIO_MODE_OPTIONS,
  audioModeOption,
} from '@web/spaces/canvas/generate/audio-mode-options';
import {
  audioFlagValue,
  INSTRUMENTAL_PARAM,
} from '@web/spaces/canvas/generate/audio-params';
import { buildAudioPanelViewModel } from '@web/spaces/canvas/generate/audio-panel-view-model';
import { estimateAudioCredits } from '@web/spaces/canvas/generate/audio-credits';
import { buildAudioTaskPayload } from '@web/spaces/canvas/generate/audio-task-payload';
import { AudioGeneratePanel } from '@web/spaces/canvas/generate/AudioGeneratePanel';
import type { AudioParamsValue } from '@web/spaces/canvas/generate/AudioParamsPicker';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import {
  evaluateExecute,
  refusalToastKey,
} from '@web/spaces/canvas/generate/generate-guards';
import {
  CatalogGatedFrame,
  useOpenPanelNode,
} from '@web/spaces/canvas/generate/generate-panel-frame';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { pickEndToastKey } from '@web/spaces/canvas/generate/pick-end-notice';
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
import { asContentView } from '@web/spaces/canvas/types/node-view';
import { useCanvasStore } from '@web/stores';

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
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const endPick = useCanvasStore((s) => s.endPick);
  const startReferencePick = useCanvasStore((s) => s.startReferencePick);
  const startRefAudioPick = useCanvasStore((s) => s.startRefAudioPick);
  const startMusicSongPick = useCanvasStore((s) => s.startMusicSongPick);
  const startMusicVoicePick = useCanvasStore((s) => s.startMusicVoicePick);
  const startMusicInstrumentalPick = useCanvasStore(
    (s) => s.startMusicInstrumentalPick,
  );
  /** Which store action starts each slot's pick. */
  const startPick = React.useMemo(
    (): Record<AudioSlot, (id: string) => void> => ({
      refAudio: startRefAudioPick,
      musicSong: startMusicSongPick,
      musicVoice: startMusicVoicePick,
      musicInstrumental: startMusicInstrumentalPick,
    }),
    [
      startRefAudioPick,
      startMusicSongPick,
      startMusicVoicePick,
      startMusicInstrumentalPick,
    ],
  );
  const referencePicking = useCanvasStore(
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
    isMountedRef,
  } = useGenerateSubmitState();

  // Read during render: `getPromptFragment` is a synchronous document read with
  // no side effect, and null means the node predates prompt seeding — the panel
  // then says so instead of offering an editor that stores nothing. Resolving
  // it after the first commit would make that sentence the first thing every
  // modern node's panel renders.
  const fragment = React.useMemo(
    () => getPromptFragment(projectId, spaceId, nodeId),
    [projectId, spaceId, nodeId],
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

  const vm = React.useMemo(
    () => buildAudioPanelViewModel({ nodeId, nodes, models, mode }),
    [nodeId, nodes, models, mode],
  );

  // Read during render for the same reason the prompt fragment is: a
  // synchronous document read, seeded with the node, never created here.
  const lyricsFragment = React.useMemo(
    () => getLyricsFragment(projectId, spaceId, nodeId),
    [projectId, spaceId, nodeId],
  );
  const modeOption = audioModeOption(mode);
  // The slots this mode collects, stated on the mode itself
  // (`audio-mode-options.ts`) — reference-to-music offers three, so the old
  // "does the model declare an audio source" rule would have shown the voice
  // sample there too.
  const slots = modeOption.slots;
  /** Whether this mode shows a lyrics box, and so insists on what goes in it. */
  const lyrics = modeOption.lyrics;
  /** The slot whose pick is running on this node, if any. */
  const activeSlot = useCanvasStore((s) => {
    const session = s.pickSession;
    if (session?.nodeId !== nodeId) return undefined;
    const name = slotForPurpose(session.purpose);
    return name !== undefined && name in AUDIO_SLOTS
      ? (name as AudioSlot)
      : undefined;
  });
  const onPickSlot = React.useCallback(
    (slot: AudioSlot) => {
      const session = useCanvasStore.getState().pickSession;
      const purpose = AUDIO_SLOTS[slot].purpose;
      // Clicking the slot whose pick is already running ends it; clicking
      // another one moves the pick to that slot.
      if (session?.nodeId === nodeId && session.purpose === purpose) {
        endPick();
        return;
      }
      startPick[slot](nodeId);
    },
    [startPick, endPick, nodeId],
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
  // A running slot pick outlives the control that started it when the mode
  // changes (locally, or via a collaborator's setNodeMode): the slot stops
  // rendering, so the pick loses its control — Exit on the banner would be the
  // only way out, while the canvas kept dimming candidates for a slot that is
  // gone.
  React.useEffect(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId !== nodeId) return;
    // Every audio purpose is weighed, not just this mode's: a pick started on
    // one mode has to end when the panel switches to a mode that does not
    // collect that slot, whichever slot it was.
    const running = slotForPurpose(session.purpose);
    if (running === undefined || slots.includes(running as AudioSlot)) return;
    endPick();
    // The slot list comes from the mode, so this is a mode change reaching
    // the pick — and the write may well have been a collaborator's.
    toast.warning(t(pickEndToastKey(getLastWriteWasLocal())));
  }, [slots, nodeId, endPick, t, getLastWriteWasLocal]);

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

  /**
   * Whether the track is marked vocal-free, so nothing is asked of the lyrics.
   *
   * One read for the two things that answer to it — the gate below and the
   * lyrics box's own state — so the button and the box can never disagree
   * about whether words are wanted.
   */
  const instrumental = audioFlagValue(
    vm.modelEntry,
    INSTRUMENTAL_PARAM,
    params[INSTRUMENTAL_PARAM],
  );

  // Every write re-derives from live Yjs at click time: the render closure goes
  // stale the moment a collaborator edits the node, and writing off it would
  // clobber their edit.
  const freshContent = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return asContentView(graph.nodes.find((n) => n.id === nodeId)?.data);
  }, [projectId, spaceId, nodeId]);
  const freshVm = React.useCallback(() => {
    const graph = readCanvasGraph(projectId, spaceId);
    return buildAudioPanelViewModel({ nodeId, nodes: graph.nodes, models, mode });
  }, [projectId, spaceId, nodeId, models, mode]);

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
    (partial: AudioParamsValue) => {
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
      // Collapsing the picker is the picker's own doing (VoicePicker closes on
      // pick), so this callback has no reason to reach for the list handle.
    },
    [projectId, spaceId, nodeId, freshVm, freshContent, vm.model, queryClient, t],
  );

  const onAddReference = React.useCallback(() => {
    const session = useCanvasStore.getState().pickSession;
    if (session?.nodeId === nodeId && session.purpose === 'reference') {
      endPick();
    } else {
      startReferencePick(nodeId);
    }
  }, [startReferencePick, endPick, nodeId]);

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
    const freshInstrumental = audioFlagValue(
      fresh.modelEntry,
      INSTRUMENTAL_PARAM,
      fresh.params[INSTRUMENTAL_PARAM],
    );
    // Empty on a track the user marked vocal-free: the box is off screen for
    // that setting, so the request says what the panel says. That pair is also
    // the one combination measured to complete without words (2026-09-05).
    // What is written stays on the node, so turning the switch back off
    // returns it.
    const freshLyrics = lyrics
      ? freshInstrumental
        ? ''
        : (lyricsEditorRef.current?.serializePrompt() ?? lyricsTextRef.current)
      : undefined;
    const maxInputChars = fresh.modelEntry?.max_input_chars;
    const refusal = evaluateExecute({
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
      requiredSlots: slots,
      filledSlots: slots.filter((slot) => fresh.slotUrls[slot] !== undefined),
      lyricsRequired: lyrics,
      lyricsText: freshLyrics,
      instrumental: freshInstrumental,
    });
    if (refusal != null) {
      const key = refusalToastKey(refusal);
      // `max` comes from the same value the gate judged by, so the sentence
      // can never name a limit other than the one that refused.
      if (key) toast.warning(t(key, { max: maxInputChars ?? 0 }));
      return;
    }
    // Unreachable past the gate above — `no-model` covers it — and stated so
    // the payload builder gets an entry rather than undefined.
    if (!fresh.modelEntry) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const payload = buildAudioTaskPayload({
        nodeId,
        projectId,
        spaceId,
        model: fresh.modelEntry,
        params: fresh.params,
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
      // Close only if THIS mount is alive AND the panel is still on this node.
      if (
        isMountedRef.current &&
        useCanvasStore.getState().panelHostId === nodeId &&
        useCanvasStore.getState().panelKind === 'generateAudio'
      ) {
        closeActivePanel();
      }
    } catch (err) {
      // Unconditional: a submit that failed after the user closed the panel
      // still explains itself. Only the state writes are gated on the mount.
      toast.error(
        executeErrorMessage(err instanceof ApiException ? err.status : undefined, t),
      );
      if (!isMountedRef.current) return;
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    nodeId,
    projectId,
    spaceId,
    freshVm,
    closeActivePanel,
    t,
    lyrics,
    slots,
    // Stable for this mount's lifetime; listed because they come from a hook,
    // where the linter cannot see that for itself.
    isMountedRef,
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
  const mentionEmptyLabel = t('canvas.generatePanel.mentionEmpty');
  const mentionNoMatchLabel = t('canvas.generatePanel.mentionNoMatch');
  const promptSlot = React.useMemo(
    () =>
      fragment ? (
        <PromptEditor
          ref={promptEditorRef}
          // Half height on a music mode: a style brief is a line or two, and
          // the box grows with whatever is typed into it either way. Keyed on
          // the mode rather than on the lyrics box being up, so marking a
          // track instrumental does not resize the box that stays.
          startingHeight={lyrics ? 'half' : 'full'}
          fragment={fragment}
          placeholder={promptPlaceholder}
          onTextChange={onPromptChange}
          // An audio node collects only text rows, and a text chip serializes
          // into the prompt itself — no id ever becomes a model input here.
          onAtMentionsChange={noop}
          onFocus={onPromptFocus}
          references={references}
          // An image `@` chip is a model input on the other two panels; here
          // there is no path for one to travel, and an audio node takes no
          // image edge to make one from.
          imageRefsDisabled
          mentionEmptyLabel={mentionEmptyLabel}
          mentionNoMatchLabel={mentionNoMatchLabel}
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
      mentionNoMatchLabel,
      caretProvider,
      lyrics,
      promptEditorRef,
    ],
  );

  const lyricsPlaceholder = t('canvas.generatePanel.musicLyricsPlaceholder');
  const lyricsSlot = React.useMemo(
    () =>
      // An instrumental track has no words to write, so the box is not there
      // to write them in (user 2026-09-06). A box left standing has to say why
      // it refuses typing, and the whole of that explanation is a sentence the
      // reader has to go and read; nothing on the screen is a shorter way to
      // say "not this run" than the box being gone. What was typed stays on the
      // node — the fragment is untouched — and comes back with the box when the
      // switch goes off.
      lyrics && lyricsFragment && !instrumental ? (
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
          imageRefsDisabled
          mentionEmptyLabel={mentionEmptyLabel}
          mentionNoMatchLabel={mentionNoMatchLabel}
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
      mentionNoMatchLabel,
      caretProvider,
      lyricsEditorRef,
      instrumental,
    ],
  );

  return (
    <AudioGeneratePanel
      models={modeModels}
      model={vm.model}
      currentModel={vm.modelEntry}
      creditEstimate={estimateAudioCredits(vm.modelEntry, {
        text: promptText,
        // Read off the node's record for the active model, which is where the
        // length picker writes it. A model billing per second declares this
        // param with a default, so a node that has never touched the picker
        // still carries one.
        ...(typeof params.duration === 'number' ? { seconds: params.duration } : {}),
      })}
      modelTakesPrompt={vm.promptRequired}
      mode={mode}
      modeOptions={availableModes}
      voiceRequired={vm.voiceRequired}
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
        requiredSlots: slots,
        filledSlots: slots.filter((slot) => vm.slotUrls[slot] !== undefined),
        lyricsRequired: lyrics,
        lyricsText,
        instrumental,
      })}
      promptSlot={promptSlot}
      lyricsSlot={lyricsSlot}
      // The mode, not the lyrics box: a music mode goes on calling its first
      // box the style after the instrumental switch takes the second one away.
      labelBoxes={lyrics}
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
