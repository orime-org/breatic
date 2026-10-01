// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where each card sits down the panel (#18, user 2026-09-22).
 *
 * A card belongs beside the words it is about, so the two columns read
 * across: a run commented halfway down the body has its card halfway down the
 * panel, and the gaps between cards are the stretches nobody commented on.
 *
 * Cards are taller than the runs they point at, so two comments a line apart
 * cannot both sit at their anchor. The one being read wins — it keeps its
 * anchor and the others give way around it. That is what CKEditor's sidebar
 * does (its job is stated as positioning annotation views "accordingly to
 * their target elements or Rects") and what the anchored threads in Elves
 * settle on: the active thread has first claim on the space, the rest take a
 * deterministic offset. With nothing being read, the first card keeps its
 * anchor and the rest give way downwards.
 *
 * The panel's header is the top of the column. The card being read never
 * reaches it — covering the filter and the close button would also hide part
 * of the one card being read — so near the top of the body it is held just
 * below the header. The cards ABOVE it are another matter: the one being read
 * stays level with its words, and a card above with no room left goes up
 * under the header (user 2026-09-24). How far the furthest of them was pushed
 * is handed back as `raised`, and the panel lifts its column by up to that
 * much to bring them back ({@link nextLift}, design §9.6.1). With nothing
 * being read, the whole column stays below the header as before.
 *
 * Cards move between one answer and the next rather than appearing at the new
 * one — the panel animates the change, which is what makes giving way read as
 * giving way instead of as the column jumping (user 2026-09-22).
 *
 * A card with no anchor to read across from — one whose words are not
 * measured yet, or a draft whose words are gone — goes below every card that
 * has one, in the order the panel handed them over: anywhere else means on
 * top of a card that does have words.
 */

/** One card, and where its words are. */
export interface CardAnchor {
  /** The thread this card is for. */
  readonly id: string;
  /**
   * Where its words are, in the panel's own coordinates. Null while they are
   * not measured yet, and for a draft whose words are gone.
   */
  readonly anchor: number | null;
  /** How tall the card is. */
  readonly height: number;
}

/** Where the cards sit, and how much room they take. */
export interface Placement {
  /** Each card's top, by thread id. */
  readonly tops: ReadonlyMap<string, number>;
  /**
   * How far down the lowest card reaches, gap included. The cards are out
   * of flow, so the column is given this as its own height or a panel
   * scrolled to the bottom ends above the last card.
   */
  readonly height: number;
  /**
   * The thread ids top-first — the order the last pass below walks them in,
   * which is the order they end up sitting in.
   */
  readonly order: readonly string[];
  /**
   * How far the card pushed furthest above the one being read sits from its
   * words, or 0 when none was pushed. The most the panel lifts its column by.
   */
  readonly raised: number;
  /**
   * The cards the one being read pushed up above their words. Only these
   * are brought back by lifting the column; a card out of sight because the
   * body was scrolled is the browser's to bring into view.
   */
  readonly pushed: ReadonlySet<string>;
}

/**
 * Places every card, keeping them clear of each other.
 * @param cards - The cards and their anchors, in any order.
 * @param readingId - The thread being read, which keeps its anchor.
 * @param gap - The space to leave between two cards.
 * @param minTop - How close to the panel's header a card may come.
 * @returns Each card's top by thread id, and how far down the column the
 *   lowest of them reaches.
 */
export function layOutCards(
  cards: readonly CardAnchor[],
  readingId: string | null,
  gap: number,
  minTop: number,
): Placement {
  const anchored = cards.filter(
    (card): card is CardAnchor & { anchor: number } => card.anchor !== null,
  );
  const adrift = cards.filter((card) => card.anchor === null);
  const inOrder = [...anchored].sort((a, b) => a.anchor - b.anchor);
  const placed = new Map<string, number>();
  if (inOrder.length === 0) {
    let next = minTop;
    for (const card of adrift) {
      placed.set(card.id, next);
      next += card.height + gap;
    }
    return {
      tops: placed,
      height: next,
      order: adrift.map((card) => card.id),
      raised: 0,
      pushed: new Set(),
    };
  }

  // Where the run of cards starts from. The one being read is the anchor of
  // the whole column; without one, that is simply the first card.
  const pivot = inOrder.findIndex((card) => card.id === readingId);
  const from = pivot === -1 ? 0 : pivot;

  // The one being read is never held anywhere but its anchor, except off the
  // header: that is the only place near the top of the body it can be.
  const pivotTop = Math.max(inOrder[from]!.anchor, minTop);
  placed.set(inOrder[from]!.id, pivotTop);

  // Downwards from the pivot: a card takes its anchor, or the first place
  // below the card before it that clears the gap.
  let below = pivotTop + inOrder[from]!.height;
  for (let i = from + 1; i < inOrder.length; i += 1) {
    const card = inOrder[i]!;
    const top = Math.max(card.anchor, below + gap);
    placed.set(card.id, top);
    below = top + card.height;
  }

  // Upwards from the pivot, for the cards a read one pushed out of the way.
  // Nothing holds them off the header: they go under it, and `raised` says
  // how far.
  let above = pivotTop;
  let raised = 0;
  const pushed = new Set<string>();
  for (let i = from - 1; i >= 0; i -= 1) {
    const card = inOrder[i]!;
    const top = Math.min(card.anchor, above - gap - card.height);
    placed.set(card.id, top);
    if (top < card.anchor) pushed.add(card.id);
    raised = Math.max(raised, card.anchor - top);
    above = top;
  }

  // Held off the header, and off each other once held — from the pivot down.
  // With nothing being read the pivot is the first card, so that is all of
  // them. The passes above place the cards in anchor order, so working down
  // that order is enough: each card starts where it was put and comes down
  // only as far as the one before it makes it.
  let floor = minTop;
  const down = [...inOrder, ...adrift];
  for (const card of down.slice(from)) {
    const top = Math.max(placed.get(card.id) ?? floor, floor);
    placed.set(card.id, top);
    floor = top + card.height + gap;
  }

  return {
    tops: placed,
    height: floor,
    order: down.map((card) => card.id),
    raised,
    pushed,
  };
}

/** Where the header's bottom edge and the column are on screen, and the lift. */
export interface HiddenAboveAt {
  /** The header's bottom edge. */
  readonly edge: number;
  /** The column's top, which the cards' tops are measured from. */
  readonly columnTop: number;
  /** How far the column is lifted now. */
  readonly lift: number;
}

/**
 * How far a card the one being read pushed up reaches above the header
 * (design §9.6.1), read from the layout: where the card is going, not where
 * its slide to a new top has got to. The wheel and the focus both ask this.
 * @param placement - The layout.
 * @param id - The card, or null for the most hidden of the pushed cards.
 * @param at - Where the header and the column are, and the lift.
 * @returns How far it is hidden; zero for a card that was not pushed, and
 *   zero or less for one in view.
 */
export function hiddenAbove(
  placement: Placement,
  id: string | null,
  at: HiddenAboveAt,
): number {
  /**
   * How far one card reaches above the header.
   * @param card - The card.
   * @returns The distance.
   */
  const of = (card: string): number =>
    at.edge - (at.columnTop + (placement.tops.get(card) ?? 0) + at.lift);
  if (id !== null) return placement.pushed.has(id) ? of(id) : 0;
  return Math.max(0, ...[...placement.pushed].map(of));
}

/** One wheel turn over the panel, and what it finds there. */
export interface LiftTurn {
  /** How far the column is lifted now. */
  readonly lift: number;
  /** The turn, in pixels; negative is upwards. */
  readonly delta: number;
  /** The most the column may be lifted, from {@link layOutCards}. */
  readonly raised: number;
  /** How far the most hidden of the pushed cards is above the header now. */
  readonly hidden: number;
}

/**
 * Where one wheel turn over the panel leaves its own lift (design §9.6.1).
 *
 * Upwards, the turn first brings back cards hidden under the header, as far
 * as they are hidden and as far as they were pushed; downwards, it first puts
 * the column back. Whatever it does not take goes to the body.
 * @param turn - The lift now, the turn, and the room there is.
 * @returns The lift after it, and whether the panel took the turn.
 */
export function nextLift(turn: LiftTurn): { lift: number; taken: boolean } {
  const { lift, delta, raised, hidden } = turn;
  if (delta < 0) {
    const by = Math.min(-delta, raised - lift, hidden);
    return by > 0 ? { lift: lift + by, taken: true } : { lift, taken: false };
  }
  if (delta > 0 && lift > 0) {
    return { lift: Math.max(lift - delta, 0), taken: true };
  }
  return { lift, taken: false };
}

/**
 * Where the lift goes when the focus lands on a card hidden under the header
 * (design §9.6.1): up by as much as the card is hidden, no further than the
 * cards were pushed.
 * @param show - The lift now, the most it may be, and how far the card is
 *   hidden above the header (zero or less when it is in view).
 * @param show.lift - How far the column is lifted now.
 * @param show.raised - The most it may be lifted, from {@link layOutCards}.
 * @param show.hidden - How far the card reaches above the header.
 * @returns The lift after.
 */
export function liftToReveal(show: {
  lift: number;
  raised: number;
  hidden: number;
}): number {
  const { lift, raised, hidden } = show;
  return lift + Math.max(0, Math.min(hidden, raised - lift));
}

/**
 * The cards in the order the column shows them, top first.
 *
 * Tab order is DOM order, and these cards are positioned out of flow — so
 * whatever order they are written in is the order the keyboard walks them.
 * The panel's own reading runs every unresolved thread before every settled
 * one, while the column mixes the two by where their words are (A9).
 * {@link layOutCards} already walked them in the order they sit; this puts
 * the cards back in that order.
 * @param cards - The cards to order.
 * @param order - The thread ids, top-first, from {@link layOutCards}.
 * @returns The same cards, in the order they sit.
 */
export function inColumnOrder<T extends { readonly id: string }>(
  cards: readonly T[],
  order: readonly string[],
): readonly T[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return order.flatMap((id) => {
    const card = byId.get(id);
    return card === undefined ? [] : [card];
  });
}
