// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import {
  channelsOf,
  isHex,
  normaliseHex,
  OPAQUE_NOTATION,
  readTokenSheet,
  type TokenSheet,
} from "#repo-lint/css-tokens";

/** The one file that defines the design system's values. */
const TOKENS = "packages/web/src/theme/tokens.css";

/** The ratified palette. Seven colours, no more and no fewer. */
const PALETTE = ["red", "orange", "green", "blue", "violet", "pink", "teal"];

/** Which palette colour each semantic status resolves to. */
const STATUS_ALIASES: ReadonlyMap<string, string> = new Map([
  ["selected", "violet"],
  ["info", "blue"],
  ["success", "green"],
  ["warning", "orange"],
  ["error", "red"],
]);

/** How transparent each derived tint is. */
const TINTS: ReadonlyArray<readonly [string, number]> = [
  ["-bg", 14],
  ["-border", 40],
];

/** The brightest a neutral surface may be. */
const BRIGHTEST = 245;
/** The darkest a neutral surface may be. */
const DARKEST = 18;

/**
 * Token families whose values are colours by design and not neutrals.
 *
 * Only three of the guard's seven exemption terms are carried over. The
 * other four were measured dead — removing each leaves the file clean —
 * for two different reasons worth stating separately. `brand`, `shadow`
 * and `destructive` name tokens that either do not start with `--color-`,
 * so they never reach this test, or no longer exist at all.
 * `canvas-grid` is different: `--color-canvas-grid` does start with
 * `--color-` and does reach the test — it passes on its own merits,
 * because both its values are already equal-channel greys. Exempting it
 * would mean a future tint of the dot grid went unreported.
 *
 * An exemption that cannot fire only serves to admit a real violation
 * there later, which is why none of the four is carried over.
 */
const COLOURFUL = /(palette|status|note)/i;

/**
 * Wraps one message as this check's single-finding result.
 *
 * Every branch below reports at most one thing about one token, and spelling
 * the wrapper out at each of them cost more lines than the checks did.
 * @param message What is wrong with the value.
 * @returns A one-element finding list.
 */
function only(message: string): Finding[] {
  return [{ file: TOKENS, message }];
}

/**
 * Checks one token stays neutral and bounded, if it is one this rule owns.
 *
 * A neutral primitive is the source every surface derives from, so a hue in
 * one of them re-tints the whole app; and the ramp stops short of white and
 * black on purpose, because pure white glares and pure black crushes every
 * shadow below it.
 * @param mode Which block the value came from, for the message.
 * @param name The custom property's name.
 * @param value Its declared value.
 * @returns The problem with this value, or nothing.
 */
function checkNeutralToken(
  mode: string,
  name: string,
  value: string,
): Finding[] {
  const isNeutral = name.startsWith("--neutral-");
  const isSurface = name.startsWith("--color-") && !COLOURFUL.test(name);
  if (!isNeutral && !isSurface) return [];

  const channels = channelsOf(value);
  if (channels === null) {
    if (OPAQUE_NOTATION.test(value)) {
      return only(`${mode} ${name}: ${value} — functional notation hides the channels, so nothing can check the value is neutral. Write it as a hex.`);
    }
    if (isNeutral) {
      return only(`${mode} ${name}: ${value} — neutral primitives are plain hex, not a reference or an expression. They are the source every other token derives from.`);
    }
    // A --color-* that defers to a primitive is checked at the primitive.
    return [];
  }

  if (channels.r !== channels.g || channels.g !== channels.b) {
    return only(`${mode} ${name}: ${value} — channels are not equal, so this surface carries a hue. One tinted neutral re-tints every surface in the app.`);
  }
  if (channels.r > BRIGHTEST) {
    return only(`${mode} ${name}: ${value} — brighter than #f5f5f5. Pure white is a glare surface; the ramp stops short of it deliberately.`);
  }
  if (channels.r < DARKEST) {
    return only(`${mode} ${name}: ${value} — darker than #121212. Pure black crushes every shadow below it.`);
  }
  return [];
}

/**
 * Checks every neutral and surface token in both modes.
 * @param sheet The parsed stylesheet.
 * @returns Every problem with a neutral or surface value.
 */
