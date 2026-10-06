// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A box that takes the focus on arrival does that once: a Space hidden and
 * shown again is not the box arriving, so the caret stays where the reader
 * put it (inner#1235 A1, A19).
 */

import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';

import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';

/**
 * The box inside an Activity, the way a document Space holds it.
 * @param root0 - Props.
 * @param root0.hidden - Whether the Space is switched away from.
 * @returns The element.
 */
function Space({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <React.Activity mode={hidden ? 'hidden' : 'visible'}>
      <DocumentCommentWriteBox
        name='draft'
        value='first second'
        placeholder=''
        onChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the arrival focus is what this test is about
        autoFocus
      />
    </React.Activity>
  );
}

describe('DocumentCommentWriteBox in a Space switched away from', () => {
  it('leaves the caret where the reader put it when shown again', () => {
    const { rerender } = render(<Space hidden={false} />);
    const box = screen.getByTestId('doc-comment-draft-input') as HTMLTextAreaElement;
    act(() => box.setSelectionRange(5, 5));

    rerender(<Space hidden />);
    rerender(<Space hidden={false} />);

    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 5]);
  });
});
