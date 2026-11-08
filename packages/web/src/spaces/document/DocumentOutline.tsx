// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { ChevronDown, ChevronRight, TableOfContents } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { useDocumentViewStore } from '@web/stores';
import type { ShowableEditor } from '@web/spaces/document/document-editor-cache';
import { viewOf } from '@web/spaces/document/document-editor-view';
import { readOutline, type OutlineEntry } from '@web/spaces/document/document-outline';
import { BODY_GUTTER_END, OUTLINE_WIDTH } from '@web/spaces/document/document-columns';
import { outlineLayout } from '@web/spaces/document/document-outline-layout';
import { useCachedSnapshot } from '@web/spaces/document/use-editor-snapshot';

type Editor = ShowableEditor['editor'];

/** Where a jump leaves a heading's line: this far below the top of the body. */
const LANDING = 16;

/** The heading under this line (the landing plus 8px) is the one being read. */
const READING_LINE = LANDING + 8;

/** How far each level of the tree is indented. */
const INDENT = 12;

/** The fold arrow's column, a 24px target at the start of every row. */
const FOLD_WIDTH = 24;

/** The column open beside the body, and the outline floating over it. */
const OPEN_WIDTH: React.CSSProperties = { width: OUTLINE_WIDTH };

/** The column with only the icon: the same width as the body's right gutter. */
const SHUT_WIDTH: React.CSSProperties = { width: BODY_GUTTER_END };

interface DocumentOutlineProps {
  editor: Editor;
  /** The body's scrolling viewport, once it is mounted. */
  viewport: HTMLElement | null;
  /** True for a viewer: a jump scrolls and leaves the selection alone. */
  readOnly: boolean;
  /** Whether the comment panel is open beside the body; it takes width from the text. */
  commentsOpen: boolean;
}

/** A jump on its way to a heading, until the body arrives or the user takes over. */
interface Jump {
  id: string;
  /** The scrollTop the jump scrolls to. */
  target: number;
  /** The target is the body's end: the heading is pinned on arrival. */
  pinOnArrival: boolean;
  /** How far from the target the jump set off. */
  start: number;
  /** The nearest the body has come to the target so far. */
  closest: number;
}

/** One row on screen: an entry and how deep it hangs. */
interface Row {
  entry: OutlineEntry;
  depth: number;
}

/**
 * Whether two outlines read the same, so an edit that touches no heading
 * keeps the list as it was.
 * @param a - One outline.
 * @param b - The other.
 * @returns Whether they match entry for entry.
 */
function sameOutline(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i]!;
    return x.id === y.id && x.level === y.level && x.text === y.text && x.number === y.number && sameOutline(x.children, y.children);
  });
}

/**
 * The rows on screen: every entry, less those under a folded one.
 * @param entries - The tree.
 * @param folded - Ids of the folded entries.
 * @param depth - How deep these entries hang.
 * @param out - Where rows are collected.
 * @returns The rows, top to bottom.
 */
function rowsOf(entries: readonly OutlineEntry[], folded: ReadonlySet<string>, depth = 0, out: Row[] = []): Row[] {
  for (const entry of entries) {
    out.push({ entry, depth });
    if (!folded.has(entry.id)) rowsOf(entry.children, folded, depth + 1, out);
  }
  return out;
}

/**
 * Every entry with the ids of the entries above it.
 * @param entries - The tree.
 * @param above - The ids of the entries these hang under.
 * @param out - Where entries are collected, in reading order.
 * @returns Each entry's id with its ancestors' ids, outermost first.
 */
function lineage(entries: readonly OutlineEntry[], above: readonly string[] = [], out: [string, readonly string[]][] = []): [string, readonly string[]][] {
  for (const entry of entries) {
    out.push([entry.id, above]);
    lineage(entry.children, [...above, entry.id], out);
  }
  return out;
}

/**
 * A heading's own line in the body: the block's content, not the block, whose
 * box takes in the space above the heading.
 * @param viewport - The body's viewport.
 * @param id - The heading's block id.
 * @returns The element, or null when the block is not on the page.
 */