function checkNeutrals(sheet: TokenSheet): Finding[] {
  const modes: ReadonlyArray<readonly [string, ReadonlyMap<string, string>]> = [
    ["light", sheet.light],
    ["dark", sheet.dark],
  ];
  return modes.flatMap(([mode, values]) =>
    [...values].flatMap(([name, value]) =>
      checkNeutralToken(mode, name, value),
    ),
  );
}

/**
 * Checks no palette token exists beyond the ratified seven and their tints.
 * @param sheet The parsed stylesheet.
 * @returns One finding per unexpected palette token.
 */
function checkPaletteMembership(sheet: TokenSheet): Finding[] {
  const expected = new Set(
    PALETTE.flatMap((colour) => [
      `--color-palette-${colour}`,
      `--color-palette-${colour}-bg`,
      `--color-palette-${colour}-border`,
    ]),
  );

  const findings: Finding[] = [];
  for (const name of [...sheet.light.keys(), ...sheet.darkOverrides.keys()]) {
    if (name.startsWith("--color-palette-") && !expected.has(name)) {
      findings.push({
        file: TOKENS,
        message: `${name} is not part of the ratified seven-colour palette. Adding an eighth colour is a design decision, not a token edit.`,
      });
    }
  }
  return findings;
}

/**
 * Checks no palette token is declared where the build removes it.
 *
 * A palette token inside `@theme` is tree-shaken out of the production build,
 * because nothing references it as a utility class. That is not theoretical —
 * the pink border vanished from the built stylesheet once.
 * @param sheet The parsed stylesheet.
 * @returns One finding per palette token declared inside `@theme`.
 */
function checkPalettePlacement(sheet: TokenSheet): Finding[] {
  const declaration = /--color-palette-[a-z0-9-]+\s*:/gi;
  const findings: Finding[] = [];
  for (const match of sheet.source.matchAll(declaration)) {
    const inside = sheet.themeRanges.some(
      ([from, to]) => match.index > from && match.index < to,
    );
    if (!inside) continue;
    findings.push({
      file: TOKENS,
      message: `${match[0].replace(/\s*:$/, "")} is declared inside @theme, where Tailwind tree-shakes it out of the production build because nothing references it as a utility class. Declare palette tokens in :root.`,
    });
  }
  return findings;
}

/**
 * Checks a colour's tints derive from its identity and stay out of dark mode.
 * @param sheet The parsed stylesheet.
 * @param name The identity token, without a tint suffix.
 * @returns Every problem with that colour's derived tints.
 */
function checkPaletteTints(sheet: TokenSheet, name: string): Finding[] {
  const findings: Finding[] = [];
  for (const [suffix, percent] of TINTS) {
    const tint = sheet.light.get(name + suffix);
    const canonical = new RegExp(
      `^color-mix\\(in srgb,\\s*var\\(${name}\\)\\s+${percent}%\\s*,\\s*transparent\\)$`,
    );
    if (tint === undefined || !canonical.test(tint)) {
      findings.push({
        file: TOKENS,
        message: `${name}${suffix} is not the canonical ${percent}% mix of ${name}. Deriving it any other way breaks the rule that dark mode only has to override the seven identities.`,
      });
    }
    if (sheet.darkOverrides.has(name + suffix)) {
      findings.push({
        file: TOKENS,
        message: `${name}${suffix} is re-declared in the dark block. Tints follow their identity automatically; overriding one means dark mode has a value nobody tuned.`,
      });
    }
  }
  return findings;
}

/**
 * Checks one palette colour: both hand-tuned values, and its derived tints.
 * @param sheet The parsed stylesheet.
 * @param colour One of the ratified seven.
 * @returns Every problem with that colour's identity or tints.
 */
function checkPaletteColour(sheet: TokenSheet, colour: string): Finding[] {
  const name = `--color-palette-${colour}`;
  const lightValue = sheet.light.get(name);
  const darkValue = sheet.darkOverrides.get(name);

  const findings: Finding[] = [];
  if (lightValue === undefined || !isHex(lightValue)) {
    findings.push({
      file: TOKENS,
      message: `${name} has no plain hex light value. Each palette colour is hand-tuned per mode, so both values are stated outright.`,
    });
  }
  if (darkValue === undefined || !isHex(darkValue)) {
    findings.push({
      file: TOKENS,
      message: `${name} has no plain hex dark value. Without one the light colour shows through in dark mode, where it was never tuned to read.`,
    });
  }
  if (
    lightValue !== undefined &&
    darkValue !== undefined &&
    isHex(lightValue) &&
    isHex(darkValue) &&
    normaliseHex(lightValue) === normaliseHex(darkValue)
  ) {
    findings.push({
      file: TOKENS,
      message: `${name} is the same colour in both modes. A flattened pair silently kills dark-mode readability — the two values exist because one colour cannot serve both grounds.`,
    });
  }

  findings.push(...checkPaletteTints(sheet, name));
  return findings;
}

