// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The fonts Timeline text clips are drawn with in the preview (inner#1709): the ingest Worker serves
 * the export container's font set; the page registers it once per font set version as `FontFace`s under prefixed family
 * names, shared by every open Timeline, and each text clip loads only the slices its characters need.
 */

import * as React from 'react';
import {
  httpRequest, TIMELINE_TEXT_FONT_FAMILIES, TimelineFontFacesSchema, TimelineFontGlyphsSchema, timelineFontFilesMatch,
} from '@breatic/shared';

/** The prefix that keeps the preview's families apart from the page's own `Inter` (design §2.3). */
const FAMILY_PREFIX = 'Breatic Timeline ';

/** The preview's font stack: every family under its prefix, in fallback order. */
export const TIMELINE_TEXT_FONT_STACK = TIMELINE_TEXT_FONT_FAMILIES.map((family) => `"${FAMILY_PREFIX}${family}"`).join(', ');

/** One slice as the chooser reads it: its real family, its file and the characters it holds. */
export interface TimelineFontSlice { family: string; file: string; glyphRange: string }

/** A text clip's font readiness: failed still draws, in the fallback font. */
export type TimelineTextFontState = 'loading' | 'ready' | 'failed';

const SPACE = 0x20;

/**
 * Parse a CSS `unicode-range` list into inclusive code point ranges.
 * @param range - The list, such as `U+0000-00FF,U+0131,U+4??`.
 * @returns The ranges.
 * @throws {never} Never.
 */
function parseRange(range: string): Array<[number, number]> {
  return range.split(',').flatMap((part): Array<[number, number]> => {
    const match = /^\s*U\+([0-9A-F?]+)(?:-([0-9A-F]+))?\s*$/i.exec(part);
    if (match === null) return [];
    const [, first = '', last] = match;
    if (last !== undefined) return [[Number.parseInt(first, 16), Number.parseInt(last, 16)]];
    return [[Number.parseInt(first.replaceAll('?', '0'), 16), Number.parseInt(first.replaceAll('?', 'F'), 16)]];
  });
}

/**
 * The slice files a text needs (design §5.3): each code point takes the first family in `TIMELINE_TEXT_FONT_FAMILIES`
 * order whose glyph range covers it, and that family's one slice covering it; the slice covering the space is always
 * taken, being the first available font that sets the line height. A code point no family covers takes nothing.
 * @param body - The text.
 * @param slices - The font set's slices with their glyph ranges.
 * @returns The files.
 * @throws {never} Never.
 */
export function timelineTextFontSlices(body: string, slices: readonly TimelineFontSlice[]): ReadonlySet<string> {
  const ordered = TIMELINE_TEXT_FONT_FAMILIES.flatMap((family) => slices.filter((slice) => slice.family === family)
    .map((slice) => ({ file: slice.file, ranges: parseRange(slice.glyphRange) })));
  const chosen = new Set<string>();
  const points = new Set<number>([SPACE]);
  for (const character of body) points.add(character.codePointAt(0)!);
  for (const point of points) {
    const found = ordered.find(({ ranges }) => ranges.some(([from, to]) => point >= from && point <= to));
    if (found !== undefined) chosen.add(found.file);
  }
  return chosen;
}

/** One registered slice and how its load went. */
interface SliceEntry { face: FontFace; state: 'idle' | 'loading' | 'loaded' | 'error' }

/** One font set version, shared page-wide. */
interface FontSetEntry {
  data: 'loading' | 'failed' | readonly TimelineFontSlice[];
  slices: Map<string, SliceEntry>;
}

const sets = new Map<string, FontSetEntry>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Tell every reader the font sets changed.
 * @throws {never} Never.
 */
function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Read one JSON file of the font set.
 * @param url - Its address.
 * @returns Its parsed body.
 * @throws {Error} When it cannot be read.
 */
async function readJson(url: string): Promise<unknown> {
  const response = await httpRequest(url, { method: 'GET' }, { replaySafe: true });
  if (!response.ok) throw new Error(`Font data ${response.status}`);
  return response.json();
}

/**
 * A new face for a slice, under its prefixed family.
 * @param base - The font set's address.
 * @param face - The slice.
 * @param face.family - Its real family.
 * @param face.file - Its file.
 * @param face.glyphRange - The characters it holds.
 * @param face.weight - Its weight range.
 * @returns The face, not loaded.
 * @throws {never} Never.
 */
function newFace(base: string, face: TimelineFontSlice & { weight?: string }): FontFace {
  return new FontFace(`${FAMILY_PREFIX}${face.family}`, `url(${base}${face.file}.woff2)`, {
    unicodeRange: face.glyphRange, ...(face.weight === undefined ? {} : { weight: face.weight }),
  });
}

/**
 * Read `faces.json` and `glyphs.json`, check them and register every slice of the preview's families (design §5.3).
 * @param base - The font set's address.
 * @param entry - Its entry.
 * @throws {never} Never; failure is recorded on the entry.
 */
