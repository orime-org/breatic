// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The prompt editor's dialogue lines (inner#1825 design 8.5, demo
 * `2026-11-10-1825-dialogue-lines`).
 *
 * On the dialogue side of a model whose speakers stand in for its voice, each
 * paragraph of the prompt is one line and carries the number of its speaker
 * in a `speaker` attribute. The line starts with a picker for who says it and
 * ends with an × that deletes it; Enter at the end of a line, like the add
 * line button, starts a line for the other speaker. The editor keeps every
 * line true to {@link planDialogueLines} whatever brought the words in: a
 * user's typing or paste is put right in the same step, so one undo takes
 * both back; what arrives from Yjs (a node written before the lines, a
 * collaborator, an undo) is put right as a machine edit.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Paragraph } from '@tiptap/extension-paragraph';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { SuggestionPluginKey } from '@tiptap/suggestion';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { ChevronDown, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { ySyncPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { dispatchMachineEdit, MACHINE_EDIT_META } from '@web/features/reference-mention/reference-mention-local-input';
import { compositionEnd, type CompositionEnd } from '@web/lib/composition-end';
import { planDialogueLines, type PlanOptions } from '@web/spaces/canvas/generate/dialogue-lines';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** The paragraph attribute holding a line's speaker, from 1. */
export const SPEAKER_ATTR = 'speaker';

/** The palette hue each speaker's dot takes, by speaker. */
const SPEAKER_HUES = ['blue', 'orange', 'green', 'violet', 'pink', 'teal'] as const;

/** Where the dialogue lines read the speakers' names, as the panel shows them now. */
export interface DialogueNames {
  /** The names, from speaker 1. */
  readonly names: () => readonly string[];
  /** Each speaker's voice as the voice list names it, from speaker 1; empty for a speaker with none. */
  readonly voices?: () => readonly string[];
}

/**
 * The colour of a speaker's dot.
 * @param speaker - The speaker, from 1.
 * @returns A palette colour.
 */
export function speakerColour(speaker: number): string {
  return `var(--color-palette-${SPEAKER_HUES[(speaker - 1) % SPEAKER_HUES.length] ?? 'blue'})`;
}

/**
 * The speaker after this one.
 * @param speaker - The speaker, from 1.
 * @param count - How many speakers there are.
 * @returns The next speaker, wrapping round.
 */
export function otherSpeaker(speaker: number, count: number): number {
  return count < 1 ? 1 : (speaker % count) + 1;
}

/**
 * A line's own speaker number.
 * @param node - The paragraph.
 * @returns The number, or null when it holds none.
 */
function speakerOf(node: PmNode): number | null {
  const value = Number(node.attrs[SPEAKER_ATTR]);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * The words a line starts with, up to its first chip.
 * @param node - The paragraph.
 * @returns The leading text.
 */
function leadingText(node: PmNode): string {
  const first = node.firstChild;
  return first?.isText === true ? (first.text ?? '') : '';
}

/**
 * The steps that put every line true: its speaker, and its typed name taken off.
 * @param state - The editor state.
 * @param names - The speakers' names, from speaker 1.
 * @param options - How a typed prefix is read.
 * @returns The transaction holding them, or null when every line is already true.
 */
export function dialogueNormalisation(state: EditorState, names: readonly string[], options: PlanOptions = {}): Transaction | null {
  const lines: Array<{ pos: number; node: PmNode }> = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === 'paragraph') lines.push({ pos, node });
  });
  const plans = planDialogueLines(lines.map(({ node }) => ({ speaker: speakerOf(node), text: leadingText(node) })), names, options);
  const tr = state.tr;
  // From the last line up, so a deletion leaves the earlier positions valid.
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at];
    const plan = plans[at];
    if (line === undefined || plan === undefined) continue;
    if (plan.strip > 0) tr.delete(line.pos + 1, line.pos + 1 + plan.strip);
    if (speakerOf(line.node) !== plan.speaker) tr.setNodeAttribute(line.pos, SPEAKER_ATTR, plan.speaker);
  }
  return tr.docChanged ? tr : null;
}

/**
 * Whether a transaction is the user's own: not Yjs bringing a change in, and
 * not a machine edit.
 * @param tr - The transaction.
 * @returns True for typing, a paste or a command the user ran.
 */
function isUserEdit(tr: Transaction): boolean {
  return tr.getMeta(ySyncPluginKey) === undefined && tr.getMeta(MACHINE_EDIT_META) !== true && tr.getMeta('addToHistory') !== false;
}

