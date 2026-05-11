// @vitest-environment jsdom

/**
 * F6 — `useAnnotationActions` lifecycle tests.
 *
 * Covers the three transitions the hook is responsible for:
 *
 *   - drop: creates a single LocalPending entry with `type: 'annotation'`
 *   - submit: writes the entry through `createDataNode` and clears it
 *   - cancel: clears the entry without writing
 *
 * Plus the lock invariant: a second `dropAnnotation()` while one is
 * already pending must return `null` and not add a second entry.
 *
 * Mocks `useReactFlow` (no real ReactFlow context in unit tests) and
 * `useCanvasActions.createDataNode` so we can assert the Yjs write
 * shape without booting a Yjs document.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  LocalPendingProvider,
} from '@/spaces/canvas/contexts/LocalPendingProvider';
import {
  useAnnotationActions,
  ANNOTATION_NODE_TYPE,
} from './use-annotation-actions';

const createDataNodeMock = vi.fn(() => 'mock-yjs-node-id');

vi.mock('@/spaces/canvas/hooks/useCanvasActions', () => ({
  useCanvasActions: () => ({
    createDataNode: createDataNodeMock,
  }),
}));

// Stub the viewport registry so `dropAnnotation` sees a "canvas mounted"
// world during tests — real registrar publishes when ProjectCanvas mounts.
vi.mock('@/spaces/canvas/types', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/spaces/canvas/types',
  );
  return {
    ...actual,
    getProjectCanvasViewportApi: () => ({
      getViewportCenterFlow: () => ({ x: 0, y: 0 }),
      centerOnFirstNodeId: () => undefined,
    }),
  };
});

beforeEach(() => {
  createDataNodeMock.mockClear();
});

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(LocalPendingProvider, null, children);

describe('useAnnotationActions — drop', () => {
  it('adds one pending annotation entry and returns its id', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    expect(result.current.pendingAnnotation).toBeNull();

    let dropped: string | null = null;
    act(() => {
      dropped = result.current.dropAnnotation();
    });

    expect(dropped).not.toBeNull();
    expect(result.current.pendingAnnotation).toMatchObject({ id: dropped });
  });

  it('returns null on a second drop while one is pending (the lock)', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let firstId: string | null = null;
    act(() => {
      firstId = result.current.dropAnnotation();
    });

    let secondId: string | null = 'sentinel';
    act(() => {
      secondId = result.current.dropAnnotation();
    });

    expect(firstId).not.toBeNull();
    expect(secondId).toBeNull();
    expect(result.current.pendingAnnotation?.id).toBe(firstId);
  });
});

describe('useAnnotationActions — submit', () => {
  it('writes the annotation through createDataNode and clears the pending entry', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id: string | null = null;
    act(() => {
      id = result.current.dropAnnotation();
    });

    act(() => {
      result.current.submitAnnotation(id!, 'hello world');
    });

    expect(createDataNodeMock).toHaveBeenCalledTimes(1);
    expect(createDataNodeMock).toHaveBeenCalledWith({
      type: ANNOTATION_NODE_TYPE,
      position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      data: { name: 'annotation', content: 'hello world' },
    });
    expect(result.current.pendingAnnotation).toBeNull();
  });

  it('treats whitespace-only submit as a cancel — no Yjs write', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id: string | null = null;
    act(() => {
      id = result.current.dropAnnotation();
    });

    act(() => {
      result.current.submitAnnotation(id!, '   \n  ');
    });

    expect(createDataNodeMock).not.toHaveBeenCalled();
    expect(result.current.pendingAnnotation).toBeNull();
  });

  it('trims surrounding whitespace from the saved text', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id: string | null = null;
    act(() => {
      id = result.current.dropAnnotation();
    });

    act(() => {
      result.current.submitAnnotation(id!, '  hello  ');
    });

    expect(createDataNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: 'hello' }),
      }),
    );
  });

  it('skips the Yjs write when the pending entry is gone (race)', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id: string | null = null;
    act(() => {
      id = result.current.dropAnnotation();
    });
    act(() => {
      result.current.cancelAnnotation(id!);
    });

    act(() => {
      result.current.submitAnnotation(id!, 'after cancel');
    });

    expect(createDataNodeMock).not.toHaveBeenCalled();
  });
});

describe('useAnnotationActions — cancel', () => {
  it('clears the pending entry without writing', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id: string | null = null;
    act(() => {
      id = result.current.dropAnnotation();
    });

    act(() => {
      result.current.cancelAnnotation(id!);
    });

    expect(createDataNodeMock).not.toHaveBeenCalled();
    expect(result.current.pendingAnnotation).toBeNull();
  });

  it('after cancel, drop succeeds again (lock releases)', () => {
    const { result } = renderHook(() => useAnnotationActions(), { wrapper });

    let id1: string | null = null;
    act(() => {
      id1 = result.current.dropAnnotation();
    });
    act(() => {
      result.current.cancelAnnotation(id1!);
    });

    let id2: string | null = null;
    act(() => {
      id2 = result.current.dropAnnotation();
    });

    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id1);
    expect(result.current.pendingAnnotation?.id).toBe(id2);
  });
});
