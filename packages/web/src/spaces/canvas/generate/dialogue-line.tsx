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
import { SuggestionPluginKey } from '@tiptap/suggestion';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { ChevronDown, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { ySyncPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { dispatchMachineEdit, MACHINE_EDIT_META } from '@web/features/reference-mention/reference-mention-local-input';
import { compositionEnd, keyBelongsToInputMethod } from '@web/lib/composition-end';
import { planDialogueLines } from '@web/spaces/canvas/generate/dialogue-lines';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

/** The paragraph attribute holding a line's speaker, from 1. */
export const SPEAKER_ATTR = 'speaker';

/** The palette hue each speaker's dot takes, by speaker. */
const SPEAKER_HUES = ['blue', 'orange', 'green', 'violet', 'pink', 'teal'] as const;

/** Where the dialogue lines read the speakers' names, as the panel shows them now. */
export interface DialogueNames {
  /** The names, from speaker 1. */
  readonly names: () => readonly string[];
}

/**
 * The colour of a speaker's dot.
 * @param speaker - The speaker, from 1.
 * @returns A palette colour.
 */
function speakerColour(speaker: number): string {
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
 * @returns The transaction holding them, or null when every line is already true.
 */
export function dialogueNormalisation(state: EditorState, names: readonly string[]): Transaction | null {
  const lines: Array<{ pos: number; node: PmNode }> = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === 'paragraph') lines.push({ pos, node });
  });
  const plans = planDialogueLines(lines.map(({ node }) => ({ speaker: speakerOf(node), text: leadingText(node) })), names);
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
  const read = (extension.options as DialogueNames).names;
  // Read on every transaction: the panel changing a speaker's name dispatches
  // one with no edit, so a renamed speaker shows at once.
  const { lines, names } = useEditorState({ editor, selector: ({ editor: e }) => ({ lines: lineCount(e), names: [...read()] }) });
  const speaker = speakerOf(node) ?? 1;
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  return (
    <NodeViewWrapper className='group flex items-start gap-1.5 py-0.5'>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type='button'
            variant={null}
            size={null}
            contentEditable={false}
            data-testid='dialogue-line-speaker'
            className='inline-flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-chrome border border-border bg-background px-1.5 text-xs text-foreground hover-enabled:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-expanded:border-active-border'
          >
            <span data-testid='dialogue-line-speaker-dot' className='size-2 shrink-0 rounded-full' style={{ background: speakerColour(speaker) }} />
            <span className='min-w-0 truncate'>{names[speaker - 1] ?? ''}</span>
            <ChevronDown className='size-3 shrink-0 text-muted-foreground' aria-hidden='true' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' avoidCollisions={false} className='w-max'>
          {names.map((name, at) => (
            <DropdownMenuItem
              key={at}
              data-testid={`dialogue-line-speaker-option-${String(at + 1)}`}
              onSelect={() => updateAttributes({ [SPEAKER_ATTR]: at + 1 })}
            >
              <span className='size-2 shrink-0 rounded-full' style={{ background: speakerColour(at + 1) }} />
              {name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <NodeViewContent<'p'> as='p' className='min-w-0 flex-1 py-0.5' />
      {lines > 1 && (
        <Button
          type='button'
          variant={null}
          size={null}
          contentEditable={false}
          data-testid='dialogue-line-remove'
          onClick={() => deleteNode()}
          className='mt-0.5 shrink-0 rounded-chrome p-0.5 text-muted-foreground opacity-0 transition-opacity hover-enabled:bg-accent group-hover:opacity-100 focus-visible:opacity-100'
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
    return { names: () => [] };
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
export const DialogueLines = Extension.create<DialogueNames>({
  name: 'dialogueLines',
  priority: 200,
  addOptions() {
    return { names: () => [] };
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
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
    const ended = compositionEnd();
    return [
      new Plugin({
        key: NORMALISE,
        props: {
          handleDOMEvents: {
            compositionend: () => {
              ended.mark();
              return false;
            },
          },
          // The key that accepts an input method's candidate is not a new line.
          handleKeyDown: (_view, event) => event.key === 'Enter' && keyBelongsToInputMethod(event, ended),
        },
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.docChanged) && transactions.every(isUserEdit) ? dialogueNormalisation(state, names()) : null,
        view: (view) => {
          let pending: ReturnType<typeof setTimeout> | undefined;
          /** Puts the lines right after a change Yjs brought in, once the dispatch it came in is done. */
          const settle = (): void => {
            if (pending !== undefined) return;
            pending = setTimeout(() => {
              pending = undefined;
              const tr = view.isDestroyed ? null : dialogueNormalisation(view.state, names());
              if (tr) dispatchMachineEdit(view, tr);
            }, 0);
          };
          settle();
          return {
            update: (_view, previous) => {
              if (!view.state.doc.eq(previous.doc)) settle();
            },
            destroy: () => clearTimeout(pending),
          };
        },
      }),
    ];
  },
});
