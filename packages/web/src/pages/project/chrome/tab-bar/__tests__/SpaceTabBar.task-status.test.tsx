// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';

import { SpaceTabBar } from '@web/pages/project/chrome/tab-bar/SpaceTabBar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { resetRunOnceForTests, useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

const SPACES: ProjectSpace[] = [
  { id: 'canvas-one', name: 'Canvas one', type: 'canvas' },
  { id: 'document-one', name: 'Notes', type: 'document' },
];

/** Render the real strip with two existing Space types. @throws {never} Never. */
function renderStrip(): void {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <TooltipProvider>
        <SpaceTabBar spaces={SPACES} allSpaces={SPACES} activeSpaceId='document-one' projectId='project-one'
          onActivate={vi.fn()} onCreate={vi.fn()} onClose={vi.fn()} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Add a content node to the actual document shape. @throws {never} Never. */
function addRunningNode(document: Y.Doc, running: number): Y.Map<unknown> {
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  data.set('name', 'A collaborator image');
  data.set('createdBy', 'another-user');
  data.set('createdAt', 1);
  data.set('locked', false);
  data.set('attachments', new Y.Array());
  data.set('taskCounts', { running, done: 0, failed: 0, expired: 0 });
  node.set('type', 'image');
  node.set('position', { x: 0, y: 0 });
  node.set('data', data);
  document.getMap<Y.Map<unknown>>('nodesMap').set('image-one', node);
  return data;
}

describe('SpaceTabBar current task status', () => {
  const scrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');

  beforeEach(() => {
    _resetForTests();
    resetRunOnceForTests();
    useSpaceOperationsStore.setState({ operations: {} });
    useUploadMarksStore.setState({ marks: {} });
    useTaskActionsInFlight.setState({ inFlight: new Set(), running: new Map() });
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    _resetForTests();
    useSpaceOperationsStore.setState({ operations: {} });
    if (scrollTo) Object.defineProperty(Element.prototype, 'scrollTo', scrollTo);
    else delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('shows a leading spinner for an existing Document upload and removes it when the operation ends', () => {
    renderStrip();
    expect(screen.queryByTestId('space-tab-busy-document-one')).toBeNull();
    act(() => useSpaceOperationsStore.getState().register('document-one', 'upload-one'));
    const spinner = screen.getByTestId('space-tab-busy-document-one');
    const tab = screen.getByRole('tab', { name: /Notes/ });
    expect(tab.firstElementChild).toBe(spinner);
    expect(spinner.classList.contains('animate-spin')).toBe(true);
    expect(screen.queryByTestId('space-tab-busy-canvas-one')).toBeNull();
    act(() => useSpaceOperationsStore.getState().unregister('document-one', 'upload-one'));
    expect(screen.queryByTestId('space-tab-busy-document-one')).toBeNull();
  });

  it('updates a background Canvas tab from its canonical document including collaborator tasks', () => {
    const document = getDoc(docName.canvasSpace('project-one', 'canvas-one'));
    const data = addRunningNode(document, 0);
    renderStrip();
    expect(screen.queryByTestId('space-tab-busy-canvas-one')).toBeNull();
    act(() => data.set('taskCounts', { running: 2, done: 0, failed: 0, expired: 0 }));
    const tab = screen.getByRole('tab', { name: /Canvas one/ });
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(tab.firstElementChild).toBe(screen.getByTestId('space-tab-busy-canvas-one'));
    expect(tab.querySelectorAll('[data-testid="space-tab-busy-canvas-one"]')).toHaveLength(1);
    act(() => data.set('taskCounts', { running: 1, done: 1, failed: 0, expired: 0 }));
    expect(screen.getByTestId('space-tab-busy-canvas-one')).toBeVisible();
    act(() => data.set('taskCounts', { running: 0, done: 2, failed: 0, expired: 0 }));
    expect(screen.queryByTestId('space-tab-busy-canvas-one')).toBeNull();
  });
});
