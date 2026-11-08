// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The AI output dialog (inner#1860, design §5.2, §5.3, §6.2): a non-modal
 * panel under the selection where an AI text command's result streams in,
 * and nothing reaches the body until the user presses insert or replace.
 *
 * It wraps the document editor's chrome and hands the bubble bar's AI menu a
 * launcher through context. One session at a time: the session reducer
 * (`document-ai-session.ts`) decides every state and button, and this file
 * only carries out the effects it asks for — a request, an abort, a write, a
 * toast — and draws the state it is in.
 *
 * The panel hangs under the last line of the original range, whichever end
 * the user dragged from (user 2026-11-01), carried by the AI range
 * (`document-ai-range.ts`); once those words are gone, under the insert
 * block; once that is gone too, at the last place it stood. Over a select-all
 * the place is under the bar, frozen. It stays whole inside the body's
 * viewport. Which side of its anchor it sits on is decided once, as it
 * appears (the bar's E3); a panel that grows scrolls inside instead.
 *
 * The preview is the body's own drawing: the result is parsed with the body's
 * schema by an editor that lives as long as the session, serialised with
 * BlockNote's `blocksToFullHTML`, and put in copies of the body's own
 * ancestors (`inPlaceOf`, as the drag preview does). The HTML is the schema's
 * serialisation of model output, not markup a user wrote.
 */

import * as React from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type Placement,
  type VirtualElement,
} from '@floating-ui/react';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { useSmoothText } from 'use-smooth-text';
import * as Y from 'yjs';

