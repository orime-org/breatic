// @vitest-environment jsdom

/**
 * F8 — ViewportToolbar render + interaction tests.
 *
 * Mocks `@xyflow/react` so the toolbar renders without booting a
 * full ReactFlow tree. Asserts: percent label tracks `zoom`,
 * toggle visuals match props, fit / zoom-in / zoom-out callbacks
 * fire with the right args, +/− disable at zoom boundaries.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import ViewportToolbar from './ViewportToolbar';

const fitView = vi.fn();
const zoomIn = vi.fn();
const zoomOut = vi.fn();

let mockZoom = 1;
let mockMinZoom = 0.2;
let mockMaxZoom = 2;

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView, zoomIn, zoomOut }),
  useViewport: () => ({ zoom: mockZoom, x: 0, y: 0 }),
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ minZoom: mockMinZoom, maxZoom: mockMaxZoom }),
}));

vi.mock('@/ui/icon', () => ({
  Icon: ({ name }: { name: string }) =>
    React.createElement('span', { 'data-icon': name }),
}));

vi.mock('@/ui/tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
  }),
}));

beforeEach(() => {
  fitView.mockClear();
  zoomIn.mockClear();
  zoomOut.mockClear();
  mockZoom = 1;
  mockMinZoom = 0.2;
  mockMaxZoom = 2;
});

// testing-library doesn't auto-clean between vitest `it` blocks
// without one of the integration packages — explicit cleanup keeps
// the DOM scoped per test.
afterEach(() => {
  cleanup();
});

const noop = () => {};

describe('ViewportToolbar — render', () => {
  it('shows the zoom percentage from useViewport', () => {
    mockZoom = 0.75;
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('renders the four button groups (3 toggles + zoom trio)', () => {
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    // 5 buttons total: minimap, fit, snap, zoom-out, zoom-in
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('marks minimap pressed when showMiniMap is true', () => {
    render(
      <ViewportToolbar
        showMiniMap
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    expect(screen.getByLabelText('小地图').getAttribute('aria-pressed')).toBe('true');
  });

  it('marks snap pressed when snapEnabled is true', () => {
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled
        onToggleSnap={noop}
      />,
    );
    expect(screen.getByLabelText('网格吸附').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ViewportToolbar — interactions', () => {
  it('fires onToggleMiniMap when minimap button is clicked', () => {
    const toggleMm = vi.fn();
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={toggleMm}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText('小地图'));
    expect(toggleMm).toHaveBeenCalledTimes(1);
  });

  it('fires onToggleSnap when snap button is clicked', () => {
    const toggleSnap = vi.fn();
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={toggleSnap}
      />,
    );
    fireEvent.click(screen.getByLabelText('网格吸附'));
    expect(toggleSnap).toHaveBeenCalledTimes(1);
  });

  it('calls fitView with padding 0.15 when fit button is clicked', () => {
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText('适应视图'));
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(fitView).toHaveBeenCalledWith({ padding: 0.15, duration: 200 });
  });

  it('calls zoomIn / zoomOut on the trio buttons', () => {
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    fireEvent.click(screen.getByLabelText('缩小'));
    fireEvent.click(screen.getByLabelText('放大'));
    expect(zoomOut).toHaveBeenCalledWith({ duration: 150 });
    expect(zoomIn).toHaveBeenCalledWith({ duration: 150 });
  });

  it('disables zoom-out at min zoom', () => {
    mockZoom = mockMinZoom;
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    expect(screen.getByLabelText('缩小').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('放大').hasAttribute('disabled')).toBe(false);
  });

  it('disables zoom-in at max zoom', () => {
    // Separate render: `memo` would skip a re-render when only the
    // mocked viewport changed (props are identical), so each
    // boundary needs its own mount.
    mockZoom = mockMaxZoom;
    render(
      <ViewportToolbar
        showMiniMap={false}
        onToggleMiniMap={noop}
        snapEnabled={false}
        onToggleSnap={noop}
      />,
    );
    expect(screen.getByLabelText('放大').hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('缩小').hasAttribute('disabled')).toBe(false);
  });
});
