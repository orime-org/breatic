// @vitest-environment jsdom

/**
 * F10 — `CustomEdge` visual contract tests.
 *
 * The component reads `data.isPrimary`, `selected`, and a hover
 * state to decide stroke / strokeWidth / className. We mock
 * `@xyflow/react` so the test renders an SVG without the real
 * ReactFlow runtime, then assert on the rendered `<path>` element
 * the BaseEdge mock produces.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import CustomEdge from './Edge';

vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  BaseEdge: (props: { className?: string; style?: React.CSSProperties }) =>
    React.createElement('path', {
      'data-testid': 'base-edge',
      className: props.className,
      style: props.style,
    }),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  getBezierPath: () => ['M 0 0 L 10 10', 5, 5],
  useReactFlow: () => ({ deleteElements: () => undefined }),
  useStore: () => false,
}));

vi.mock('@/ui/icon', () => ({
  Icon: ({ name }: { name: string }) =>
    React.createElement('span', { 'data-icon': name }),
}));

vi.mock('@/ui/button', () => ({
  Button: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('button', null, children),
}));

afterEach(() => {
  cleanup();
});

const baseProps = {
  id: 'e1',
  source: 'a',
  target: 'b',
  sourceX: 0,
  sourceY: 0,
  targetX: 10,
  targetY: 10,
  sourcePosition: 'right' as const,
  targetPosition: 'left' as const,
  selected: false,
  style: {},
  markerEnd: undefined,
  data: undefined,
} as unknown as React.ComponentProps<typeof CustomEdge>;

describe('CustomEdge — primary state', () => {
  it('non-primary: light neutral stroke, 1.5 px width, no animation class', () => {
    const { getByTestId } = render(
      <CustomEdge {...baseProps} data={{ isPrimary: false }} />,
    );
    const path = getByTestId('base-edge') as SVGPathElement & {
      style: CSSStyleDeclaration;
    };
    expect(path.getAttribute('class')).toBe(null);
    expect(path.style.stroke).toBe('var(--color-border-default-secondary)');
    expect(path.style.strokeWidth).toBe('1.5');
  });

  it('primary: brand stroke, 2.5 px width, breatic-edge-primary class', () => {
    const { getByTestId } = render(
      <CustomEdge {...baseProps} data={{ isPrimary: true }} />,
    );
    const path = getByTestId('base-edge') as SVGPathElement & {
      style: CSSStyleDeclaration;
    };
    expect(path.getAttribute('class')).toBe('breatic-edge-primary');
    expect(path.style.stroke).toBe('var(--color-brand-base)');
    expect(path.style.strokeWidth).toBe('2.5');
  });

  it('primary + selected: selection color wins for stroke, animation class still applied', () => {
    const { getByTestId } = render(
      <CustomEdge
        {...baseProps}
        selected
        data={{ isPrimary: true }}
      />,
    );
    const path = getByTestId('base-edge') as SVGPathElement & {
      style: CSSStyleDeclaration;
    };
    // Active wins for stroke color.
    expect(path.style.stroke).toBe('var(--color-border-utilities-selected)');
    // ...but the primary marker stays so the user keeps the
    // "which branch is primary" signal mid-selection.
    expect(path.getAttribute('class')).toBe('breatic-edge-primary');
    // Width stays at the primary 2.5 px.
    expect(path.style.strokeWidth).toBe('2.5');
  });

  it('non-primary + selected: selection color, default 1.5 px width, no animation', () => {
    const { getByTestId } = render(
      <CustomEdge {...baseProps} selected data={{ isPrimary: false }} />,
    );
    const path = getByTestId('base-edge') as SVGPathElement & {
      style: CSSStyleDeclaration;
    };
    expect(path.style.stroke).toBe('var(--color-border-utilities-selected)');
    expect(path.style.strokeWidth).toBe('1.5');
    expect(path.getAttribute('class')).toBe(null);
  });

  it('treats absent data as non-primary (defensive)', () => {
    const { getByTestId } = render(<CustomEdge {...baseProps} />);
    const path = getByTestId('base-edge') as SVGPathElement & {
      style: CSSStyleDeclaration;
    };
    expect(path.getAttribute('class')).toBe(null);
    expect(path.style.strokeWidth).toBe('1.5');
  });
});
