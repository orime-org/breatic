// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Schema, type Node as PMNode } from '@tiptap/pm/model';

import type { BodyInlineUnit } from '@web/spaces/document/document-body-provenance';

export const bodyJournalSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', attrs: { id: { default: null } } },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline', selectable: false },
    chip: { inline: true, group: 'inline', atom: true, attrs: { id: {} } },
  },
  marks: {
    bold: {},
    link: { attrs: { href: {} }, inclusive: false },
    exclusive: { excludes: '_' },
  },
});

/** Builds an independently labelled paragraph fixture. @throws {RangeError} If its content is invalid. */
export function bodyParagraph(id: string, text: string): PMNode {
  return bodyJournalSchema.node('paragraph', { id }, text === '' ? undefined : bodyJournalSchema.text(text));
}

/** Builds a complete journal fixture. @throws {RangeError} If its children violate the schema. */
export function bodyDocument(...blocks: PMNode[]): PMNode {
  return bodyJournalSchema.node('doc', null, blocks);
}

/** Reads an independent input identity oracle from actual inline occurrences. @throws {RangeError} If a position is invalid. */
export function initialBodyUnits(document: PMNode): BodyInlineUnit[] {
  const result: BodyInlineUnit[] = [];
  document.descendants((node, position) => {
    if (!node.isText && !(node.isInline && node.isLeaf)) return;
    const resolved = document.resolve(position);
    let block: string | null = null;
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const id: unknown = resolved.node(depth).attrs['id'];
      if (typeof id === 'string') {
        block = id;
        break;
      }
    }
    const values = node.isText ? node.text!.split('') : [`<${node.type.name}>`];
    values.forEach((value, index) => {
      result.push({
        token: `native:${result.length}`,
        origin: 'existing',
        pos: position + index,
        width: node.isText ? 1 : node.nodeSize,
        value,
        block,
      });
    });
  });
  return result;
}

/** Returns the ordered original labels at current positions. @throws {never} */
export function bodyLabels(units: readonly BodyInlineUnit[]): string[] {
  return units.map((unit) => unit.token);
}