async function register(base: string, entry: FontSetEntry): Promise<void> {
  try {
    const [faces, glyphs] = await Promise.all([readJson(`${base}faces.json`), readJson(`${base}glyphs.json`)]);
    const parsedFaces = TimelineFontFacesSchema.parse(faces);
    const parsedGlyphs = TimelineFontGlyphsSchema.parse(glyphs);
    if (!timelineFontFilesMatch(parsedFaces, parsedGlyphs)) throw new Error('Font data disagree');
    const families = new Set<string>(TIMELINE_TEXT_FONT_FAMILIES);
    const byFile = new Map(parsedFaces.map((face) => [face.file, face]));
    const slices: TimelineFontSlice[] = [];
    for (const { file, glyphRange } of parsedGlyphs) {
      const face = byFile.get(file)!;
      if (!families.has(face.family)) continue;
      const slice = { family: face.family, file, glyphRange, ...(face.weight === undefined ? {} : { weight: face.weight }) };
      const fontFace = newFace(base, slice);
      document.fonts.add(fontFace);
      entry.slices.set(file, { face: fontFace, state: 'idle' });
      slices.push(slice);
    }
    entry.data = slices;
  } catch {
    entry.data = 'failed';
  }
  changed();
}

/**
 * The entry of a font set version, read and registered the first time it is asked for.
 * @param base - The font set's address.
 * @returns The entry.
 * @throws {never} Never.
 */
function fontSet(base: string): FontSetEntry {
  let entry = sets.get(base);
  if (entry === undefined) {
    entry = { data: 'loading', slices: new Map() };
    sets.set(base, entry);
    void register(base, entry);
  }
  return entry;
}

/**
 * Load one slice once; every clip and preview using it shares the result (design §5.3).
 * @param slice - The slice.
 * @throws {never} Never; failure is recorded on the slice.
 */
function load(slice: SliceEntry): void {
  if (slice.state !== 'idle') return;
  slice.state = 'loading';
  slice.face.load().then(() => { slice.state = 'loaded'; }, () => { slice.state = 'error'; }).finally(changed);
}

/**
 * Try a failed font set again (design §5.3, retry): data that was not read is read again; each failed slice is replaced
 * by a new face, added to the page once it loads, the failed one then deleted.
 * @param base - The font set's address.
 * @throws {never} Never.
 */
export function retryTimelineFonts(base: string): void {
  const entry = sets.get(base);
  if (entry === undefined) return;
  if (entry.data === 'failed') {
    entry.data = 'loading';
    changed();
    void register(base, entry);
    return;
  }
  if (entry.data === 'loading') return;
  for (const slice of entry.data) {
    const current = entry.slices.get(slice.file);
    if (current?.state !== 'error') continue;
    const replacement: SliceEntry = { face: newFace(base, slice), state: 'loading' };
    entry.slices.set(slice.file, replacement);
    replacement.face.load().then(() => {
      document.fonts.add(replacement.face);
      document.fonts.delete(current.face);
      replacement.state = 'loaded';
    }, () => { replacement.state = 'error'; }).finally(changed);
  }
  changed();
}

/**
 * Subscribe to the font sets.
 * @param listener - Called on any change.
 * @returns The release.
 * @throws {never} Never.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The current change count, for `useSyncExternalStore`.
 * @returns The count.
 * @throws {never} Never.
 */
function getVersion(): number {
  return version;
}

/**
 * One text clip's readiness from its chosen slices.
 * @param entry - The font set.
 * @param body - The clip's text.
 * @returns Its state.
 * @throws {never} Never.
 */
function stateOf(entry: FontSetEntry, body: string): TimelineTextFontState {
  if (entry.data === 'loading') return 'loading';
  if (entry.data === 'failed') return 'failed';
  let state: TimelineTextFontState = 'ready';
  for (const file of timelineTextFontSlices(body, entry.data)) {
    const slice = entry.slices.get(file);
    if (slice?.state === 'error') return 'failed';
    if (slice?.state !== 'loaded') state = 'loading';
  }
  return state;
}

/**
 * The font readiness of the text clips a preview draws or premounts (design §5.3, §7.6). Their slices start loading
 * once they are asked for; the font set stays registered when the preview closes.
 * @param base - The font set's address; undefined while the Timeline limits are read, null when they cannot be.
 * @param texts - The text clips by id, with their bodies.
 * @returns Each clip's state.
 * @throws {never} Never.
 */
export function useTimelineTextFonts(base: string | null | undefined, texts: ReadonlyMap<string, string>): ReadonlyMap<string, TimelineTextFontState> {
  const current = React.useSyncExternalStore(subscribe, getVersion);
  React.useEffect(() => {
    if (base === null || base === undefined || texts.size === 0) return;
    const entry = fontSet(base);
    if (typeof entry.data === 'string') return;
    for (const body of texts.values()) for (const file of timelineTextFontSlices(body, entry.data)) {
      const slice = entry.slices.get(file);
      if (slice !== undefined) load(slice);
    }
  }, [base, texts, current]);
  return React.useMemo(() => {
    const entry = base === null || base === undefined ? undefined : sets.get(base);
    return new Map([...texts].map(([clipId, body]): [string, TimelineTextFontState] => [
      clipId, base === null ? 'failed' : entry === undefined ? 'loading' : stateOf(entry, body),
    ]));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `current` is the store's change count.
  }, [base, texts, current]);
}
