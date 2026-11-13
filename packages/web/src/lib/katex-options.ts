// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How a formula is rendered, in the chat and in the document body alike
 * (inner#1423).
 *
 * Every switch is given a value: leaving one to its default is not a
 * decision, and a later version of the package could change what a default
 * is. `displayMode` and `throwOnError` are absent because each caller owns
 * them: rehype-katex's option type is `Omit<KatexOptions, 'displayMode' |
 * 'throwOnError'>`, and the document body sets both per formula.
 */
export const KATEX_OPTIONS = {
  // KaTeX's own default is a hard-coded #cc0000, which belongs to neither
  // theme. A formula that failed to parse is shown as its LaTeX, said quietly.
  // The grey is what @streamdown/math ships, the package Vercel's Streamdown
  // renders maths with:
  // https://github.com/vercel/streamdown/tree/main/packages/streamdown-math
  errorColor: 'var(--color-muted-foreground)',
  // Seven commands ask this before they run: `\href`, `\url`, the four
  // `\html*` ones and `\includegraphics`. The `\html*` four write a class, an
  // id, a style or a data attribute of the source's choosing into our DOM, and
  // `\includegraphics` sends the browser after a URL of its choosing.
  trust: false,
  // The rest are the values KaTeX runs on with nothing passed, written out
  // because a later version could change what running on nothing means.
  // KaTeX's options page states a default for all of them except `fleqn` and
  // `leqno`, whose entries in its settings schema carry no `default` field;
  // both are read as `if (settings.fleqn)`, so the value below is what an
  // absent one already does.
  // `macros`, `minRuleThickness` and `colorIsTextColor` are absent because
  // they are not switches: KaTeX documents no default for any of the three,
  // and it writes into `macros` — one object shared by every render would
  // carry one formula's `\gdef` into the next one.
  output: 'htmlAndMathml',
  strict: 'warn',
  maxExpand: 1000,
  maxSize: Infinity,
  fleqn: false,
  leqno: false,
  globalGroup: false,
} as const;

/**
 * The classes of the sideways scroller a display formula sits in, in the chat
 * and in the document body alike. A scroller clips what spills past its edges,
 * and KaTeX draws tall glyphs (a fraction's numerator, a brace) a few pixels
 * past its own box; the padding keeps them inside, as a KaTeX maintainer
 * suggests (https://github.com/KaTeX/KaTeX/discussions/2942).
 */
export const DISPLAY_MATH_SCROLLER = '[&_.katex-display]:my-0 [&_.katex]:px-0.5 [&_.katex]:py-[0.25em]';