function headingLine(viewport: HTMLElement, id: string): HTMLElement | null {
  const block = viewport.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
  return block?.querySelector<HTMLElement>(':scope > .bn-block > .bn-block-content') ?? block ?? null;
}

/**
 * Whether a scroll position is the body's end, give or take 2px.
 * @param viewport - The body's scrolling viewport.
 * @param top - The scroll position; the current one by default.
 * @returns True at the end.
 */
function atEnd(viewport: HTMLElement, top = viewport.scrollTop): boolean {
  return top + viewport.clientHeight >= viewport.scrollHeight - 2;
}

/**
 * Where the body scrolls to for a heading: its line at the landing, or the
 * body's end when too little follows it.
 * @param viewport - The body's scrolling viewport.
 * @param id - The heading's block id.
 * @returns The scrollTop, or null when the heading is not on the page.
 */
function landingFor(viewport: HTMLElement, id: string): number | null {
  const line = headingLine(viewport, id);
  if (line === null) return null;
  const want = viewport.scrollTop + line.getBoundingClientRect().top - viewport.getBoundingClientRect().top - LANDING;
  return Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, want));
}

/**
 * Starts a smooth scroll to a heading's landing.
 * @param viewport - The body's scrolling viewport.
 * @param id - The heading's block id.
 * @param target - Its landing, from `landingFor`.
 * @returns The jump, measured from where the body is now.
 */
function launch(viewport: HTMLElement, id: string, target: number): Jump {
  const distance = Math.abs(target - viewport.scrollTop);
  viewport.scrollTo({ top: target, behavior: 'smooth' });
  return { id, target, pinOnArrival: atEnd(viewport, target), start: distance, closest: distance };
}

/**
 * One heading in the list: the fold arrow beside the heading's own button.
 * @param root0 - Row props.
 * @param root0.row - The entry and its depth.
 * @param root0.active - Whether it is the heading being read.
 * @param root0.folded - Whether the headings under it are hidden.
 * @param root0.onFold - Folds or unfolds it.
 * @param root0.onJump - Jumps to it.
 * @returns The row.
 */
const OutlineRow = React.memo(function OutlineRow({
  row,
  active,
  folded,
  onFold,
  onJump,
}: {
  row: Row;
  active: boolean;
  folded: boolean;
  onFold: (id: string) => void;
  onJump: (id: string) => void;
}): React.JSX.Element {
  const { entry, depth } = row;
  const label = React.useRef<HTMLSpanElement>(null);
  // Only a heading cut short gets its whole text on hover; whether it is cut
  // depends on the column's width and the words at the moment it opens.
  const [tip, setTip] = React.useState(false);
  const openTip = React.useCallback((open: boolean) => {
    const el = label.current;
    setTip(open && el !== null && el.scrollWidth > el.clientWidth);
  }, []);
  const jump = React.useCallback(() => onJump(entry.id), [onJump, entry.id]);
  const fold = React.useCallback(() => onFold(entry.id), [onFold, entry.id]);
  const jumpStyle = React.useMemo(() => ({ paddingLeft: depth * INDENT + FOLD_WIDTH }), [depth]);
  const foldStyle = React.useMemo(() => ({ left: depth * INDENT, width: FOLD_WIDTH }), [depth]);
  return (
    <div
      data-outline-item=''
      className={cn('group relative flex h-7 items-center rounded-chrome hover:bg-accent', active && 'bg-accent-strong hover:bg-accent-strong')}
    >
      <Tooltip open={tip} onOpenChange={openTip}>
        <TooltipTrigger asChild>
          <Button
            variant={null}
            size={null}
            data-testid='doc-outline-row'
            data-outline-id={entry.id}
            // The whole row jumps, its indent included; the arrow sits over its
            // own column at the start. `Button` centres and sets a medium weight
            // on everything it draws; a row's words start after that column, and
            // only the one being read is medium and in the full foreground colour.
            // Its words change in the same frame as the row's fill: during a
            // jump the highlight rests on a row for only a few frames.
            className={cn(
              'flex h-full w-full min-w-0 items-center justify-start gap-1.5 pr-2 text-left text-sm transition-none',
              active ? 'font-medium text-foreground' : 'font-normal text-foreground-secondary',
            )}
            style={jumpStyle}
            onClick={jump}
          >
            {entry.number !== null && (
              <span className={cn('flex-none tabular-nums', active ? 'text-foreground-secondary' : 'text-muted-foreground group-hover:text-foreground-secondary')}>
                {entry.number}
              </span>
            )}
            <span ref={label} className='min-w-0 truncate'>{entry.text}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side='right'>{entry.text}</TooltipContent>
      </Tooltip>
      {entry.children.length > 0 && (
        <Button
          variant={null}
          size={null}
          data-testid='doc-outline-fold'
          className='absolute inset-y-0 flex items-center justify-center text-muted-foreground hover-enabled:text-foreground [&_svg]:size-3.5'
          style={foldStyle}
          onClick={fold}
        >
          {folded ? <ChevronRight /> : <ChevronDown />}
        </Button>
      )}
    </div>
  );
});

