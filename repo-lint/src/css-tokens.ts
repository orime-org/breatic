// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A `[start, end)` span of the stylesheet. */
export type Range = readonly [number, number];

/** A stylesheet split into the parts a token check reasons about. */
export interface TokenSheet {
  /** Declarations outside any dark block — the light values. */
  readonly light: ReadonlyMap<string, string>;
  /** Declarations inside dark blocks, which override the light ones. */
  readonly darkOverrides: ReadonlyMap<string, string>;
  /** Light values with the dark overrides applied. */
  readonly dark: ReadonlyMap<string, string>;
  /** Where every `@theme` block sits, for the tree-shake check. */
  readonly themeRanges: readonly Range[];
  /** The stylesheet as given. */
  readonly source: string;
}

/**
 * Finds each block a selector opens, by counting braces.
 *
 * A regex cannot match a balanced block, and a CSS parser would be a
 * dependency for one file, so this counts. It is enough because the sheet
 * is hand-written and has no strings containing braces.
 * @param css The stylesheet.
 * @param selector A pattern matching the selector and its opening brace.
 * @returns One range per block, in source order.
 */
export function blockRanges(css: string, selector: RegExp): Range[] {
  const pattern = new RegExp(selector.source, `${selector.flags}g`);
  const ranges: Range[] = [];
  let match = pattern.exec(css);
  while (match !== null) {
    const open = css.indexOf("{", match.index);
    if (open === -1) break;
    let depth = 0;
    let index = open;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([open, index + 1]);
    pattern.lastIndex = index + 1;
    match = pattern.exec(css);
  }
  return ranges;
}

/**
 * Reads the custom-property declarations out of a chunk of CSS.
 *
 * Later declarations win, which is what the cascade does within one block.
 * @param css A stylesheet or block.
 * @returns Property name to declared value, trimmed.
 */
export function declarations(css: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match = pattern.exec(css);
  while (match !== null) {
    found.set(match[1] ?? "", (match[2] ?? "").trim());
    match = pattern.exec(css);
  }
  return found;
}

/**
 * Splits a token stylesheet into its light and dark halves.
 * @param css The stylesheet.
 * @returns The declarations of each mode and where the theme blocks are.
 */
export function readTokenSheet(css: string): TokenSheet {
  const darkRanges = blockRanges(css, /html\[data-theme=['"]dark['"]\]\s*\{/i);
  const darkCss = darkRanges.map(([from, to]) => css.slice(from, to)).join("\n");

  // Everything that is not inside a dark block is the light half.
  let lightCss = css;
  for (const [from, to] of [...darkRanges].reverse()) {
    lightCss = lightCss.slice(0, from) + lightCss.slice(to);
  }

  const light = declarations(lightCss);
  const darkOverrides = declarations(darkCss);
  return {
    light,
    darkOverrides,
    dark: new Map([...light, ...darkOverrides]),
    themeRanges: blockRanges(css, /@theme\s*\{/i),
    source: css,
  };
}

/** A colour's channels, when they can be read from the declared value. */
export interface Channels {
  /** Red, 0-255. */
  readonly r: number;
  /** Green, 0-255. */
  readonly g: number;
  /** Blue, 0-255. */
  readonly b: number;
}

/** A plain hex colour, three or six digits. */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** An rgb() or rgba() colour, whose channels are as readable as a hex. */
const RGB_FUNCTION =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;

/**
 * Colour notations whose channels cannot be compared directly.
 *
 * `color-mix(` deliberately does not match: the hyphen separates it from
 * `color(`, which is what lets tint formulas through to their own check.
 */
export const OPAQUE_NOTATION = /^(hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;

/**
 * Reads a colour's channels when the notation states them plainly.
 * @param value A declared value.
 * @returns Its channels, or null when the notation hides them.
 */
export function channelsOf(value: string): Channels | null {
  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1] ?? "";
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : digits;
    return {
      r: Number.parseInt(full.slice(0, 2), 16),
      g: Number.parseInt(full.slice(2, 4), 16),
      b: Number.parseInt(full.slice(4, 6), 16),
    };
  }
  const rgb = RGB_FUNCTION.exec(value);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
    };
  }
  return null;
}

/**
 * Whether a value is a plain hex colour.
 * @param value A declared value.
 * @returns True for `#abc` and `#aabbcc`.
 */
export function isHex(value: string): boolean {
  return HEX.test(value);
}

/**
 * Normalises a hex so three- and six-digit spellings compare equal.
 * @param value A plain hex colour.
 * @returns Its six-digit lowercase form, or the input if unreadable.
 */
export function normaliseHex(value: string): string {
  const channels = channelsOf(value);
  if (channels === null) return value.toLowerCase();
  /**
   * Formats one channel as two hex digits.
   * @param n A channel value, 0-255.
   * @returns Its two-digit hex form.
   */
  const pair = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${pair(channels.r)}${pair(channels.g)}${pair(channels.b)}`;
}
