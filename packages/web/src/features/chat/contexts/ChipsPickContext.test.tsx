// @vitest-environment jsdom

/**
 * B.1 — `ChipsPickContext` lifecycle tests.
 *
 * Two consumers (ChatPanel + ProjectCanvasContent) coordinate via
 * the context's `pickMode` flag + the latest stashed handler. The
 * tests cover:
 *   - throw outside provider
 *   - enter / exit cycle
 *   - pickNode forwards the id and auto-exits
 *   - re-entering replaces the stashed handler
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { ChipsPickProvider, useChipsPick } from './ChipsPickContext';

afterEach(() => cleanup());

const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(ChipsPickProvider, null, children);

describe('useChipsPick', () => {
  it('throws when used outside the provider', () => {
    // Suppress React's expected console.error for this single
    // assertion so we don't spam the test output.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useChipsPick())).toThrow(/inside <ChipsPickProvider>/);
    spy.mockRestore();
  });

  it('starts in pickMode=false', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    expect(result.current.pickMode).toBe(false);
  });

  it('enterPickMode flips pickMode to true', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    act(() => {
      result.current.enterPickMode(() => undefined);
    });
    expect(result.current.pickMode).toBe(true);
  });

  it('exitPickMode flips pickMode back to false', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    act(() => {
      result.current.enterPickMode(() => undefined);
    });
    act(() => {
      result.current.exitPickMode();
    });
    expect(result.current.pickMode).toBe(false);
  });

  it('pickNode forwards the id to the stashed handler and auto-exits', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    const handler = vi.fn();
    act(() => {
      result.current.enterPickMode(handler);
    });
    act(() => {
      result.current.pickNode('node-1');
    });
    expect(handler).toHaveBeenCalledWith('node-1');
    expect(result.current.pickMode).toBe(false);
  });

  it('re-entering pickMode replaces the stashed handler — latest wins', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      result.current.enterPickMode(first);
    });
    act(() => {
      result.current.enterPickMode(second);
    });
    act(() => {
      result.current.pickNode('node-2');
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('node-2');
  });

  it('pickNode after exit does nothing (no stale handler fires)', () => {
    const { result } = renderHook(() => useChipsPick(), { wrapper });
    const handler = vi.fn();
    act(() => {
      result.current.enterPickMode(handler);
    });
    act(() => {
      result.current.exitPickMode();
    });
    act(() => {
      result.current.pickNode('node-3');
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.current.pickMode).toBe(false);
  });
});

// Sanity-check the consumer pattern: a child component that
// reads the context renders without crashing.
describe('ChipsPickProvider — consumer wiring', () => {
  function ConsumerProbe({
    onMount,
  }: {
    onMount: (ctx: ReturnType<typeof useChipsPick>) => void;
  }) {
    const ctx = useChipsPick();
    React.useEffect(() => {
      onMount(ctx);
    }, [ctx, onMount]);
    return null;
  }

  it('renders the consumer with a live context', () => {
    const onMount = vi.fn();
    render(
      React.createElement(
        ChipsPickProvider,
        null,
        React.createElement(ConsumerProbe, { onMount }),
      ),
    );
    expect(onMount).toHaveBeenCalled();
    const ctx = onMount.mock.calls[0][0];
    expect(ctx.pickMode).toBe(false);
    expect(typeof ctx.enterPickMode).toBe('function');
    expect(typeof ctx.pickNode).toBe('function');
  });
});
