// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One segment of a message key, as a pattern source both i18n checks build on.
 *
 * The two checks ask opposite questions — does every catalog message have a
 * reader, does every message a source names exist — but they have to agree on
 * what a key looks like, or one would hunt for a shape the other never
 * recognises. It was written out three times before this: twice in the
 * dead-key check and once in the missing-key one.
 *
 * WHAT THIS SHAPE EXCLUDES, and it excludes it from both checks at once:
 *
 * A segment starting with anything but a letter. `locales/en.json` holds
 * exactly one such key, `canvas.nodePlaceholder.3d`; its only reader builds
 * the key by interpolation, so neither check would settle it anyway, but a
 * literal spelling of it would also go unseen. Widening this is a change to
 * both checks and to the paragraph in `docs/ARCHITECTURE.md` that records the
 * gap, so it is a separate piece of work rather than a quiet edit here.
 *
 * A key with no dot in it. Every caller of this joins segments with a dot and
 * requires at least one, because a bare word has no shape to search for: the
 * dead-key check would match `cancel` and `loading` in `z.enum(["confirm",
 * "cancel"])` and `phase === 'loading'` and effectively switch itself off.
 * `i18n-keys-namespaced` is what keeps dotless keys out of the catalogs in the
 * first place; a dotless key at a CALL site is still nobody's to catch.
 */
export const KEY_SEGMENT = String.raw`[a-zA-Z][\w-]*`;
