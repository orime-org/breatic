// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';

import type { BodyTreeView } from '@breatic/shared';
import { documentBodySource } from '@breatic/shared/document-body';
import type { BodyIndexedUnit, BodyNativePoint, BodyNodePosition } from '@web/spaces/document/document-body-codec-types';
import { bodyTreePoints } from '@web/spaces/document/document-body-tree-points';

/**
 * Indexes native gaps in selected tree order, including a cut's independently moved right side.
 * @param doc - The native source document.
 * @param view - The same complete tree used by the document projection.
 * @param units - The final displayed native occurrences.
 * @param owners - Final visible owner boundaries.
 * @returns Both visible sides of native units and zero-width cuts.
 * @throws {never}
 */
export function bodyNativePoints(
  doc: Y.Doc,
  view: BodyTreeView,
  units: readonly BodyIndexedUnit[],
  owners: ReadonlyMap<string, BodyNodePosition>,
): ReadonlyMap<string, BodyNativePoint> {
  const result = new Map<string, BodyNativePoint>(units.map((unit) => [unit.token, { before: unit.pos, after: unit.pos + unit.width }]));
  const cuts = new Map<string, string>();
  for (const piece of view.pieces.values()) {
    const token = Y.createRelativePositionFromTypeIndex(documentBodySource(doc, piece.source), piece.start - 1).item;
    if (token !== null) cuts.set(piece.cut, `${piece.source}/${token.client}:${token.clock}`);
  }
  for (const [id, point] of bodyTreePoints(view)) {
    const node = view.nodes.get(id);
    if (node?.kind !== 'cut' && node?.kind !== 'right') continue;
    const token = cuts.get(node.cut);
    const owner = owners.get(point.owner);
    if (token !== undefined && owner !== undefined) result.set(token, {
      ...result.get(token), [node.kind === 'cut' ? 'before' : 'after']: owner.contentFrom + point.from,
    });
  }
  return result;
}
