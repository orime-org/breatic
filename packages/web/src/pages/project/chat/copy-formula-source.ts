// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hands a reader copying a reply the formula the model wrote.
 *
 * KaTeX draws a formula three times over — MathML for a screen reader, the
 * LaTeX it came from, and the glyphs — so a selection across one serialises
 * two of the three, and the reader gets the formula twice with neither copy
 * readable. Importing this module puts a copy handler on the document that
 * replaces each formula with its own source instead, leaving the MathML in
 * the page where the screen reader still reaches it.
 *
 * KaTeX ships this idea as `katex/contrib/copy-tex`, which cannot be used
 * here: it derives the text from `fragment.textContent`, and `textContent`
 * carries elements the browser never renders. Radix gives every ScrollArea a
 * `style` element of its own, and a reply holding a formula holds at least
 * one ScrollArea — so what that handler puts on the clipboard is the model's
 * words with a stylesheet spliced into them. Its delimiters are also fixed at
 * a single `$` for an inline formula, which this product reads as a character.
 */

/** Both ends of a formula, inline or on a line of its own (user 2026-08-25). */
const DELIMITER = '$$';

/** What KaTeX marks a formula rendered on a line of its own with. */
const DISPLAY_CLASS = 'katex-display';

/** What KaTeX marks any rendered formula with. */
const FORMULA_CLASS = 'katex';

/**
 * The formula this node sits in, if it sits in one.
 * @param node - Where an end of the selection landed.
 * @returns The formula's element, or null.
 */
function formulaAround(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(`.${FORMULA_CLASS}`) ?? null;
}

/**
 * Turn every formula in this copy back into the source it was drawn from.
 * @param fragment - The copied selection, modified in place.
 */
function replaceFormulaeWithSource(fragment: DocumentFragment): void {
  for (const formula of fragment.querySelectorAll(`.${FORMULA_CLASS}`)) {
    // The LaTeX KaTeX kept alongside the MathML it built.
    const source = formula.querySelector('annotation')?.textContent ?? '';
    const onItsOwnLine = formula.closest(`.${DISPLAY_CLASS}`) !== null;
    const holder = document.createElement('span');
    // Source, not prose: the line breaks around a formula on its own line are
    // part of what makes it one, and normal white-space handling would fold
    // them into spaces on the way out.
    holder.style.whiteSpace = 'pre';
    holder.textContent = onItsOwnLine
      ? `${DELIMITER}\n${source}\n${DELIMITER}`
      : `${DELIMITER}${source}${DELIMITER}`;
    formula.replaceWith(holder);
  }
}

document.addEventListener('copy', (event: ClipboardEvent): void => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;

  // A reader who dragged across half a formula meant the formula: half of one
  // is neither readable nor valid source.
  const range = selection.getRangeAt(0);
  const start = formulaAround(range.startContainer);
  if (start) range.setStartBefore(start);
  const end = formulaAround(range.endContainer);
  if (end) range.setEndAfter(end);

  const fragment = range.cloneContents();
  if (!fragment.querySelector(`.${FORMULA_CLASS}`)) return;

  // Neither of these belongs in something a person pastes, and a stylesheet
  // pasted into a rich-text target would apply itself there.
  for (const unrendered of fragment.querySelectorAll('style, script')) unrendered.remove();
  replaceFormulaeWithSource(fragment);

  // Serialising this by hand is what the browser is for: `textContent` knows
  // nothing of block boundaries, table cells or list markers, and markup
  // built by joining text escapes nothing — a reply whose words look like a
  // tag would arrive as a live one. `innerText` reads what was laid out, so
  // the element has to be rendered somewhere out of sight rather than hidden.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:-9999px';
  host.append(fragment);
  document.body.append(host);
  event.clipboardData.setData('text/html', host.innerHTML);
  event.clipboardData.setData('text/plain', host.innerText);
  host.remove();

  event.preventDefault();
});
