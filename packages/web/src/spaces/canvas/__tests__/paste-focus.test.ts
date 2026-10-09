// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';

import { userMovedOn } from '@web/spaces/canvas/paste-focus';

describe('userMovedOn', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * A canvas container with one node element, and a text box outside it.
   * @returns The elements.
   */
  const page = (): { canvas: HTMLElement; node: HTMLElement; input: HTMLInputElement; outside: HTMLButtonElement } => {
    const canvas = document.createElement('div');
    const node = document.createElement('div');
    node.tabIndex = 0;
    canvas.append(node);
    const input = document.createElement('input');
    const outside = document.createElement('button');
    document.body.append(canvas, input, outside);
    return { canvas, node, input, outside };
  };

  it('is false while the reader is still where the paste left them', () => {
    const { canvas, node } = page();
    node.focus();
    expect(userMovedOn({ selectionBefore: 'a', selectionNow: 'a', ownSelection: null, activeBefore: null, active: document.activeElement, canvas })).toBe(false);
  });

  it('is false with the keyboard back on the page, as after a menu closes', () => {
    const { canvas } = page();
    expect(userMovedOn({ selectionBefore: 'a', selectionNow: 'a', ownSelection: null, activeBefore: null, active: document.body, canvas })).toBe(false);
  });

  it('is true once the reader is typing in a field', () => {
    const { canvas, input } = page();
    input.focus();
    expect(userMovedOn({ selectionBefore: 'a', selectionNow: 'a', ownSelection: null, activeBefore: null, active: document.activeElement, canvas })).toBe(true);
  });

  it('is true once the keyboard is outside the canvas', () => {
    const { canvas, outside } = page();
    outside.focus();
    expect(userMovedOn({ selectionBefore: 'a', selectionNow: 'a', ownSelection: null, activeBefore: null, active: document.activeElement, canvas })).toBe(true);
  });

  it('is false while the menu the paste came from still holds the keyboard', () => {
    const { canvas, outside } = page();
    outside.focus();
    expect(
      userMovedOn({ selectionBefore: 'a', selectionNow: 'a', ownSelection: null, activeBefore: outside, active: outside, canvas }),
    ).toBe(false);
  });

  it('is false when the selection is the one an earlier paste set', () => {
    const { canvas, node } = page();
    node.focus();
    expect(
      userMovedOn({ selectionBefore: 'a', selectionNow: 'c', ownSelection: 'c', activeBefore: node, active: node, canvas }),
    ).toBe(false);
  });

  it('is true once the reader picked other nodes', () => {
    const { canvas, node } = page();
    node.focus();
    expect(userMovedOn({ selectionBefore: 'a', selectionNow: 'b', ownSelection: null, activeBefore: null, active: document.activeElement, canvas })).toBe(true);
  });
});