/**
 * Starts a line for the other speaker after the one at `pos`.
 * @param editor - The editor.
 * @param after - The position the new line goes at.
 * @param speaker - Who says the line before it.
 * @param count - How many speakers there are.
 * @returns Whether it ran.
 */
function startLine(editor: Editor, after: number, speaker: number, count: number): boolean {
  const paragraph = editor.schema.nodes.paragraph;
  if (paragraph === undefined) return false;
  const tr = editor.state.tr.insert(after, paragraph.create({ [SPEAKER_ATTR]: otherSpeaker(speaker, count) }));
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Appends a line for the speaker after the last line's.
 * @param editor - The editor.
 * @param count - How many speakers there are.
 */
export function addDialogueLine(editor: Editor, count: number): void {
  if (editor.isDestroyed) return;
  const last = editor.state.doc.lastChild;
  const speaker = last?.type.name === 'paragraph' ? (speakerOf(last) ?? 1) : 1;
  startLine(editor, editor.state.doc.content.size, speaker, count);
  editor.view.focus();
}

/**
 * How many lines the editor holds.
 * @param editor - The editor.
 * @returns The count.
 */
function lineCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'paragraph') count += 1;
  });
  return count;
}

/**
 * One line: who says it, the words, and the × that deletes it.
 * @param props - The node view's props.
 * @returns The line.
 */
function DialogueLineView(props: NodeViewProps): React.JSX.Element {
  const { editor, node, updateAttributes, deleteNode, extension } = props;
  const { names: read, voices: readVoices } = extension.options as DialogueNames;
  // Read on every transaction: the panel changing a speaker's name or voice
  // dispatches one with no edit, so a renamed speaker shows at once.
  const { lines, names, voices } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ lines: lineCount(e), names: [...read()], voices: [...(readVoices?.() ?? [])] }),
  });
  const speaker = speakerOf(node) ?? 1;
  const t = useTranslation();
  /**
   * What a speaker is called on screen: the name, or before one is written the
   * row the settings show for that speaker.
   * @param at - The speaker, from 1.
   * @returns The label.
   */
  const label = (at: number): string => names[at - 1]?.trim() || t('canvas.generatePanel.audioSpeakerRow', { n: at });
  // A line with no words says whose it is, drawn by the editors' placeholder
  // rule (index.css) the way the Placeholder extension marks an empty box.
  const empty = node.content.size === 0;
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  return (
    // The band on hover holds the line and its × together; the padding matches
    // the negative margin, so the words stay where they are.
    <NodeViewWrapper className='dialogue-line group -mx-1 flex items-start gap-2 rounded-chrome-sm px-1 py-1 hover:bg-accent'>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type='button'
            variant={null}
            size={null}
            contentEditable={false}
            data-testid='dialogue-line-speaker'
            className='inline-flex h-6 min-w-20 max-w-28 shrink-0 items-center justify-between gap-1 rounded-chrome border border-border bg-background px-1.5 text-xs text-foreground hover-enabled:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-expanded:border-active-border'
          >
            <span className='flex min-w-0 items-center gap-1'>
              <span data-testid='dialogue-line-speaker-dot' className='size-2 shrink-0 rounded-full' style={{ background: speakerColour(speaker) }} />
              <span className='min-w-0 truncate'>{label(speaker)}</span>
            </span>
            <ChevronDown className='size-3 shrink-0 text-muted-foreground' aria-hidden='true' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' avoidCollisions={false} className='w-max'>
          {names.map((_, at) => (
            <DropdownMenuItem
              key={at}
              data-testid={`dialogue-line-speaker-option-${String(at + 1)}`}
              // The line's own speaker reads as held, as a single-choice list's pick does (ChoiceMenu).
              className={cn(at + 1 === speaker && 'bg-accent-strong focus:bg-accent-strong')}
              onSelect={() => updateAttributes({ [SPEAKER_ATTR]: at + 1 })}
            >
              <span className='size-2 shrink-0 rounded-full' style={{ background: speakerColour(at + 1) }} />
              {label(at + 1)}
              {voices[at] ? (
                <span data-testid='dialogue-line-speaker-voice' className='ml-auto pl-4 text-xs text-muted-foreground'>{voices[at]}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <NodeViewContent<'p'>
        as='p'
        className={`min-w-0 flex-1 py-0.5${empty ? ' is-empty' : ''}`}
        {...(empty ? { 'data-placeholder': t('canvas.generatePanel.dialogueLinePlaceholder', { name: label(speaker) }) } : {})}
      />
      {lines > 1 && (
        <Button
          type='button'
          variant={null}
          size={null}
          contentEditable={false}
          data-testid='dialogue-line-remove'
          onClick={() => deleteNode()}
          // The `::after` square takes a press 3px past each side: 18 + 2 * 3 = 24.
          className='relative mt-0.5 shrink-0 rounded-chrome p-0.5 after:absolute after:-inset-[3px] text-muted-foreground opacity-0 transition-opacity hover-enabled:bg-accent group-hover:opacity-100 focus-visible:opacity-100'
        >
          <X className='size-3.5' aria-hidden='true' />
        </Button>
      )}
    </NodeViewWrapper>
  );
}

/**
 * The paragraph with the attribute every prompt editor keeps, so a line's
 * speaker survives an edit on the single side.
 */
export const SpeakerParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [SPEAKER_ATTR]: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute('data-speaker'));
          return Number.isInteger(value) && value >= 1 ? value : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[SPEAKER_ATTR] == null ? {} : { 'data-speaker': String(attributes[SPEAKER_ATTR]) },
      },
    };
  },
});