/**
 * Checks the palette is exactly the ratified seven, declared where it works.
 *
 * Three separable questions — which tokens exist, where they are declared,
 * and whether each colour's own values hold — kept apart so a reader looking
 * for one of them is not reading the other two.
 * @param sheet The parsed stylesheet.
 * @returns Every structural problem with the palette.
 */
function checkPalette(sheet: TokenSheet): Finding[] {
  return [
    ...checkPaletteMembership(sheet),
    ...checkPalettePlacement(sheet),
    ...PALETTE.flatMap((colour) => checkPaletteColour(sheet, colour)),
  ];
}

/**
 * Checks each status alias points at its palette colour and nothing else.
 * @param sheet The parsed stylesheet.
 * @returns Every alias that is miswired or overridden in dark.
 */
function checkStatusAliases(sheet: TokenSheet): Finding[] {
  const findings: Finding[] = [];
  for (const [status, colour] of STATUS_ALIASES) {
    const wiring: ReadonlyArray<readonly [string, string]> = [
      ["", `var(--color-palette-${colour})`],
      ["-bg", `var(--color-palette-${colour}-bg)`],
      // Text on a tint is the identity itself; the computed foreground the
      // earlier scheme used has been retired.
      ["-foreground", `var(--color-palette-${colour})`],
      ["-border", `var(--color-palette-${colour}-border)`],
    ];
    for (const [suffix, expected] of wiring) {
      const name = `--color-status-${status}${suffix}`;
      const actual = sheet.light.get(name);
      if (actual?.toLowerCase() !== expected) {
        findings.push({
          file: TOKENS,
          message: `${name} is ${actual ?? "missing"}, expected ${expected}. Status names are pure aliases — a status that resolves anywhere else means two sources of truth for one colour.`,
        });
      }
      if (sheet.darkOverrides.has(name)) {
        findings.push({
          file: TOKENS,
          message: `${name} is overridden in the dark block. Aliases follow their palette colour, which already has a dark value.`,
        });
      }
    }
  }
  return findings;
}

/**
 * The design system's values stay neutral, bounded and structurally sound.
 *
 * Three separate ways this file can silently break the product. A hue
 * leaking into the neutral ramp re-tints every surface at once, and it
 * reads as "something looks slightly off" rather than as a bug. A palette
 * token declared inside `@theme` is tree-shaken out of the production
 * build — the pink border really did vanish from dist that way, while
 * every local build looked fine. And a light/dark pair flattened to one
 * value kills dark-mode readability for that colour without changing
 * anything a light-mode reviewer sees.
 *
 * Contrast ratios are deliberately not computed. That was decided on the
 * evidence: the numbers produce pairings that satisfy the arithmetic and
 * look wrong, so the palette is hand-tuned and the maths is not the
 * criterion. The shell version printed a reference table on every run,
 * which is not carried over — nothing gated on it, and a number nobody
 * acts on is noise in a log people need to read.
 */
export const tokenValues = {
  name: "token-values",
  description: "Design tokens stay neutral, bounded and structurally sound",
  run(context: CheckContext): Finding[] {
    if (!context.exists(TOKENS)) {
      throw new Error(
        `${TOKENS} does not exist. This check reads the one file that defines the design system, so its absence is a failure rather than a clean result.`,
      );
    }
    const sheet = readTokenSheet(context.read(TOKENS));
    if (sheet.light.size === 0) {
      throw new Error(
        `${TOKENS} declares no custom properties, so the parse found nothing to check.`,
      );
    }
    return [
      ...checkNeutrals(sheet),
      ...checkPalette(sheet),
      ...checkStatusAliases(sheet),
    ];
  },
} satisfies Check;
