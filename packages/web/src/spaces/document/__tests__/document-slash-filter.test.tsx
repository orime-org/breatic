// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the slash menu lists and how typing narrows it (inner#1125 A1, A2,
 * design 5.2, 5.3).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { DocumentInsertChoices } from '@web/spaces/document/DocumentInsertChoices';
import { INSERT_ENTRY_IDS } from '@web/spaces/document/document-insert-entries';
import { closesForNoMatch, filterInsertEntries, queryWhileComposing } from '@web/spaces/document/document-slash-filter';

describe('the slash menu rows', () => {
  it('are the insert menu rows, in its order', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DocumentInsertChoices onPick={vi.fn()} onPickMedia={vi.fn()} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const rendered = screen
      .getAllByRole('menuitem')
      .map((item) => item.getAttribute('data-testid')?.replace('doc-block-insert-', ''))
      .filter((id): id is string => id !== undefined);
    expect([...INSERT_ENTRY_IDS]).toEqual(rendered);
  });
});

describe('filtering by what is typed after the trigger', () => {
  // A Chinese interface: the current name, then the English one.
  const names: Record<string, readonly string[]> = {
    table: ['表格', 'Table'],
    'heading-1': ['标题 1', 'Heading 1'],
    'bullet-list': ['无序列表', 'Bullet list'],
    formula: ['公式', 'Formula'],
  };
  const namesOf = (id: string): readonly string[] => names[id] ?? [];
  const ids = ['heading-1', 'bullet-list', 'table', 'formula'];

  it('lists every row for an empty query', () => {
    expect(filterInsertEntries(ids, '', namesOf)).toEqual(ids);
  });

  it('matches the current language name and the English name', () => {
    expect(filterInsertEntries(ids, '表格', namesOf)).toEqual(['table']);
    expect(filterInsertEntries(ids, 'table', namesOf)).toEqual(['table']);
  });

  it('ignores case and keeps the menu order', () => {
    expect(filterInsertEntries(ids, 'L', namesOf)).toEqual(['bullet-list', 'table', 'formula']);
  });

  it('finds nothing for a query no name holds', () => {
    expect(filterInsertEntries(ids, 'zzz', namesOf)).toEqual([]);
  });
});

describe('typing through an input method', () => {
  it('filters by the query from before the composition while composing', () => {
    expect(queryWhileComposing({ query: 'biaog', composing: true, before: '' })).toBe('');
    expect(queryWhileComposing({ query: 'xbiao', composing: true, before: 'x' })).toBe('x');
    expect(queryWhileComposing({ query: '表格', composing: false, before: '' })).toBe('表格');
  });

  it('never closes for a missing match while composing', () => {
    expect(closesForNoMatch({ query: 'biaog', matched: false, lastUsefulLength: 1, composing: true })).toBe(false);
  });

  it('closes once a committed query runs more than three characters past the last match', () => {
    expect(closesForNoMatch({ query: 'tabzzz', matched: false, lastUsefulLength: 3, composing: false })).toBe(false);
    expect(closesForNoMatch({ query: 'tabzzzz', matched: false, lastUsefulLength: 3, composing: false })).toBe(true);
    expect(closesForNoMatch({ query: 'tablezzzz', matched: true, lastUsefulLength: 3, composing: false })).toBe(false);
  });
});