/** The paragraph as a dialogue line, with its picker and ×. */
export const DialogueParagraph = SpeakerParagraph.extend<DialogueNames>({
  addOptions() {
    return { names: () => [], voices: () => [] };
  },
  addNodeView() {
    return ReactNodeViewRenderer(DialogueLineView);
  },
});

/** The plugin keeping every line true. */
const NORMALISE = new PluginKey('dialogueLines');

/**
 * Keeps the lines true and starts a line for the other speaker on Enter at
 * the end of one. Ahead of the default keymap, which would split the line for
 * the same speaker; an open `@` list keeps its Enter.
 */
export const DialogueLines = Extension.create<DialogueNames, { ended: CompositionEnd }>({
  name: 'dialogueLines',
  priority: 200,
  addOptions() {
    return { names: () => [] };
  },
  // Shared by the Enter binding and the compositionend watcher below.
  addStorage() {
    return { ended: compositionEnd() };
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // The Enter that accepts an input method's candidate is not a new line.
        if (this.storage.ended.justEnded()) return true;
        const { selection } = editor.state;
        const { $from } = selection;
        if ((SuggestionPluginKey.getState(editor.state) as { active?: boolean } | undefined)?.active === true) return false;
        if (!selection.empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false;
        return startLine(editor, $from.after(), speakerOf($from.parent) ?? 1, this.options.names().length);
      },
    };
  },
  addProseMirrorPlugins() {
    const { names } = this.options;
    const { ended } = this.storage;
    // Read by the plugin's handlers; set once its view is made.
    let live: EditorView | null = null;
    let settleNow: (() => void) | null = null;
    return [
      new Plugin<boolean>({
        key: NORMALISE,
        // Whether the last change to the words came in from Yjs (opening, a
        // collaborator, an undo): those are put right by a machine pass.
        state: {
          init: () => true,
          apply: (tr, fromYjs) => (tr.docChanged ? tr.getMeta(ySyncPluginKey) !== undefined : fromYjs),
        },
        props: {
          handleDOMEvents: {
            compositionend: () => {
              ended.mark();
              // The words composed are in now: put the line right once.
              settleNow?.();
              return false;
            },
          },
        },
        // A user's typing waits for the words after a typed name; a paste
        // lands whole, so it is put right at once.
        // Nothing is put right while an input method composes: rewriting the
        // line under it breaks the composition.
        appendTransaction: (transactions, _old, state) =>
          live?.composing !== true && transactions.some((tr) => tr.docChanged) && transactions.every(isUserEdit)
            ? dialogueNormalisation(state, names(), { waitForWords: !transactions.some((tr) => tr.getMeta('uiEvent') === 'paste') })
            : null,
        view: (view) => {
          let pending: ReturnType<typeof setTimeout> | undefined;
          /** Puts the lines right after a change Yjs brought in, once the dispatch it came in is done. */
          const settle = (): void => {
            if (pending !== undefined) return;
            pending = setTimeout(() => {
              pending = undefined;
              const tr = view.isDestroyed || view.composing ? null : dialogueNormalisation(view.state, names());
              if (tr) dispatchMachineEdit(view, tr);
            }, 0);
          };
          live = view;
          settleNow = settle;
          settle();
          return {
            update: (_view, previous) => {
              if (!view.state.doc.eq(previous.doc) && NORMALISE.getState(view.state) === true) settle();
            },
            destroy: () => clearTimeout(pending),
          };
        },
      }),
    ];
  },
});
