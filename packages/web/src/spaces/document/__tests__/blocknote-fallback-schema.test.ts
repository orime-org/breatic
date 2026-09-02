// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 步骤 4 的前半：the three stand-ins exist in the assembled schema.
 *
 * The patched binding finds them by name — `schema.nodes.unsupportedBlock`,
 * `schema.nodes.unsupportedInline`, `schema.marks.unsupportedMark` — so a
 * rename or a missing registration makes the patch fall straight through to
 * the untouched repair below it, which deletes the element from the shared
 * document and broadcasts that deletion. Nothing raises. These assertions are
 * the only thing standing between that and a silent data loss.
 *
 * The mark's two switches are asserted because both are load-bearing and
 * neither is visible from the round-trip tests:
 *
 * - `excludes: ''` — one span of text can carry several unknown marks at once,
 *   which is the only way a round trip can be lossless. The default would let
 *   a second one displace the first.
 * - the non-formatting group — a `plain` block (the code block) allows only
 *   that group, and BlockNote's own FixUpSchema strips marks a node type does
 *   not allow. Without it, an unknown mark inside a code block is dropped.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

/**
 * Builds the schema the way production does, fallbacks included.
 * @returns The assembled ProseMirror schema.
 */
function schemaWithFallbacks(): ReturnType<
  typeof buildDocumentEditor
>['pmSchema'] {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentFallbackExtension()],
  });
  editor.mount(document.createElement('div'));
  return editor.pmSchema;
}

describe('the cross-version fallbacks', () => {
  it('registers a block stand-in the patched binding can find by name', () => {
    const type = schemaWithFallbacks().nodes['unsupportedBlock'];
    expect(type).toBeDefined();
    // `blockContent` is the group a block's own node belongs to; the two
    // container positions are reached by wrapping, not by group membership.
    expect(type?.spec.group).toContain('blockContent');
    expect(type?.spec.atom).toBe(true);
  });

  it('registers an inline stand-in the patched binding can find by name', () => {
    const type = schemaWithFallbacks().nodes['unsupportedInline'];
    expect(type).toBeDefined();
    expect(type?.isInline).toBe(true);
    expect(type?.spec.atom).toBe(true);
  });

  it('registers a mark stand-in that never displaces another mark', () => {
    const type = schemaWithFallbacks().marks['unsupportedMark'];
    expect(type).toBeDefined();
    expect(type?.spec.excludes).toBe('');
  });

  it('puts the mark in the group a code block allows', () => {
    const type = schemaWithFallbacks().marks['unsupportedMark'];
    // A `plain` block allows only this group. The name is asserted literally
    // rather than through the library's constant: reading the constant here
    // would make the assertion agree with whatever the library says today,
    // including a rename that silently drops the mark from code blocks.
    expect(String(type?.spec.group).split(' ')).toContain('annotation');
  });

  it('gives every stand-in the attributes a lossless round trip needs', () => {
    const schema = schemaWithFallbacks();
    expect(
      Object.keys(schema.nodes['unsupportedBlock']?.spec.attrs ?? {}),
    ).toContain('originalName');
    expect(
      Object.keys(schema.nodes['unsupportedInline']?.spec.attrs ?? {}),
    ).toContain('originalName');
    // The mark is the one that gets written back, so it keeps the value too.
    const markAttrs = Object.keys(
      schema.marks['unsupportedMark']?.spec.attrs ?? {},
    );
    expect(markAttrs).toContain('originalName');
    expect(markAttrs).toContain('originalValue');
  });
});
