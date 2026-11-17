// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space's two floating panels and the execution list's tab (#1490 design §13.8, the table whose one writer
 * is `transitionMotionPanels`). At most one panel is open; every cell of the table is one case.
 */

import { describe, expect, it } from 'vitest';

import { transitionMotionPanels, type MotionPanelsEvent, type MotionPanelsState } from '@web/spaces/web-animation/motion-panels';

const closed = (tab: 'done' | 'running' = 'done'): MotionPanelsState => ({ panel: 'none', tab });
const executions = (tab: 'done' | 'running' = 'done'): MotionPanelsState => ({ panel: 'executions', tab });
const annotations = (): MotionPanelsState => ({ panel: 'annotations', tab: 'done' });

type Row = [string, MotionPanelsEvent, MotionPanelsState];

const FROM_CLOSED: Row[] = [
  ['Executions', { type: 'toggle_executions' }, executions()],
  ['Annotations', { type: 'toggle_annotations' }, annotations()],
  ['New', { type: 'new' }, closed()],
  ['a new row accepted', { type: 'accepted', created: true, tab: 'running' }, executions('running')],
  ['an existing row answered', { type: 'accepted', created: false, tab: 'done' }, executions('done')],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['a locate request', { type: 'locate' }, closed()],
  ['Esc', { type: 'escape' }, closed()],
  ['leaving', { type: 'leave' }, closed()],
];

const FROM_EXECUTIONS: Row[] = [
  ['Executions', { type: 'toggle_executions' }, closed()],
  ['Annotations', { type: 'toggle_annotations' }, annotations()],
  ['New', { type: 'new' }, executions()],
  ['a new row accepted', { type: 'accepted', created: true, tab: 'running' }, executions('running')],
  ['an existing row answered', { type: 'accepted', created: false, tab: 'done' }, executions('done')],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['a locate request', { type: 'locate' }, executions()],
  ['Esc', { type: 'escape' }, closed()],
  ['leaving', { type: 'leave' }, closed()],
];

const FROM_ANNOTATIONS: Row[] = [
  ['Executions', { type: 'toggle_executions' }, executions()],
  ['Annotations', { type: 'toggle_annotations' }, closed()],
  ['New', { type: 'new' }, annotations()],
  ['a new row accepted', { type: 'accepted', created: true, tab: 'running' }, executions('running')],
  ['an existing row answered', { type: 'accepted', created: false, tab: 'done' }, executions('done')],
  ['a thread opened (marker, pin, panel, Modified from)', { type: 'open_thread' }, annotations()],
  ['a locate request', { type: 'locate' }, annotations()],
  ['Esc', { type: 'escape' }, closed()],
  ['leaving', { type: 'leave' }, closed()],
];

describe('transitionMotionPanels', () => {
  it.each(FROM_CLOSED)('with both closed, %s', (_name, event, next) => {
    expect(transitionMotionPanels(closed(), event)).toEqual(next);
  });

  it.each(FROM_EXECUTIONS)('with the execution list open, %s', (_name, event, next) => {
    expect(transitionMotionPanels(executions(), event)).toEqual(next);
  });

  it.each(FROM_ANNOTATIONS)('with the annotation panel open, %s', (_name, event, next) => {
    expect(transitionMotionPanels(annotations(), event)).toEqual(next);
  });

  it('switches the execution list\'s tab when the selected row asks for one, keeping the panel', () => {
    expect(transitionMotionPanels(executions('done'), { type: 'show_tab', tab: 'running' })).toEqual(executions('running'));
    expect(transitionMotionPanels(closed('done'), { type: 'show_tab', tab: 'running' })).toEqual(closed('running'));
  });

  it('switches the tab when the user picks one', () => {
    expect(transitionMotionPanels(executions('done'), { type: 'pick_tab', tab: 'running' })).toEqual(executions('running'));
  });
});
