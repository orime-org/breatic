// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The AI output dialog (inner#1860, design §5.2, §5.3, §6.2): a non-modal
 * panel under the selection where an AI text command's result streams in,
 * and nothing reaches the body until the reader presses insert or replace.
 *
 * It wraps the document editor's chrome and hands the bubble bar's AI menu a
 * launcher through context. One session at a time: the session reducer
 * (`document-ai-session.ts`) decides every state and button, and this file
 * only carries out the effects it asks for — a request, an abort, a write, a
 * toast — and draws the state it is in.
 *
 * The panel hangs under the last line of the original range, whichever end
 * the reader dragged from (user 2026-11-01), carried by the AI range
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
import { AllSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { RotateCcw, Sparkles, Square, X } from 'lucide-react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

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
import { AI_TONES, DocumentAiLaunchContext, type AiLaunch } from '@web/spaces/document/document-ai-context';
import { aiContextOf, aiInsertBlockId } from '@web/spaces/document/document-ai-launch';
import { aiRangeIn, DOCUMENT_AI_RANGE, onAiEscape, onAiRangeChange } from '@web/spaces/document/document-ai-range';
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
import { insertAiResult, replaceAiResult, type AiWriteResult } from '@web/spaces/document/document-ai-write';
import { selectionMarkdown } from '@web/spaces/document/document-blocks-read';
import { viewOf, type ViewedEditor } from '@web/spaces/document/document-editor-view';
import { useDocumentProjectId } from '@web/spaces/document/document-project-context';
import { blockById, type ProposalAdmission } from '@web/spaces/document/document-proposal-landing';
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
  readonly insertBlockId: string | null;
  /** The point a select-all pinned the panel to, in viewport coordinates. */
  readonly frozen: { readonly x: number; readonly y: number } | null;
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
    case 'tone': {
      const tone = AI_TONES.find((one) => one.id === command.style);
      return `${t('spaces.document.commands.ai_tone')} · ${tone === undefined ? command.style : t(tone.labelKey)}`;
    }
  }
}

/**
 * The original range as one span, while it is on its words.
 * @param editor - The document editor.
 * @returns From its first letter to past its last, or null once gone.
 */
