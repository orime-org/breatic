// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { beforeEach, describe, expect, it } from 'vitest';

import { useSpaceOperationsStore } from '@web/stores/space-operations';

/**
 * Per-space front-end operation registry (#1617). A registered operation
 * (first registrant: in-flight upload) blocks closing that space's tab, because
 * closing detaches the space's Yjs doc and an un-synced local write-back is lost
 * if the space is never reopened. The registry is the single source of truth for
 * "is a front-end operation in progress" — deliberately NOT derived from Yjs
 * `handling` state (which also covers backend AIGC, which survives tab close).
 */
describe('useSpaceOperationsStore', () => {
  beforeEach(() => {
    useSpaceOperationsStore.setState({ operations: {} });
  });

  it('starts empty', () => {
    const s = useSpaceOperationsStore.getState();
    expect(s.hasAnyOperations()).toBe(false);
    expect(s.hasOperations('space-1')).toBe(false);
  });

  it('register marks the space as having an operation', () => {
    useSpaceOperationsStore.getState().register('space-1', 'op-1');
    const s = useSpaceOperationsStore.getState();
    expect(s.hasOperations('space-1')).toBe(true);
    expect(s.hasAnyOperations()).toBe(true);
  });

  it('unregister clears the operation', () => {
    const store = useSpaceOperationsStore.getState();
    store.register('space-1', 'op-1');
    store.unregister('space-1', 'op-1');
    const s = useSpaceOperationsStore.getState();
    expect(s.hasOperations('space-1')).toBe(false);
    expect(s.hasAnyOperations()).toBe(false);
  });

  it('isolates operations per space', () => {
    useSpaceOperationsStore.getState().register('space-1', 'op-1');
    const s = useSpaceOperationsStore.getState();
    expect(s.hasOperations('space-1')).toBe(true);
    expect(s.hasOperations('space-2')).toBe(false);
    // Any-space aggregate is true while space-1 is busy.
    expect(s.hasAnyOperations()).toBe(true);
  });

  it('a space stays busy until ALL its operations unregister', () => {
    const store = useSpaceOperationsStore.getState();
    store.register('space-1', 'op-1');
    store.register('space-1', 'op-2');
    store.unregister('space-1', 'op-1');
    expect(useSpaceOperationsStore.getState().hasOperations('space-1')).toBe(
      true,
    );
    store.unregister('space-1', 'op-2');
    expect(useSpaceOperationsStore.getState().hasOperations('space-1')).toBe(
      false,
    );
  });

  it('unregistering an unknown operation is a no-op (idempotent)', () => {
    const store = useSpaceOperationsStore.getState();
    store.unregister('space-1', 'never-registered');
    expect(useSpaceOperationsStore.getState().hasOperations('space-1')).toBe(
      false,
    );
  });

  it('re-registering the same operation id does not double-count', () => {
    const store = useSpaceOperationsStore.getState();
    store.register('space-1', 'op-1');
    store.register('space-1', 'op-1');
    store.unregister('space-1', 'op-1');
    expect(useSpaceOperationsStore.getState().hasOperations('space-1')).toBe(
      false,
    );
  });

  it('hasAnyOperations aggregates across multiple spaces', () => {
    const store = useSpaceOperationsStore.getState();
    store.register('space-1', 'op-1');
    store.register('space-2', 'op-2');
    store.unregister('space-1', 'op-1');
    expect(useSpaceOperationsStore.getState().hasAnyOperations()).toBe(true);
    store.unregister('space-2', 'op-2');
    expect(useSpaceOperationsStore.getState().hasAnyOperations()).toBe(false);
  });
});