/**
 * The heading outline beside the document body (inner#1149): an icon at the
 * top left that opens and shuts it, mirroring the whole-document entry on the
 * right, and the body's level 1–3 headings as a tree under it. Where the
 * Space is too narrow to give it a column it floats over the body instead,
 * and tucks itself away after a jump so the heading shows (A17).
 * @param root0 - Outline props.
 * @param root0.editor - The editor whose document it lists.
 * @param root0.viewport - The body's scrolling viewport.
 * @param root0.readOnly - True for a viewer.
 * @param root0.commentsOpen - Whether the comment panel is open.
 * @returns The outline column.
 */
export const DocumentOutline = React.memo(function DocumentOutline({
  editor,
  viewport,
  readOnly,
  commentsOpen,
}: DocumentOutlineProps): React.JSX.Element {
  const t = useTranslation();
  const visible = useDocumentViewStore((s) => s.outlineVisible);
  const toggleOutline = useDocumentViewStore((s) => s.toggleOutline);

  const column = React.useRef<HTMLElement>(null);
  const [spaceWidth, setSpaceWidth] = React.useState(0);
  React.useEffect(() => {
    const space = column.current?.parentElement;
    if (space === null || space === undefined) return undefined;
    setSpaceWidth(space.getBoundingClientRect().width);
    const sizes = new ResizeObserver((entries) => {
      const mine = entries.find((e) => e.target === space);
      if (mine !== undefined) setSpaceWidth(mine.contentRect.width);
    });
    sizes.observe(space);
    return () => sizes.disconnect();
  }, []);
  const floating = outlineLayout({ spaceWidth, commentsOpen }) === 'floating';

  // Floating, a jump tucks the outline away so the heading and the caret
  // show; the remembered setting stays as it was. A tuck means something only
  // while the outline floats and is shown: tiling, or the setting turned off
  // from another document, drops it.
  const [tucked, setTucked] = React.useState(false);
  if (tucked && !(floating && visible)) setTucked(false);
  const open = visible && !tucked;
  const onToggle = React.useCallback(() => {
    if (tucked) setTucked(false);
    else toggleOutline();
  }, [tucked, toggleOutline]);

  const subscribe = React.useCallback((onChange: () => void) => editor.onChange(onChange) ?? (() => undefined), [editor]);
  const read = React.useCallback(() => readOutline(editor.prosemirrorState.doc), [editor]);
  const outline = useCachedSnapshot(subscribe, read, sameOutline);

  const [folded, setFolded] = React.useState<ReadonlySet<string>>(() => new Set());
  const onFold = React.useCallback((id: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const ancestors = React.useMemo(() => new Map(lineage(outline)), [outline]);
  // A folded heading that was deleted leaves the set, so undoing the deletion
  // brings it back unfolded (design §6.6).
  if ([...folded].some((id) => !ancestors.has(id))) setFolded(new Set([...folded].filter((id) => ancestors.has(id))));
  const rows = React.useMemo(() => rowsOf(outline, folded), [outline, folded]);

  const [reading, setReading] = React.useState<string | null>(null);
  const pinned = React.useRef<string | null>(null);
  const jump = React.useRef<Jump | null>(null);
  // Hiding the Space runs every effect's cleanup; the highlight effect also
  // re-runs on any outline change, which must not drop a jump mid-scroll.
  React.useEffect(() => () => {
    jump.current = null;
  }, []);
  React.useEffect(() => {
    if (viewport === null) return undefined;
    const ids = [...ancestors.keys()];
    let frame = 0;
    /**
     * Marks the last heading whose line has reached the reading line; at the
     * bottom, the lowest heading in view; while a jump is pinned, that one.
     * A pin lasts while the body stays at its end and the heading is there.
     * A jump in flight ends once the body arrives, pinning its heading when it
     * aimed at the end, or once the body, having closed in, moves away.
     */
    const compute = (): void => {
      frame = 0;
      const flight = jump.current;
      if (flight !== null) {
        const distance = Math.abs(viewport.scrollTop - flight.target);
        if (flight.pinOnArrival ? atEnd(viewport) : distance < 1) {
          if (flight.pinOnArrival) pinned.current = flight.id;
          jump.current = null;
        } else if (distance < flight.closest) {
          flight.closest = distance;
        } else if (distance > flight.closest && flight.closest < flight.start) {
          // Moving away after closing in is the user taking over. The first
          // frames may still carry the body's earlier momentum away from the
          // landing (a smooth scroll that retargets keeps its velocity).
          jump.current = null;
        }
      }
      if (pinned.current !== null && ancestors.has(pinned.current) && atEnd(viewport)) {
        setReading(pinned.current);
        return;
      }
      pinned.current = null;
      const top = viewport.getBoundingClientRect().top;
      const lines = ids.map((id) => [id, headingLine(viewport, id)?.getBoundingClientRect().top] as const);
      let current: string | null = null;
      for (const [id, at] of lines) if (at !== undefined && at <= top + READING_LINE) current = id;
      if (viewport.scrollHeight > viewport.clientHeight && atEnd(viewport)) {
        const inView = lines.filter(([, at]) => at !== undefined && at >= top && at < top + viewport.clientHeight);
        if (inView.length > 0) current = inView[inView.length - 1]![0];
      }
      setReading(current);
    };
    /** Recomputes once per frame. */
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(compute);
    };
    /**
     * Aims a jump in flight again once the body changes height: Chrome keeps a
     * running smooth scroll on its old target when content above it grows.
     */
    const reaim = (): void => {
      const flight = jump.current;
      if (flight === null) return;
      const target = landingFor(viewport, flight.id);
      if (target !== null && Math.abs(target - flight.target) >= 1) jump.current = launch(viewport, flight.id, target);
    };
    /**
     * Ends a jump once the body stops, after reading where it stopped: typing
     * that scrolls the caret into view, or a scrollbar let go, stops it short.
     */
    const settled = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame);
      compute();
      jump.current = null;
    };
    // The comment panel sits in the same scroller: opening it rewraps the
    // text without changing the viewport's size, so the content is watched too.
    const sizes = new ResizeObserver(() => {
      reaim();
      schedule();
    });
    sizes.observe(viewport);
    const content = viewport.querySelector('.doc-body-editor');
    if (content !== null) sizes.observe(content);
    viewport.addEventListener('scroll', schedule, { passive: true });
    viewport.addEventListener('scrollend', settled);
    compute();
    return () => {
      viewport.removeEventListener('scroll', schedule);
      viewport.removeEventListener('scrollend', settled);
      sizes.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [viewport, ancestors]);

  // A heading hidden under a fold is shown by its nearest visible ancestor.
  const shownReading = React.useMemo(() => {
    if (reading === null) return null;
    const onScreen = new Set(rows.map((r) => r.entry.id));
    if (onScreen.has(reading)) return reading;
    return [...(ancestors.get(reading) ?? [])].reverse().find((id) => onScreen.has(id)) ?? null;
  }, [reading, rows, ancestors]);

  const [list, setList] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (list === null || shownReading === null) return;
    const el = list.querySelector(`[data-outline-id="${CSS.escape(shownReading)}"]`);
    if (el === null) return;
    const at = el.getBoundingClientRect();
    const frame = list.getBoundingClientRect();
    if (at.top < frame.top) list.scrollTo({ top: list.scrollTop - (frame.top - at.top) });
    else if (at.bottom > frame.bottom) list.scrollTo({ top: list.scrollTop + (at.bottom - frame.bottom) });
  }, [list, shownReading]);

  const onJump = React.useCallback((id: string) => {
    if (viewport === null) return;
    if (headingLine(viewport, id) === null) return;
    // The caret goes in before the measuring: a browser that scrolls a new
    // selection into view does so first, and the smooth scroll carries on from there.
    if (!readOnly) {
      editor.setTextCursorPosition(id, 'start');
      viewOf(editor)?.dom.focus({ preventScroll: true });
    }
    const target = landingFor(viewport, id);
    if (target === null) return;
    // On the way the highlight follows the body. A jump that ends at the
    // body's end (a body too short to scroll always is) can leave the heading
    // short of the landing, where the reading rule picks another, so the
    // clicked heading holds from the frame the body reaches the end until it
    // leaves it; scroll anchoring keeps it there when content above grows.
    const flight = launch(viewport, id, target);
    const still = flight.start < 1;
    jump.current = still ? null : flight;
    pinned.current = still && flight.pinOnArrival ? id : null;
    if (still) setReading(id);
    if (floating) setTucked(true);
  }, [viewport, readOnly, editor, floating]);

  const over = floating && open;
  return (
    <aside
      ref={column}
      data-testid='doc-outline-column'
      data-layout={floating ? 'floating' : 'tiled'}
      className='relative flex min-h-0 flex-none flex-col'
      style={open && !floating ? OPEN_WIDTH : SHUT_WIDTH}
    >
      {/* One element tree for both layouts, only its classes change, so the
          list and its folds survive the switch. Floating, it sits over the
          gutter where the block and table handles are drawn (z-20). */}
      <div
        data-testid={over ? 'doc-outline-float' : undefined}
        className={cn(
          'flex min-h-0 flex-col',
          over ? 'absolute inset-y-0 left-0 z-30 bg-background/70 shadow-md backdrop-blur-sm' : 'flex-1',
        )}
        style={over ? OPEN_WIDTH : undefined}
      >
        <div className='flex flex-none pb-2 pl-[var(--doc-entry-inset)] pt-5'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='ghost'
                size='icon'
                data-testid='doc-outline-toggle'
                data-state={open ? 'on' : 'off'}
                aria-label={open ? t('spaces.document.outline.hide') : t('spaces.document.outline.show')}
                className={cn('size-[var(--doc-entry-size)]', open && 'bg-accent')}
                onClick={onToggle}
              >
                <TableOfContents className='h-4 w-4' />
              </Button>
            </TooltipTrigger>
            <TooltipContent side='right'>{open ? t('spaces.document.outline.hide') : t('spaces.document.outline.show')}</TooltipContent>
          </Tooltip>
        </div>
        {open && (
          <ScrollArea viewportRef={setList} className='min-h-0 flex-1' data-testid='doc-outline'>
            <div className='flex flex-col gap-0.5 px-1.5 pb-4'>
              {rows.length === 0 ? (
                <p className='px-4 py-7 text-center text-sm leading-relaxed text-balance text-muted-foreground'>{t('spaces.document.outline.empty')}</p>
              ) : (
                rows.map((row) => (
                  <OutlineRow
                    key={row.entry.id}
                    row={row}
                    active={row.entry.id === shownReading}
                    folded={folded.has(row.entry.id)}
                    onFold={onFold}
                    onJump={onJump}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </aside>
  );
});
