// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { annotationRights } from '@web/spaces/canvas/annotation/rights';

const AUTHOR = 'u-author';
const SOMEONE_ELSE = 'u-other';

describe('who may do what to an annotation or a reply', () => {
  it('lets an editor write, and lets them touch only their own', () => {
    const own = annotationRights({
      role: 'editor',
      viewerId: AUTHOR,
      authorId: AUTHOR,
    });
    expect(own).toEqual({ canEdit: true, canDelete: true });

    const theirs = annotationRights({
      role: 'editor',
      viewerId: SOMEONE_ELSE,
      authorId: AUTHOR,
    });
    expect(theirs).toEqual({ canEdit: false, canDelete: false });
  });

  it('lets an owner delete anyone, and still only edit their own', () => {
    expect(
      annotationRights({
        role: 'owner',
        viewerId: SOMEONE_ELSE,
        authorId: AUTHOR,
      }),
    ).toEqual({ canEdit: false, canDelete: true });
  });

  it('gives a viewer nothing to do, not even on something they wrote', () => {
    expect(
      annotationRights({ role: 'viewer', viewerId: AUTHOR, authorId: AUTHOR }),
    ).toEqual({ canEdit: false, canDelete: false });
  });

  it('withholds everything while the viewer id is still unknown', () => {
    // The id arrives with the project query; until then nobody is the author.
    expect(
      annotationRights({
        role: 'editor',
        viewerId: undefined,
        authorId: AUTHOR,
      }),
    ).toEqual({ canEdit: false, canDelete: false });
  });

  it('treats a missing author as nobody, so no one edits it', () => {
    expect(
      annotationRights({ role: 'owner', viewerId: AUTHOR, authorId: '' }),
    ).toEqual({ canEdit: false, canDelete: true });
  });
});