import { documentBodyFragment, TEXT_TOOL_INSTRUCTIONS_MAX } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { WaitingDot } from '@web/components/WaitingDot';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import {
  textToolsApi,
  type TextToolRequest,
  type TextToolsConfig,
} from '@web/data/api/text-tools';
import { StreamRefusedError } from '@web/data/stream/sse';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { langFor } from '@web/features/preferences/supported-langs';
import { useTranslation } from '@web/i18n/use-translation';
import { compositionEnd, keyBelongsToInputMethod } from '@web/lib/composition-end';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentAiLaunchContext, TONE_LABEL_KEYS, type AiLaunch } from '@web/spaces/document/document-ai-context';
import { aiCapture, aiContextOf } from '@web/spaces/document/document-ai-launch';
import { aiCoverIn, aiRangeIn, DOCUMENT_AI_RANGE, onAiEscape } from '@web/spaces/document/document-ai-range';
import {
  aiDialogButtons,
  reduceAiSession,
  type AiButtonReason,
  type AiCommand,
  type AiEffect,
  type AiSession,
  type AiSessionEvent,
  type AiWriteButton,
} from '@web/spaces/document/document-ai-session';
import {
  aiAnswer,
  aiAnswerEmpty,
  aiRequest,
  insertAiAnswer,
  replaceAiAnswer,
  type AiWriteResult,
} from '@web/spaces/document/document-ai-text';
import { viewOf, type ViewedEditor } from '@web/spaces/document/document-editor-view';
import { useDocumentProjectId } from '@web/spaces/document/document-project-context';
import { blockById, type ProposalAdmission } from '@web/spaces/document/document-proposal-landing';
import { ourMediaPrefix, ourMediaPrefixReady } from '@web/spaces/document/document-external-media';
import { inPlaceOf } from '@web/spaces/document/document-preview-styles';
import { onEditorSettled, useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** How often, at most, the preview parses the result while it streams. */
const PREVIEW_THROTTLE_MS = 80;

/** How far the panel stands off the line it follows. */
const GAP_FROM_ANCHOR_PX = 8;

/** What one opening of the dialog took from the body. */
interface Opened {
  /** Counts openings, so each gets a panel of its own. */
  readonly key: number;
  /** What every request of the session sends besides its command. */
  readonly base: { readonly project_id: string; readonly selection: string; readonly document: string };
  /** The block a result is inserted under. */
  readonly insertBlockId: string;
  /** The point a select-all pinned the panel to, in viewport coordinates. */
  readonly frozen: { readonly x: number; readonly y: number } | null;
  /** How fast the answer is shown, in characters per second. */
  readonly revealCharsPerSecond: number;
}

/**
 * The request a command sends.
 * @param base - The project, the selection and its context.
 * @param command - The command.
 * @param instructions - The custom instruction, for the custom command.
 * @returns The request.
 */
function requestFor(base: Opened['base'], command: AiCommand, instructions: string | null): TextToolRequest {
  switch (command.id) {
    case 'refine':
      return { tool: 'polish', ...base };
    case 'expand':
    case 'shorten':
      return { tool: command.id, ...base };
    case 'translate':
      return { tool: 'translate', ...base, language: command.language };
    case 'tone':
      return { tool: 'rewrite', ...base, style: command.style };
    case 'custom':
      return { tool: 'custom', ...base, instructions: instructions ?? '' };
  }
}

/**
 * The dialog's title: the command, and for translate and change tone what was
 * picked in the second level.
 * @param command - The command.
 * @param t - The translator.
 * @returns The title.
 */
function titleOf(command: AiCommand, t: (key: string) => string): string {
  switch (command.id) {
    case 'refine':
      return t('spaces.document.commands.ai_refine');
    case 'expand':
      return t('spaces.document.commands.ai_expand');
    case 'shorten':
      return t('spaces.document.commands.ai_shorten');
    case 'custom':
      return t('spaces.document.ai.customTitle');
    case 'translate': {
      return `${t('spaces.document.commands.ai_translate')} · ${langFor(command.language).nativeName}`;
    }
    case 'tone':
      return `${t('spaces.document.commands.ai_tone')} · ${t(TONE_LABEL_KEYS[command.style])}`;
  }
}


interface DocumentAiDialogProps {
  /** The document editor. */
  editor: ViewedEditor;
  /** The body's scroller viewport, which the panel hangs inside. */
  viewport: HTMLElement | null;
  /** The editor's chrome, where the bubble bar reaches the launcher. */
  children: React.ReactNode;
}

/**
 * The AI output dialog and its launcher.
 * @param props - See {@link DocumentAiDialogProps}.
 * @param props.editor - The document editor.
 * @param props.viewport - The body's scroller viewport.
 * @param props.children - The editor's chrome.
 * @returns The chrome, with the dialog when one is open.
 */
export function DocumentAiDialog({ editor, viewport, children }: DocumentAiDialogProps): React.JSX.Element {
  const t = useTranslation();
  const projectId = useDocumentProjectId();
  const { writeAccess } = useSpaceConnection();
  const writeAccessRef = React.useRef(writeAccess);
  writeAccessRef.current = writeAccess;

  const [session, setSession] = React.useState<AiSession | null>(null);
  const sessionRef = React.useRef<AiSession | null>(null);
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const openedRef = React.useRef<Opened | null>(null);
  const openings = React.useRef(0);
  const requests = React.useRef(new Map<number, AbortController>());
  // What the last failure said, when the server said something for this user.
  const failure = React.useRef<string | null>(null);
  const configRequest = React.useRef<Promise<TextToolsConfig> | null>(null);
  const endsWithEditor = React.useRef<(() => void) | null>(null);

  // The effects carried out for the reducer, held in a ref so `dispatch` keeps
  // one identity while they read the current state.
  const perform = React.useRef<(effect: AiEffect, dispatch: (event: AiSessionEvent) => void) => void>(() => undefined);
  const dispatch = React.useCallback((event: AiSessionEvent): void => {
    const step = reduceAiSession(sessionRef.current, event);
    sessionRef.current = step.session;
    setSession(step.session);
    step.effects.forEach((effect) => {
      perform.current(effect, dispatch);
    });
  }, []);

  /**
   * Reports how a write ended.
   * @param result - The write's outcome.
   */
  const told = React.useCallback((result: AiWriteResult): void => {
    if (result.outcome === 'written' || result.outcome === 'nothingWritten') {
      const leftOut = result.leftOut ?? 0;
      if (leftOut > 0) toast.warning(t('chat.documentProposal.mediaLeftOut', { count: leftOut }));
      viewOf(editor)?.focus();
      return;
    }
    toast.error(t(result.outcome === 'targetGone' ? 'spaces.document.ai.blockGone' : 'spaces.document.ai.notWritable'));
  }, [editor, t]);

  perform.current = (effect, send): void => {
    switch (effect.kind) {
      case 'request': {
        const now = sessionRef.current;
        const at = openedRef.current;
        if (now === null || at === null) return;
        const { seq } = effect;
        const controller = new AbortController();
        requests.current.set(seq, controller);
        void textToolsApi.stream(requestFor(at.base, now.command, now.instructions), {
          onEvent: (event) => {
            if (event.type === 'text_delta') send({ type: 'delta', seq, text: event.text });
            else if (event.type === 'done') send({ type: 'done', seq });
            else if (event.type === 'error') {
              failure.current = event.message === '' ? null : event.message;
              send({ type: 'error', seq });
            }
          },
          onError: (err) => {
            failure.current = err instanceof StreamRefusedError && err.fromServer ? err.message : null;
            send({ type: 'error', seq });
          },
          signal: controller.signal,
        }).finally(() => {
          requests.current.delete(seq);
        });
        return;
      }
      case 'abort':
        requests.current.get(effect.seq)?.abort();
        return;
      case 'toastFailure':
        toast.error(failure.current ?? t('server.text_tool.failed'));
        failure.current = null;
        return;
      case 'toastNotWritable':
        toast.error(t('spaces.document.ai.notWritable'));
        return;
      case 'write': {
        /**
         * Reads whether the connection may write, at the moment of the write.
         * @returns The admission.
         */
        const admission = (): ProposalAdmission => ({ available: true, writeAccess: writeAccessRef.current });
        /** Says the write did not go through. */
        const failed = (): void => {
          toast.error(t('server.text_tool.failed'));
        };
        const at = openedRef.current;
        const command = sessionRef.current?.command.id;
        if (at === null || command === undefined) return;
        // Written at the press: the original range is cleared as the session
        // closes, right after this. The panel fetched the media prefix as it opened.
        try {
          const answer = aiAnswer(editor, editor.prosemirrorState, effect.result, ourMediaPrefix(), at.insertBlockId);
          told(effect.how === 'insert'
            ? insertAiAnswer({ editor }, at.insertBlockId, answer, admission)
            : replaceAiAnswer({ editor }, answer, admission));
        } catch (err) {
          failed();
          throw err;
        }
      }
    }
  };

  const launch = React.useCallback<AiLaunch>((command, opener) => {
    if (projectId === null) return;
    const pending = (configRequest.current ??= textToolsApi.config());
    void pending.then((config) => {
      const view = viewOf(editor);
      if (view === null) return;
      const { selection } = view.state;
      const captured = aiCapture(view.state);
      if (captured === null) return;
      const { doc } = view.state;
      // The budget is measured on what is sent (§5.2).
      const sent = aiRequest(editor, doc, captured.range);
      if (sent.length > config.selectionMaxChars) {
        toast.error(t('spaces.document.ai.selectionTooLong'));
        return;
      }
      const bar = selection instanceof AllSelection ? opener?.getBoundingClientRect() ?? null : null;
      openings.current += 1;
      const next: Opened = {
        key: openings.current,
        base: { project_id: projectId, selection: sent, document: aiContextOf(editor, config.contextMaxChars) },
        revealCharsPerSecond: config.revealCharsPerSecond,
        insertBlockId: captured.insertId,
        frozen: bar === null ? null : { x: bar.left, y: bar.bottom },
      };
      openedRef.current = next;
      setOpened(next);
      // The editor going away ends the session, and its request with it
      // (E11). Held on the editor, outside any effect: a Space tab that is
      // only hidden runs every effect's cleanup and keeps its editor, and the
      // session with it.
      endsWithEditor.current?.();
      endsWithEditor.current = editor.onUnmount(() => {
        dispatch({ type: 'close' });
      });
      // A range across blocks is shown as the whole blocks it takes (§4.6).
      const shown = captured.firstId === null ? null : TextSelection.between(doc.resolve(captured.range.from), doc.resolve(captured.range.to));
      const tr = view.state.tr.setMeta(DOCUMENT_AI_RANGE, captured);
      view.dispatch(shown === null ? tr : tr.setSelection(shown));
      dispatch({ type: 'open', command });
    }, () => {
      configRequest.current = null;
      toast.error(t('server.text_tool.failed'));
    });
  }, [dispatch, editor, projectId, t]);

  // The original range is the dialog's for as long as it is open.
  const state = session?.state ?? null;
  React.useEffect(() => {
    if (state !== 'closed') return;
    endsWithEditor.current?.();
    endsWithEditor.current = null;
    const view = viewOf(editor);
    if (view !== null && aiRangeIn(view.state) !== null) view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, null));
  }, [state, editor]);

  const insertBlockId = opened?.insertBlockId ?? null;
  const readInsertBlock = React.useCallback(
    (current: ViewedEditor): boolean => insertBlockId !== null && blockById(current.prosemirrorState.doc, insertBlockId) !== null,
    [insertBlockId],
  );
  const insertBlockPresent = useEditorSnapshot(editor, readInsertBlock);

  return (
    <DocumentAiLaunchContext.Provider value={launch}>
      {children}
      {session !== null && session.state !== 'closed' && opened !== null && viewport !== null && (
        <AiPanel
          key={opened.key}
          editor={editor}
          viewport={viewport}
          opened={opened}
          session={session}
          insertBlockPresent={insertBlockPresent}
          writable={writeAccess === 'granted'}
          dispatch={dispatch}
        />
      )}
    </DocumentAiLaunchContext.Provider>
  );
}

