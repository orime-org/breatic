// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The formatting commands, and nothing about where they are shown.
 *
 * They live apart from any carrier so that the block handle menu and the
 * insert menu can reach them without importing the selection bubble bar. The
 * ruling routes a command by the object it acts on (menu-system ruling §9.1 —
 * one object may have several entry points), so more than one carrier will
 * legitimately show some of these; kept inside one of them, the others would
 * carry a dependency that does not exist. No carrier owns the commands.
 *
 * What these commands DO is untouched by the document slices — the editing
 * feature set is separate work — and three things about how they do it changed
 * when the document became shared:
 *
 * 1. A viewer never reaches them: the bubble bar is the only thing that shows
 *    them today, and it renders nothing at all for a viewer. Before, everyone
 *    who opened the document could use them, because it was theirs alone.
 * 2. Their pressed state is subscribed rather than read during render. A
 *    co-editor's change arrives with no React render behind it, so a value
 *    computed in the render body would show whatever was true last time the
 *    button happened to re-render.
 * 3. Their labels go through i18n, where they were hard-coded English.
 */

import {
  Bold,
  Code,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline,
} from 'lucide-react';

import type { ToolDef } from '@web/spaces/document/document-tool-button';

/** The four marks the demo groups together as `B I S U`. */
export const MARK_TOOLS: ToolDef[] = [
  {
    id: 'bold',
    labelKey: 'spaces.document.commands.bold',
    Icon: Bold,
    isActive: (e) => e.isActive('bold'),
    canRun: (e) => e.can().chain().toggleBold().run(),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    labelKey: 'spaces.document.commands.italic',
    Icon: Italic,
    isActive: (e) => e.isActive('italic'),
    canRun: (e) => e.can().chain().toggleItalic().run(),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'strike',
    labelKey: 'spaces.document.commands.strike',
    Icon: Strikethrough,
    isActive: (e) => e.isActive('strike'),
    canRun: (e) => e.can().chain().toggleStrike().run(),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    id: 'underline',
    labelKey: 'spaces.document.commands.underline',
    Icon: Underline,
    isActive: (e) => e.isActive('underline'),
    canRun: (e) => e.can().chain().toggleUnderline().run(),
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
];

/**
 * The group the demo draws between `B I S U` and the AI entry.
 *
 * Inline code sits here rather than beside the other marks because that is
 * where the demo puts it (`§3.3` reads `B I S U │ link code A∨ comment`).
 * Neither the demo nor the design says why, so this comment does not invent a
 * reason: the grouping is the decision, and the slices that follow fill the
 * group out with the link control and the colour picker.
 */
export const INLINE_TOOLS: ToolDef[] = [
  {
    id: 'code',
    labelKey: 'spaces.document.commands.code',
    Icon: Code,
    isActive: (e) => e.isActive('code'),
    canRun: (e) => e.can().chain().toggleCode().run(),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
];

/**
 * Block-level formatting.
 *
 * These ask the dry run and nothing else, exactly as the marks above do. The
 * dry run is conservative for the two list commands — they clear the block
 * type before wrapping, and a dry run performs no steps, so over a body
 * heading or code block it answers no while the command works. That belongs to
 * the slice that owns the body's editing behaviour (#85); a dark button that
 * would have worked is the direction R7 permits.
 *
 * Two attempts to widen the answer past the dry run are what this reverts.
 * The second lit the list buttons over a selection where pressing one
 * stripped a body heading to a paragraph and produced no list, because the
 * clearing step lands even when the wrap that follows it fails.
 */
export const BLOCK_TOOLS: ToolDef[] = [
  {
    id: 'bullet-list',
    labelKey: 'spaces.document.commands.bulletList',
    Icon: List,
    isActive: (e) => e.isActive('bulletList'),
    canRun: (e) => e.can().chain().toggleBulletList().run(),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    labelKey: 'spaces.document.commands.orderedList',
    Icon: ListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    canRun: (e) => e.can().chain().toggleOrderedList().run(),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'quote',
    labelKey: 'spaces.document.commands.quote',
    Icon: Quote,
    isActive: (e) => e.isActive('blockquote'),
    canRun: (e) => e.can().chain().toggleBlockquote().run(),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];
