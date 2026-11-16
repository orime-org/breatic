// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the browser's editor adds to a column group (inner#1314 design §5.1):
 * the divider between its columns, and the stacking while its container is
 * too narrow. The group's and the column's specs live in
 * `@breatic/shared/document-model`, which builds them with this view here and
 * without it in collab.
 */

import { columnWeight, weightsFit, type DocColumnView } from '@breatic/shared/document-model';

import { attachDivider, type DividerEditor } from '@web/spaces/document/document-column-resize';

/**
 * Marks a group stacked while its container is too narrow to give each of
 * its columns, at its weight, the minimum width.
 * @param element - The group's element.
 */
function markStacked(element: HTMLElement): void {
  const columns = element.querySelectorAll<HTMLElement>(':scope > .doc-columns-row > .doc-column');
  const weights = [...columns].map((column) => columnWeight(column.dataset['width']));
  const fits = weightsFit(element.getBoundingClientRect().width, weights);
  if (fits) delete element.dataset['stacked'];
  else element.dataset['stacked'] = '';
}

/** The column group's view in the browser's editor. */
export const documentColumnView: DocColumnView = {
  attachGroup: (element, row, editor) => {
    const detach = attachDivider(element, row, editor as DividerEditor);
    // The width the group has decides whether its columns stand side by
    // side; a column added or removed is an update of the group.
    const observer = new ResizeObserver(() => markStacked(element));
    observer.observe(element);
    return {
      update: (): void => queueMicrotask(() => markStacked(element)),
      destroy: (): void => {
        observer.disconnect();
        detach();
      },
    };
  },
};
