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
 * The panel's header is the top of the column and no card may reach it: a
 * card giving way upwards near the top of the body has nowhere to go, and
 * what it would cover is the filter and the close button. The run stacks down
 * from the header instead, which takes the one being read off its anchor —
 * up there that is the only place left (user 2026-09-22).
 *
 * Cards move between one answer and the next rather than appearing at the new
 * one — the panel animates the change, which is what makes giving way read as
 * giving way instead of as the column jumping (user 2026-09-22).
 */

/** One card, and where its words are. */
export interface CardAnchor {
  /** The thread this card is for. */
  readonly id: string;
  /** Where its words are, in the panel's own coordinates. */
  readonly anchor: number;
  /** How tall the card is. */
  readonly height: number;
}

/**
 * Places every card, keeping them clear of each other.
 * @param cards - The cards and their anchors, in any order.
 * @param readingId - The thread being read, which keeps its anchor.
 * @param gap - The space to leave between two cards.
 * @param minTop - How close to the panel's header a card may come.
 * @returns Each card's top, by thread id.
 */
export function layOutCards(
  cards: readonly CardAnchor[],
  readingId: string | null,
  gap: number,
  minTop: number,
): ReadonlyMap<string, number> {
  const inOrder = [...cards].sort((a, b) => a.anchor - b.anchor);
  const placed = new Map<string, number>();
  if (inOrder.length === 0) return placed;

  // Where the run of cards starts from. The one being read is the anchor of
  // the whole column; without one, that is simply the first card.
  const pivot = inOrder.findIndex((card) => card.id === readingId);
  const from = pivot === -1 ? 0 : pivot;

  placed.set(inOrder[from]!.id, inOrder[from]!.anchor);

  // Downwards from the pivot: a card takes its anchor, or the first place
  // below the card before it that clears the gap.
  let below = inOrder[from]!.anchor + inOrder[from]!.height;
  for (let i = from + 1; i < inOrder.length; i += 1) {
    const card = inOrder[i]!;
    const top = Math.max(card.anchor, below + gap);
    placed.set(card.id, top);
    below = top + card.height;
  }

  // Upwards from the pivot, for the cards a read one pushed out of the way.
  let above = inOrder[from]!.anchor;
  for (let i = from - 1; i >= 0; i -= 1) {
    const card = inOrder[i]!;
    const top = Math.min(card.anchor, above - gap - card.height);
    placed.set(card.id, top);
    above = top;
  }

  // Held off the header, and off each other once held. The pass above places
  // the cards in anchor order, so working down that order is enough: each
  // card starts where it was put and comes down only as far as the one before
  // it makes it.
  let floor = minTop;
  for (const card of inOrder) {
    const top = Math.max(placed.get(card.id)!, floor);
    placed.set(card.id, top);
    floor = top + card.height + gap;
  }

  return placed;
}