function originalRange(editor: ViewedEditor): { from: number; to: number } | null {
  const range = aiRangeIn(editor.prosemirrorState);
  if (range?.kind !== 'present') return null;
  return { from: range.segments[0]!.from, to: range.segments[range.segments.length - 1]!.to };
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
  // What the last failure said, when the server said something for this reader.
  const failure = React.useRef<string | null>(null);
  const config = React.useRef<Promise<TextToolsConfig> | null>(null);
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
    if (result.outcome === 'written' || result.outcome === 'mediaOnly') {
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
        if (effect.how === 'insert') {
          const blockId = openedRef.current?.insertBlockId;
          if (blockId === null || blockId === undefined) return;
          void insertAiResult({ editor }, blockId, effect.result, admission).then(told, failed);
          return;
        }
        const range = originalRange(editor);
        if (range === null) return;
        void replaceAiResult({ editor }, range, effect.result, admission).then(told, failed);
      }
    }
  };

  const launch = React.useCallback<AiLaunch>((command, opener) => {
    if (projectId === null) return;
    const pending = (config.current ??= textToolsApi.config());
    void pending.then((budgets) => {
      const view = viewOf(editor);
      if (view === null) return;
      const { selection } = view.state;
      if (selection.empty || selection instanceof CellSelection) return;
      const markdown = selectionMarkdown(editor, view);
      if (markdown.trim() === '') return;
      if (markdown.length > budgets.selectionMaxChars) {
        toast.error(t('server.text_tool.selection_too_long', { actual: markdown.length, limit: budgets.selectionMaxChars }));
        return;
      }
      const bar = selection instanceof AllSelection ? opener?.getBoundingClientRect() ?? null : null;
      openings.current += 1;
      const next: Opened = {
        key: openings.current,
        base: { project_id: projectId, selection: markdown, document: aiContextOf(editor, budgets.contextMaxChars) },
        insertBlockId: aiInsertBlockId(view.state),
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
      view.dispatch(view.state.tr.setMeta(DOCUMENT_AI_RANGE, selection.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos }))));
      dispatch({ type: 'open', command });
    }, () => {
      config.current = null;
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

  const range = React.useSyncExternalStore(onAiRangeChange, () => aiRangeIn(editor.prosemirrorState));
  React.useEffect(() => {
    if (range?.kind === 'gone') dispatch({ type: 'rangeGone' });
  }, [range, dispatch]);

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
          rangePresent={range?.kind === 'present'}
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
  rangePresent: boolean;
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
  const range = aiRangeIn(view.state);
  if (range?.kind === 'present') {
    // The line of the last selected character: a range ending at the start of
    // a line would otherwise measure the line after it.
    const line = view.coordsAtPos(range.segments[range.segments.length - 1]!.to, -1);
    return new DOMRect(left, line.top, 0, line.bottom - line.top);
  }
  if (opened.insertBlockId === null) return null;
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
 * @param props.rangePresent - Whether the original range is on its words.
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
  rangePresent,
  insertBlockPresent,
  writable,
  dispatch,
}: AiPanelProps): React.JSX.Element {
  const t = useTranslation();
  const buttons = aiDialogButtons({
    state: session.state,
    resultEmpty: session.result.trim() === '',
    rangePresent,
    insertBlockPresent,
  });

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
  const close = React.useCallback(() => {
    dispatch({ type: 'close' });
  }, [dispatch]);

  /**
   * Presses insert or replace.
   * @param how - Which.
   * @param button - Its state.
   */
  const press = (how: 'insert' | 'replace', button: AiWriteButton): void => {
    if (button.disabled) {
      toast.warning(t(reasonKey(button.reason)));
      return;
    }
    dispatch({ type: how, writable: writable && editor.isEditable, targetPresent: true });
  };

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
          {buttons.close && (
            <Button
              variant='ghost'
              size='compact'
              data-testid='doc-ai-close'
              aria-label={t('spaces.document.ai.close')}
              className='w-[var(--btn-compact)] px-0 text-muted-foreground'
              onClick={close}
            >
              <X className='h-4 w-4' />
            </Button>
          )}
        </div>
        {session.state === 'composing' ? (
          <Composer dispatch={dispatch} shown={isPositioned} />
        ) : (
          <>
            {session.instructions !== null && <InstructionLine text={session.instructions} />}
            <Preview editor={editor} session={session} />
          </>
        )}
        {session.state !== 'composing' && (
          <div className='flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5'>
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
                  onClick={() => {
                    dispatch({ type: buttons.stop ? 'stop' : 'retry' });
                  }}
                >
                  {t(buttons.stop ? 'spaces.document.ai.stop' : 'spaces.document.ai.retry')}
                </Button>
              )}
            </div>
            <div className='flex items-center gap-2'>
              {buttons.insert !== null && (
                <WriteButton
                  testId='doc-ai-insert'
                  label={t('spaces.document.ai.insert')}
                  variant='outline'
                  button={buttons.insert}
                  onPress={(button) => {
                    press('insert', button);
                  }}
                />
              )}
              {buttons.replace !== null && (
                <WriteButton
                  testId='doc-ai-replace'
                  label={t('spaces.document.ai.replace')}
                  variant='default'
                  button={buttons.replace}
                  onPress={(button) => {
                    press('replace', button);
                  }}
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
 * @param props.testId - Its test id.
 * @param props.label - Its label.
 * @param props.variant - Its look.
 * @param props.button - Whether it can be pressed, and why not.
 * @param props.onPress - What a press does.
 * @returns The button.
 */
function WriteButton({
  testId,
  label,
  variant,
  button,
  onPress,
}: {
  testId: string;
  label: string;
  variant: 'outline' | 'default';
  button: AiWriteButton;
  onPress: (button: AiWriteButton) => void;
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
        onPress(button);
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
}

/**
 * The custom instruction box: Enter starts, Shift+Enter makes a new line, and
 * the Enter that confirms an input method's candidate is the input method's.
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
    <div className='p-3'>
      <Textarea
        ref={box}
        rows={3}
        data-testid='doc-ai-instructions'
        autoComplete='off'
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
          if (event.key !== 'Enter' || event.shiftKey) return;
          if (keyBelongsToInputMethod(event.nativeEvent, composition)) return;
          event.preventDefault();
          dispatch({ type: 'submit', instructions: event.currentTarget.value });
        }}
      />
    </div>
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
 * The result, drawn the way the body draws blocks.
 * @param props - The preview.
 * @param props.editor - The document editor, whose surroundings the preview copies.
 * @param props.session - The session, holding the result.
 * @returns The preview.
 */
function Preview({ editor, session }: { editor: ViewedEditor; session: AiSession }): React.JSX.Element {
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
  const latest = React.useRef(session.result);
  latest.current = session.result;
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const streaming = session.state === 'streaming';
  React.useEffect(() => {
    if (parser === null) return;
    /**
     * Parses the result as it stands now; the latest text is the one taken.
     */
    const parse = (): void => {
      timer.current = null;
      const markdown = latest.current;
      setHtml(markdown.trim() === '' ? '' : parser.blocksToFullHTML(parser.tryParseMarkdownToBlocks(markdown) as never));
    };
    if (!streaming) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      parse();
      return;
    }
    // While it streams, at most one parse per interval, of whatever has
    // arrived by then.
    timer.current ??= window.setTimeout(parse, PREVIEW_THROTTLE_MS);
  }, [parser, session.result, streaming]);

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

  // Until the first words, the Agent's waiting mark stands where they will.
  const waiting = streaming && session.result.trim() === '';
  return (
    <ScrollArea viewportRef={scroller} className='min-h-16' viewportClassName='max-h-56 px-3 py-2.5'>
      {waiting && <WaitingDot />}
      <div ref={host} data-testid='doc-ai-preview' />
    </ScrollArea>
  );
}
