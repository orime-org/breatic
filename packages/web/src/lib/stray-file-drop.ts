// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A file dropped where nothing on the page takes it.
 *
 * The browser's default for a file drop is to open the file in the tab, in
 * place of the app. The places that take files (the canvas, the document
 * body) cancel the drag themselves; this catches the rest of the page — a
 * margin beside the body, the top bar, a dialog — after they had their turn,
 * and shows the pointer that the file cannot land there.
 */

/**
 * Whether a drag carries files from outside the page.
 * @param event - The drag event.
 * @returns True when it does.
 */
export function carriesFiles(event: Event): boolean {
  const { dataTransfer } = event as Partial<DragEvent>;
  return dataTransfer?.types.includes('Files') === true;
}

/**
 * Takes a file drag nothing else took.
 * @param event - A `dragover` or a `drop`.
 */
function takeStray(event: Event): void {
  if (!carriesFiles(event)) return;
  const { dataTransfer } = event as DragEvent;
  if (!event.defaultPrevented && dataTransfer !== null) dataTransfer.dropEffect = 'none';
  event.preventDefault();
}

/**
 * Installs the guard on a window.
 * @param target - The window.
 * @returns The function that takes it off.
 */
export function guardStrayFileDrops(target: Window): () => void {
  target.addEventListener('dragover', takeStray);
  target.addEventListener('drop', takeStray);
  return () => {
    target.removeEventListener('dragover', takeStray);
    target.removeEventListener('drop', takeStray);
  };
}
