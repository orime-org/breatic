// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Wiring comments into a document editor (#18, A17).
 *
 * The comment mark has to be in the schema of every document editor, wired
 * for comments or not: `DOCUMENT_SCHEMA_VERSION` is this build's vocabulary,
 * and a mark that came and went with a runtime option would make the
 * vocabulary depend on how the editor happened to be constructed. What does
 * depend on the wiring is who registers it — the library's own extension
 * brings the same mark along, and registering it twice leaves tiptap warning
 * about a duplicate name for the life of the editor.
 *
 * TDD: red because `buildDocumentEditor` has no `comments` option yet.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment } from '@breatic/shared';
import type { ProjectRole } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const built: Editor[] = [];

afterEach(() => {
  built.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/**
 * Builds a document editor, optionally wired for comments.
 * @param role - The role the wiring reads, or undefined for no comments.
 * @returns The editor, mounted.
 */
function open(role?: () => ProjectRole): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments:
      role === undefined
        ? undefined
        : { doc, readWho: () => ({ role: role(), viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  built.push(editor);
  return editor;
}

describe('a document editor wired for comments', () => {
  it('carries the extension the position table lives on', () => {
    const editor = open(() => 'editor');
    expect(editor.getExtension(CommentsExtension)).toBeDefined();
  });

  it('lets a peer role change reach the store as it happens', async () => {
    // The editor is built once per document and outlives a tab switch, while
    // a role does not: somebody demoted mid-session must stop being able to
    // write (A17). The wiring therefore hands the auth a reading rather than
    // a value.
    let role: ProjectRole = 'viewer';
    const editor = open(() => role);
    const store = editor.getExtension(CommentsExtension)!.threadStore;

    await expect(
      store.createThread({ initialComment: { body: [] } }),
    ).rejects.toThrow();

    role = 'editor';
    await expect(
      store.createThread({ initialComment: { body: [] } }),
    ).resolves.toBeDefined();
  });

  it('registers the comment mark once, not once per registrar', () => {
    // Both this build and the library's extension bring `CommentMark`, and
    // tiptap keeps every copy it is handed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    open(() => 'editor');

    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('comment')),
    ).toEqual([]);
  });
});

describe('a document editor with no comments wired', () => {
  it('still knows the comment mark, so the vocabulary does not move', () => {
    const editor = open();
    expect(editor.pmSchema.marks['comment']).toBeDefined();
  });

  it('has no comments extension to reach', () => {
    expect(open().getExtension(CommentsExtension)).toBeUndefined();
  });
});