interface AiPanelProps {
  editor: ViewedEditor;
  viewport: HTMLElement;
  opened: Opened;
  session: AiSession;
  insertBlockPresent: boolean;
  /** Whether the connection may write; the editor's own editability is read at the press. */
  writable: boolean;
  dispatch: (event: AiSessionEvent) => void;
}

/**
 * Where the panel's anchor is now: the last line of the original range,
 * else the insert block, else nowhere.
 * @param editor - The document editor.
 * @param opened - The opening.
 * @returns The anchor, as a zero-width box across the line or block, or null.
 */
function anchorBox(editor: ViewedEditor, opened: Opened): DOMRect | null {
  if (opened.frozen !== null) return new DOMRect(opened.frozen.x, opened.frozen.y, 0, 0);
  const view = viewOf(editor);
  if (view === null) return null;
  // The panel lines up with the text column, under the line it follows.
  const left = view.dom.getBoundingClientRect().left;
  const last = aiCoverIn(view.state)?.to;
  if (last !== undefined) {
    // The line of the last selected character: a range ending at the start of
    // a line would otherwise measure the line after it.
    const line = view.coordsAtPos(last, -1);
    return new DOMRect(left, line.top, 0, line.bottom - line.top);
  }
  const block = view.dom.querySelector(`[data-id="${CSS.escape(opened.insertBlockId)}"]`);
  if (block === null) return null;
  const box = block.getBoundingClientRect();
  return new DOMRect(left, box.top, 0, box.height);
}

