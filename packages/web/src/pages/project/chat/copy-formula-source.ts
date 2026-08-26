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
 * `style` element of its own, and a formula on a line of its own is drawn
 * inside one — so what that handler puts on the clipboard is the model's
 * words with a stylesheet spliced into them. Its delimiters are also fixed at
 * a single `$` for an inline formula, which this product reads as a character.
 */

/** Both ends of a formula, inline or on a line of its own (user 2026-08-25). */
const DELIMITER = '$$';

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
 * @param copied - The copied selection, modified in place.
 */
function replaceFormulaeWithSource(copied: Element): void {
  for (const formula of copied.querySelectorAll(`.${FORMULA_CLASS}`)) {
    // The LaTeX KaTeX kept alongside the MathML it built.
    const source = formula.querySelector('annotation')?.textContent ?? '';
    // Read off the formula, which is all a copy of one holds: the block it
    // stood in is not cloned when the reader drags across the formula alone.
    // KaTeX writes MathML's own way of saying it, and leaves the attribute
    // off an inline formula.
    const onItsOwnLine = formula.querySelector('math')?.getAttribute('display') === 'block';
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

  // Serialising this by hand is what the browser is for: `textContent` knows
  // nothing of block boundaries, table cells or list markers, and markup
  // built by joining text escapes nothing — a reply whose words look like a
  // tag would arrive as a live one. `innerText` reads what was laid out, so
  // the element has to be rendered somewhere out of sight rather than hidden.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:-9999px';

  // Gecko makes a selection of several ranges out of a ctrl-drag, and all of
  // them are what the reader asked for. Two of them can cut through the same
  // formula, which the widening below would then hand over twice, so each one
  // is taken by whichever range reaches it first.
  const taken = new Set<Element>();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    // A reader who dragged across half a formula meant the formula: half of
    // one is neither readable nor valid source. The widening is done on a
    // copy, so what stays highlighted is what the reader drew.
    const range = selection.getRangeAt(index).cloneRange();
    const start = formulaAround(range.startContainer);
    const end = formulaAround(range.endContainer);
    // Both ends read before either is recorded: one range can begin and end
    // inside the same formula, and that formula is its own to take.
    const startTaken = start !== null && taken.has(start);
    const endTaken = end !== null && taken.has(end);
    if (start) {
      if (startTaken) range.setStartAfter(start);
      else {
        range.setStartBefore(start);
        taken.add(start);
      }
    }
    if (end) {
      if (endTaken) range.setEndBefore(end);
      else {
        range.setEndAfter(end);
        taken.add(end);
      }
    }
    host.append(range.cloneContents());
  }

  if (!host.querySelector(`.${FORMULA_CLASS}`)) return;

  // Neither of these belongs in something a person pastes, and a stylesheet
  // pasted into a rich-text target would apply itself there.
  for (const unrendered of host.querySelectorAll('style, script')) unrendered.remove();
  replaceFormulaeWithSource(host);

  document.body.append(host);
  event.clipboardData.setData('text/html', host.innerHTML);
  event.clipboardData.setData('text/plain', host.innerText);
  host.remove();

  event.preventDefault();
});
