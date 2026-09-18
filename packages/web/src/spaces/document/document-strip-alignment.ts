// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the strip sits against the row it points at (A2).
 *
 * The strip is centred on the row's FIRST VISIBLE LINE, not on the row: a
 * heading is taller than the strip and a wrapped paragraph is several lines
 * tall, and in both cases the handle belongs beside the words the reader is
 * looking at. `SideMenuController` places the carrier with `left-start`, which
 * puts its top edge on the row's top edge, so what this contributes is the
 * distance from there down to the middle of that line.
 *
 * WHY NOT THE LIBRARY'S OWN OFFSET. `SideMenuController` ships a table of
 * constants keyed on block type — 39 for a level-one heading, 27 for level two,
 * 18.5 for level three, 0 for everything else — computed as `(first line
 * height − 30) / 2` for ITS strip, which is 30px tall, against ITS type scale.
 * Ours is 26.5px tall against our own scale, so every entry in that table is
 * wrong here by construction. Measured in a browser on 2026-09-17, the strip
 * stood off the middle of the first line by +36.66px on a level-one heading,
 * −6.94 on level two, −8.48 on level three and +1.81 / +2.22 on paragraphs —
 * the reader's report was that it sat above the line on a heading. The table is
 * replaced rather than adjusted: `floatingUIOptions.useFloatingOptions` is
 * spread after the library's defaults (`SideMenuController.tsx:120-129`), so an
 * empty `middleware` leaves the carrier exactly on the row's top edge and the
 * strip does the rest itself.
 *
 * WHY THE STRIP AND NOT THE CARRIER. The carrier's position reference is a
 * VIRTUAL element — `GenericPopover` hands floating-ui a bare
 * `getBoundingClientRect` (`GenericPopover.tsx:195-200`) — so a middleware has
 * a box to read and no element, and a line box can only be measured on the
 * element the words are in. The row is reached here by its id instead, and the
 * strip shifts itself.
 *
 * Measuring the line rather than tabulating it also means nothing here has to
 * be revisited when the type scale moves, when a block type is added, or when
 * a reader's own font size differs.
 */

import * as React from 'react';

/** The library's table of per-type offsets, replaced by this module. */
export const NO_LIBRARY_OFFSET: {
  useFloatingOptions: { middleware: [] };
} = {
  useFloatingOptions: { middleware: [] },
};

/**
 * How far down from where the carrier was placed the strip has to go.
 *
 * The baseline is the BLOCK CONTAINER's top edge, which is where the carrier
 * lands — `BlockPopover` resolves the block id to that element and hands
 * floating-ui its box. A row's own content element can sit well below it: the
 * space above a block is a margin on the content
 * (`--doc-block-lift`), and a flex parent does not collapse it away, so on a
 * level-two heading the two tops stood 34px apart and on a paragraph after a
 * heading 12.75px (measured 2026-09-17). Taking the content's top as the
 * baseline left exactly those gaps in the alignment.
 * @param firstLine - The box of the row's first line, if it has one.
 * @param carrierTop - The top edge of the block container, in the same
 * coordinates.
 * @param stripHeight - The strip's own height.
 * @returns The distance, zero when the row draws no line to centre on.
 */
export function stripOffsetFromRowTop(
  firstLine: { readonly top: number; readonly height: number } | undefined,
  carrierTop: number,
  stripHeight: number,
): number {
  // A row with no line box to measure — an empty one, or a block whose content
  // is not text — keeps the strip where the placement put it. The height is
  // guarded as well as the box: a collapsed line reports a box of no height,
  // and centring on that would lift the strip by half its own.
  if (firstLine === undefined || firstLine.height <= 0) return 0;
  return firstLine.top + firstLine.height / 2 - stripHeight / 2 - carrierTop;
}

/**
 * The first line box of a row, taken over the words themselves.
 *
 * A RANGE over the content, not the element's own rects: an element's
 * `getClientRects()` answers per line only while it is inline, and the element
 * the words sit in here is block-level (`p`, `h1`…), which returns its whole
 * border box as a single rect. Measured on a paragraph wrapping onto two
 * lines, that box came back 45px tall against the 22.5px of one line, and
 * centring the strip on it put the strip between the two lines. A range's
 * rects are one per line box whatever the element is.
 * @param row - The row's content element.
 * @returns The box, or undefined when the row shows no line.
 */
function firstLineOf(row: Element): DOMRect | undefined {
  const words = row.firstElementChild ?? row;
  const range = document.createRange();
  range.selectNodeContents(words);
  const lines = range.getClientRects();
  // An empty row has no content to range over; its own box is the line the
  // caret stands on, which is what the strip has to meet.
  return lines[0] ?? words.getClientRects()[0];
}