/**
 * The panel of one session.
 * @param props - See {@link AiPanelProps}.
 * @param props.editor - The document editor.
 * @param props.viewport - The body's scroller viewport.
 * @param props.opened - What the opening took from the body.
 * @param props.session - The session.
 * @param props.insertBlockPresent - Whether the insert block is in the body.
 * @param props.writable - Whether the connection may write.
 * @param props.dispatch - Sends the session an event.
 * @returns The panel.
 */
function AiPanel({
  editor,
  viewport,
  opened,
  session,
  insertBlockPresent,
  writable,
  dispatch,
}: AiPanelProps): React.JSX.Element {
  const t = useTranslation();
  // The model sends its text in bursts; the user sees it at a reading pace
  // that speeds up to catch any backlog within about a second.
  const { text: shown, isComplete, flush } = useSmoothText(session.result, {
    done: session.state !== 'streaming',
    charsPerSecond: opened.revealCharsPerSecond,
    granularity: 'word',
  });
  // Stop means stop: what has arrived is shown at once.
  React.useEffect(() => {
    if (session.state === 'stopped') flush();
  }, [session.state, flush]);
  // Outside media never land in the body, so they are not counted, drawn or
  // fetched here either.
  const ourPrefix = useOurMediaPrefix();
  // Insert and replace write the answer once all of it is on screen.
  const finished = (session.state === 'stopped' || session.state === 'done') && isComplete;
  // Blank answers leave nothing to write (§5.3).
  const resultEmpty = aiAnswerEmpty(session.result);
  const readReplaceable = React.useCallback(
    (current: ViewedEditor): boolean => finished && aiCoverIn(current.prosemirrorState) !== null,
    [finished],
  );
  // Replace and its button decide by the same function (§5.3).
  const replaceable = useEditorSnapshot(editor, readReplaceable);
  const buttons = React.useMemo(
    () => aiDialogButtons({ state: session.state, resultEmpty, revealed: isComplete, replaceable, insertBlockPresent }),
    [session.state, resultEmpty, isComplete, replaceable, insertBlockPresent],
  );

  // The place the panel stood last, for when neither the words nor their
  // block is left to follow.
  const lastBox = React.useRef<DOMRect | null>(null);
  const reference = React.useMemo<VirtualElement>(() => ({
    getBoundingClientRect: () => {
      const box = anchorBox(editor, opened);
      if (box !== null) lastBox.current = box;
      return lastBox.current ?? new DOMRect(0, 0, 0, 0);
    },
    contextElement: viewOf(editor)?.dom,
  }), [editor, opened]);
  // Which side of its anchor the panel sits, settled as it appears (the
  // bubble bar's E3): `flip` is left out once it holds.
  const [side, setSide] = React.useState<Placement | null>(null);
  const middleware = React.useMemo(
    () => (side === null
      ? [offset(GAP_FROM_ANCHOR_PX), flip({ boundary: viewport }), shift({ boundary: viewport, crossAxis: true })]
      : [offset(GAP_FROM_ANCHOR_PX), shift({ boundary: viewport, crossAxis: true })]),
    [side, viewport],
  );
  const { refs, floatingStyles, placement, isPositioned, update } = useFloating({
    open: true,
    // Against the text the panel travels with the content; against a frozen
    // point it stays on the screen.
    strategy: opened.frozen === null ? 'absolute' : 'fixed',
    placement: side ?? 'bottom-start',
    middleware,
    whileElementsMounted: autoUpdate,
  });
  React.useEffect(() => {
    refs.setPositionReference(reference);
  }, [reference, refs]);
  React.useEffect(() => {
    if (side === null && isPositioned) setSide(placement);
  }, [side, isPositioned, placement]);
  // Edits move the anchor; `autoUpdate` hears only scrolls and resizes.
  React.useEffect(() => onEditorSettled(editor, update), [editor, update]);

  // The dialog takes the keyboard as it shows, so Tab reaches its buttons (the
  // bar's menus take none, user 2026-08-26); the instruction box takes it
  // itself. It keeps it when the instruction box goes, and gives it back to
  // the body as it closes.
  const panel = React.useRef<HTMLDivElement | null>(null);
  const setPanel = React.useCallback((element: HTMLDivElement | null) => {
    panel.current = element;
    refs.setFloating(element);
  }, [refs]);
  const composing = session.state === 'composing';
  React.useEffect(() => {
    const element = panel.current;
    if (!isPositioned || composing || element === null) return;
    const active = element.ownerDocument.activeElement;
    if (active === null || active === element.ownerDocument.body || !element.contains(active)) {
      element.focus({ preventScroll: true });
    }
  }, [isPositioned, composing]);
  React.useLayoutEffect(() => {
    // Read as the panel goes, not as it mounts: the portal renders the panel
    // one pass after this component, and its ref is let go only after this
    // cleanup has run.
    const live = panel;
    return () => {
      const element = live.current;
      if (element?.contains(element.ownerDocument.activeElement)) viewOf(editor)?.focus();
    };
  }, [editor]);

  // Escape typed in the body reaches the dialog through the editor's own
  // shortcut, which keeps it from blurring the body.
  React.useEffect(() => onAiEscape(editor, () => {
    dispatch({ type: 'close' });
  }), [editor, dispatch]);

  const title = titleOf(session.command, t);
  // What the stop-or-retry button was when a press on it began. The button
  // turns from stop into retry under a press that is still going on (the
  // second click of a double click, a held key, a reveal that ends before the
  // pointer is released), and that press is still a stop.
  const pressedAsStop = React.useRef<boolean | null>(null);

  const close = React.useCallback(() => {
    dispatch({ type: 'close' });
  }, [dispatch]);

  /**
   * Presses insert or replace.
   * @param how - Which.
   * @param button - Its state.
   */
  const press = React.useCallback((how: 'insert' | 'replace', button: AiWriteButton): void => {
    if (button.disabled) {
      toast.warning(t(reasonKey(button.reason)));
      return;
    }
    dispatch({ type: how, writable: writable && editor.isEditable });
  }, [dispatch, editor, t, writable]);

  return (
    <FloatingPortal root={opened.frozen === null ? viewport : undefined}>
      {/* A dialog closes on Escape (the WAI-ARIA dialog pattern); the lint
          rule's allow-list leaves the dialog role out. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={setPanel}
        style={floatingStyles}
        role='dialog'
        aria-labelledby='doc-ai-title'
        data-testid='doc-ai-dialog'
        tabIndex={-1}
        // Escape inside the dialog closes it, unless something in it already
        // took the key; Escape in the body comes through the editor's own
        // shortcut (`onAiEscape`), and anywhere else it is not the dialog's.
        onKeyDown={(event) => {
          // An input method's own Escape cancels its composition, not the dialog.
          if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
          event.preventDefault();
          dispatch({ type: 'close' });
        }}
        className={cn(
          'z-20 flex w-[min(560px,calc(100%-2rem))] flex-col rounded-overlay border border-border bg-popover text-popover-foreground shadow-md outline-none',
          !isPositioned && 'invisible',
        )}
      >
        <div className='flex shrink-0 items-center justify-between gap-2 border-b border-border py-1.5 pl-3 pr-1.5'>
          <span id='doc-ai-title' data-testid='doc-ai-title' className='flex min-w-0 items-center gap-1.5 text-sm font-medium'>
            <Sparkles className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
            <span className='truncate'>{title}</span>
          </span>
          <Button
            variant='ghost'
            size='compact'
            data-testid='doc-ai-close'
            aria-label={t('spaces.document.ai.close')}
            className='w-[var(--btn-compact)] px-0 text-muted-foreground'
            onClick={close}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
        {session.state === 'composing' ? (
          <Composer dispatch={dispatch} shown={isPositioned} />
        ) : (
          <>
            {session.instructions !== null && <InstructionLine text={session.instructions} />}
            <Preview
              editor={editor}
              ourPrefix={ourPrefix}
              insertBlockId={opened.insertBlockId}
              text={shown}
              streaming={session.state === 'streaming' || !isComplete}
              running={session.state === 'streaming'}
            />
          </>
        )}
        {session.state !== 'composing' && (
          <div className='flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5'>
            <div className='flex items-center gap-2'>
              {(buttons.stop || buttons.retry) && (
                // One element for both, so the keyboard stays on it as stop
                // turns into retry.
                <Button
                  variant='outline'
                  size='sm'
                  data-testid={buttons.stop ? 'doc-ai-stop' : 'doc-ai-retry'}
                  icon={buttons.stop
                    ? <Square className='mr-1.5 h-3.5 w-3.5' />
                    : <RotateCcw className='mr-1.5 h-3.5 w-3.5' />}
                  onPointerDown={() => {
                    pressedAsStop.current = buttons.stop;
                  }}
                  onKeyDown={(event) => {
                    if (event.repeat) event.preventDefault();
                    else pressedAsStop.current = buttons.stop;
                  }}
                  onClick={(event) => {
                    const asStop = pressedAsStop.current ?? buttons.stop;
                    pressedAsStop.current = null;
                    if (event.detail > 1) return;
                    if (!asStop) dispatch({ type: 'retry' });
                    // A finished answer still being written only needs the rest shown.
                    else if (session.state === 'streaming') dispatch({ type: 'stop' });
                    else flush();
                  }}
                >
                  {t(buttons.stop ? 'spaces.document.ai.stop' : 'spaces.document.ai.retry')}
                </Button>
              )}
            </div>
            <div className='flex items-center gap-2'>
              {buttons.insert !== null && (
                <WriteButton
                  how='insert'
                  testId='doc-ai-insert'
                  label={t('spaces.document.ai.insert')}
                  variant='outline'
                  button={buttons.insert}
                  onPress={press}
                />
              )}
              {buttons.replace !== null && (
                <WriteButton
                  how='replace'
                  testId='doc-ai-replace'
                  label={t('spaces.document.ai.replace')}
                  variant='default'
                  button={buttons.replace}
                  onPress={press}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}

/**
 * The catalog key that says why a write button cannot be pressed.
 * @param reason - The reason.
 * @returns The key.
 */
function reasonKey(reason: AiButtonReason | null): string {
  return reason === 'insertBlockGone' ? 'spaces.document.ai.blockGone' : 'spaces.document.ai.rangeGone';
}

/**
 * Insert or replace: pressable, or dimmed with the reason on hover and on a
 * press (a condition that is not met, `packages/web/AGENTS.md#disabled-controls`).
 * @param props - The button.
 * @param props.how - Which write it is.
 * @param props.testId - Its test id.
 * @param props.label - Its label.
 * @param props.variant - Its look.
 * @param props.button - Whether it can be pressed, and why not.
 * @param props.onPress - What a press does.
 * @returns The button.
 */
const WriteButton = React.memo(function WriteButton({
  how,
  testId,
  label,
  variant,
  button,
  onPress,
}: {
  how: 'insert' | 'replace';
  testId: string;
  label: string;
  variant: 'outline' | 'default';
  button: AiWriteButton;
  onPress: (how: 'insert' | 'replace', button: AiWriteButton) => void;
}): React.JSX.Element {
  const t = useTranslation();
  const control = (
    <Button
      variant={variant}
      size='sm'
      data-testid={testId}
      aria-disabled={button.disabled ? 'true' : undefined}
      className={cn(button.disabled && 'opacity-50')}
      onClick={() => {
        onPress(how, button);
      }}
    >
      {label}
    </Button>
  );
  if (!button.disabled) return control;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      {/* The panel hangs in the body's scroller, which would clip it. */}
      <TooltipContent portal>{t(reasonKey(button.reason))}</TooltipContent>
    </Tooltip>
  );
});

/**
 * The custom instruction box: Enter or the start button starts, Shift+Enter
 * makes a new line, and the Enter that confirms an input method's candidate is
 * the input method's.
 * @param props - The box.
 * @param props.dispatch - Sends the session the instruction.
 * @param props.shown - Whether the panel is on screen yet.
 * @returns The box.
 */
function Composer({
  dispatch,
  shown,
}: {
  dispatch: (event: AiSessionEvent) => void;
  shown: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const [text, setText] = React.useState('');
  const composition = React.useMemo(() => compositionEnd(), []);
  // The box takes the keyboard as it appears: writing the instruction is the
  // only thing the dialog asks for now. Not before: the panel stays hidden
  // until it is positioned, and a browser ignores focus on a hidden element.
  const box = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (shown) box.current?.focus();
  }, [shown]);
  return (
    <>
      <div className='p-3'>
        <Textarea
          ref={box}
          rows={3}
          data-testid='doc-ai-instructions'
          autoComplete='off'
          maxLength={TEXT_TOOL_INSTRUCTIONS_MAX}
          value={text}
          placeholder={t('spaces.document.ai.instructionsPlaceholder')}
          className='resize-none'
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          onCompositionEnd={() => {
            composition.mark();
          }}
          onKeyDown={(event) => {
            // The input method's own Escape cancels its candidates; it is not
            // the user asking to close the dialog.
            if (event.key === 'Escape' && keyBelongsToInputMethod(event.nativeEvent, composition)) {
              event.stopPropagation();
              return;
            }
            if (event.key !== 'Enter' || event.shiftKey) return;
            if (keyBelongsToInputMethod(event.nativeEvent, composition)) return;
            event.preventDefault();
            dispatch({ type: 'submit', instructions: event.currentTarget.value });
          }}
        />
      </div>
      <div className='flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1.5'>
        <Button
          size='sm'
          data-testid='doc-ai-start'
          disabled={text.trim() === ''}
          onClick={() => {
            dispatch({ type: 'submit', instructions: text });
          }}
        >
          {t('spaces.document.ai.start')}
        </Button>
      </div>
    </>
  );
}

/**
 * The custom instruction, once submitted: one read-only line, cut short with
 * the whole of it on hover.
 * @param props - The line.
 * @param props.text - The instruction.
 * @returns The line.
 */
function InstructionLine({ text }: { text: string }): React.JSX.Element {
  const t = useTranslation();
  const line = t('spaces.document.ai.instruction', { text });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-testid='doc-ai-instruction' className='shrink-0 truncate border-b border-border px-3 py-1.5 text-xs text-muted-foreground'>
          {line}
        </div>
      </TooltipTrigger>
      <TooltipContent portal className='max-w-sm whitespace-pre-wrap'>{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Where our own media live, once known.
 * @returns The prefix, or null until it is known.
 */
function useOurMediaPrefix(): string | null {
  const [ourPrefix, setOurPrefix] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void ourMediaPrefixReady().then((prefix) => {
      if (live) setOurPrefix(prefix);
    });
    return () => {
      live = false;
    };
  }, []);
  return ourPrefix;
}

/**
 * The result, drawn the way the body draws blocks: the blocks insert and
 * replace write (design §5.3).
 * @param props - The preview.
 * @param props.editor - The document editor, whose surroundings the preview copies.
 * @param props.ourPrefix - Where our own media live.
 * @param props.insertBlockId - The insert block, which tells whether the result lands in a table cell.
 * @param props.text - The result as far as it is shown yet.
 * @param props.streaming - Whether the text is still growing.
 * @param props.running - Whether the request is still running; the Agent's dot shows until it has drawn words.
 * @returns The preview.
 */
function Preview({
  editor,
  ourPrefix,
  insertBlockId,
  text,
  streaming,
  running,
}: {
  editor: ViewedEditor;
  ourPrefix: string | null;
  insertBlockId: string;
  text: string;
  streaming: boolean;
  running: boolean;
}): React.JSX.Element {
  // One parser for the session, made and taken down with the panel.
  const [parser, setParser] = React.useState<ViewedEditor | null>(null);
  React.useEffect(() => {
    const doc = new Y.Doc();
    setParser(buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions: [] }));
    return () => {
      setParser(null);
      doc.destroy();
    };
  }, []);

  const [html, setHtml] = React.useState('');
  const latest = React.useRef(text);
  latest.current = text;
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  React.useEffect(() => {
    if (parser === null) return;
    /**
     * Parses the result as it stands now; the latest text is the one taken.
     */
    const parse = (): void => {
      timer.current = null;
      const shown = latest.current;
      const blocks = aiAnswer(parser, editor.prosemirrorState, shown, ourPrefix, insertBlockId).preview;
      setHtml(blocks.length === 0 ? '' : parser.blocksToFullHTML(blocks as never));
    };
    if (!streaming) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      parse();
      // The first block's format and a cell's unfolding follow the range: read
      // again after the body's changes, at most once per interval.
      return editor.onChange(() => {
        timer.current ??= window.setTimeout(parse, PREVIEW_THROTTLE_MS);
      });
    }
    // While it streams, at most one parse per interval, of whatever has
    // arrived by then.
    timer.current ??= window.setTimeout(parse, PREVIEW_THROTTLE_MS);
  }, [parser, text, streaming, ourPrefix, insertBlockId, editor]);

  const host = React.useRef<HTMLDivElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = host.current;
    if (element === null) return;
    element.replaceChildren();
    if (html === '') return;
    const template = document.createElement('template');
    template.innerHTML = html;
    // The block group the serialiser writes stands where the body's own does.
    const only = template.content.childElementCount === 1 ? template.content.firstElementChild : null;
    const content = only instanceof HTMLElement ? only : document.createElement('div');
    if (content !== only) content.append(template.content);
    const view = viewOf(editor);
    element.append(view === null ? content : inPlaceOf(view, content, null));
    // The copies keep the body's `contenteditable`; the preview is read only.
    content.contentEditable = 'false';
    if (streaming) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [html, editor, streaming]);

  return (
    <ScrollArea viewportRef={scroller} className='min-h-16' viewportClassName='max-h-56 px-3 py-2.5'>
      {running && html === '' && <WaitingDot />}
      <div ref={host} data-testid='doc-ai-preview' />
    </ScrollArea>
  );
}
