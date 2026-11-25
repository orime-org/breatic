// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Motion Space's two floating panels, the execution list's tab and the row it marks (#1490 design §13.8, the table
 * whose one writer is `transitionMotionPanels`). At most one panel is open; every cell of the table is one case. An
 * accepted execution, and a located one that has not succeeded, are revealed: the list opens on the row's tab with the
 * row marked. A located row that succeeded opens in the preview and leaves the panels alone, so it sends no event here.
 */

import { describe, expect, it } from 'vitest';

import { MOTION_PANELS_CLOSED, transitionMotionPanels, type MotionPanelsEvent, type MotionPanelsState, type MotionTab } from '@web/spaces/web-animation/motion-panels';

const ROW = 'r0000000-0000-4000-8000-000000000001';
const closed = (tab: MotionTab = 'succeeded', marked: string | null = null): MotionPanelsState => ({ panel: 'none', tab, marked });
const executions = (tab: MotionTab = 'succeeded', marked: string | null = null): MotionPanelsState => ({ panel: 'executions', tab, marked });
const annotations = (): MotionPanelsState => ({ panel: 'annotations', tab: 'succeeded', marked: null });

type Row = [string, MotionPanelsEvent, MotionPanelsState];

const reveal = (tab: MotionTab): MotionPanelsEvent => ({ type: 'reveal', tab, executionId: ROW });

const FROM_CLOSED: Row[] = [
  ['Executions', { type: 'toggle_executions' }, executions()],
  ['Annotations', { type: 'toggle_annotations' }, annotations()],
  ['a new row revealed', reveal('running'), executions('running', ROW)],
  ['a failed row revealed', reveal('failed'), executions('failed', ROW)],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['Esc', { type: 'escape' }, closed()],
];

const FROM_EXECUTIONS: Row[] = [
  ['Executions', { type: 'toggle_executions' }, closed()],
  ['Annotations', { type: 'toggle_annotations' }, annotations()],
  ['a new row revealed', reveal('running'), executions('running', ROW)],
  ['a succeeded row revealed', reveal('succeeded'), executions('succeeded', ROW)],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['Esc', { type: 'escape' }, closed()],
];

const FROM_ANNOTATIONS: Row[] = [
  ['Executions', { type: 'toggle_executions' }, executions()],
  ['Annotations', { type: 'toggle_annotations' }, closed()],
  ['a new row revealed', reveal('running'), executions('running', ROW)],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['Esc', { type: 'escape' }, closed()],
];

describe('transitionMotionPanels', () => {
  it('starts closed on Completed with nothing marked', () => {
    expect(MOTION_PANELS_CLOSED).toEqual(closed());
  });

  it.each(FROM_CLOSED)('with both closed, %s', (_name, event, next) => {
    expect(transitionMotionPanels(closed(), event)).toEqual(next);
  });

  it.each(FROM_EXECUTIONS)('with the execution list open, %s', (_name, event, next) => {
    expect(transitionMotionPanels(executions(), event)).toEqual(next);
  });

  it.each(FROM_ANNOTATIONS)('with the annotation panel open, %s', (_name, event, next) => {
    expect(transitionMotionPanels(annotations(), event)).toEqual(next);
  });

  it('switches the tab when the user picks one, keeping the marked row', () => {
    expect(transitionMotionPanels(executions('running', ROW), { type: 'pick_tab', tab: 'failed' })).toEqual(executions('failed', ROW));
  });

  it('keeps the marked row through closing and opening the list', () => {
    const shut = transitionMotionPanels(executions('running', ROW), { type: 'escape' });
    expect(transitionMotionPanels(shut, { type: 'toggle_executions' })).toEqual(executions('running', ROW));
  });
});