/**
 * The strip's own vertical shift, for the row it currently points at.
 *
 * Measured against the ROW rather than against the strip's current position:
 * the carrier is placed asynchronously (floating-ui's `autoUpdate`), so a
 * correction read off where the strip happens to be right now would be one row
 * behind whenever the two land in the same frame.
 * @param blockId - The row the strip points at, or undefined while none.
 * @param body - The editable element the row lives in.
 * @returns The ref to put on the strip, and the shift to apply to it.
 */
export function useStripOnFirstLine(
  blockId: string | undefined,
  body: HTMLElement | undefined,
): {
  readonly ref: (strip: HTMLDivElement | null) => void;
  readonly offset: number;
} {
  const [offset, setOffset] = React.useState(0);
  // The two watchers outlive a render but not the elements they watch, so they
  // are held here and dropped by the ref below — on detach, and on the way to
  // watching a different row.
  const watching = React.useRef<(() => void) | undefined>(undefined);
  React.useEffect(() => () => watching.current?.(), []);

  // A CALLBACK REF, not an effect: what the measurement waits for is the
  // element being in the document, and React calls this with the node the
  // moment it attaches. An effect keyed on the row would miss it — the strip
  // leaves and comes back on its own (the selection gate in
  // `DocumentBlockHandle`), and measured 2026-09-18 a row pointed at while it
  // was away came back 48.59px off the line, against 0.75px with this. React
  // also calls this again when the identity changes, so a new row re-measures
  // without a second mechanism.
  //
  // AND AN OBSERVER ON THE ROW'S CONTAINER, because attachment is not the only
  // thing this offset depends on: it is a function of the row's own geometry,
  // and the row can change shape while the strip stays attached to it and its
  // identity stays put. Measured 2026-09-18 — a co-editor turning the hovered
  // row into a heading left the handle 6.25px off the line, three times the
  // tolerance A2 is held to, and nothing upstream reports it: the library
  // refreshes its state on a document change (`SideMenu.ts:683-688`) but
  // `updateStateFromMousePos` returns early while the hovered element still
  // carries the same `data-id` (`:229-236`).
  //
  // THE CONTAINER, NOT THE CONTENT ELEMENT. A type change replaces the
  // `.bn-block-content` element and detaches the old one, while the `[data-id]`
  // container survives — measured 2026-09-18 (`containerSame: true`,
  // `rowSame: false`, `rowStillAttached: false`). So the content element can
  // neither be observed nor held in a closure; it is looked up again on every
  // reading.
  //
  // AND A SECOND WATCHER FOR THE CONTAINER ITSELF, because the container is not
  // permanent either: ProseMirror rebuilds a block container when the document
  // around it changes, and this Space's own drop does exactly that — measured
  // 2026-09-18, a move leaves the old `[data-id]` element detached
  // (`movedSame: false`, `movedStillAttached: false`). A `ResizeObserver` left
  // on a detached element never reports again, and nothing else would notice,
  // so the strip would sit at whatever shift it last read.
  const ref = React.useCallback(
    (strip: HTMLDivElement | null) => {
      watching.current?.();
      watching.current = undefined;
      if (strip === null || blockId === undefined || body === undefined) {
        setOffset(0);
        return;
      }
      const selector = `[data-id="${CSS.escape(blockId)}"]`;
      const found = body.querySelector(selector);
      if (found === null) {
        setOffset(0);
        return;
      }
      let container = found;
      /** Reads the row's geometry and stores the shift it asks for. */
      const measure = (): void => {
        const row = container.querySelector('.bn-block-content');
        if (row === null) {
          setOffset(0);
          return;
        }
        setOffset(
          stripOffsetFromRowTop(
            firstLineOf(row),
            container.getBoundingClientRect().top,
            strip.getBoundingClientRect().height,
          ),
        );
      };
      // `ResizeObserver` calls back once on observe, which is the first
      // reading; every reshape after it comes through the same path.
      const shape = new ResizeObserver(measure);
      shape.observe(container);
      /**
       * Points the shape watcher at the element carrying the id right now.
       *
       * A row that leaves the document altogether keeps the last shift: the
       * strip goes with it, because the side menu stops naming a block and
       * this hook is called again with none.
       */
      const followTheRow = (): void => {
        const now = body.querySelector(selector);
        if (now === null || now === container) return;
        container = now;
        shape.disconnect();
        shape.observe(now);
      };
      const rebuilds = new MutationObserver(followTheRow);
      rebuilds.observe(body, { childList: true, subtree: true });
      watching.current = (): void => {
        shape.disconnect();
        rebuilds.disconnect();
      };
    },
    [blockId, body],
  );

  return { ref, offset };
}
