// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SceneViewport from '@web/spaces/three-d/viewport/SceneViewport';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  instances: [] as { update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@web/spaces/three-d/viewport/scene-viewport-runtime', () => ({
  SceneViewportRuntime: vi.fn(function (host: HTMLDivElement, props: SceneViewportProps) {
    mocks.construct(host, props);
    const instance = { update: vi.fn(), dispose: vi.fn() };
    mocks.instances.push(instance);
    return instance;
  }),
}));

/** Build the shell contract, keeping the engine mocked only for React lifetime tests.
 * @throws {never} Never.
 */
function props(): SceneViewportProps {
  return {
    objects: [], selectedIds: [], mode: 'translate', readOnly: false,
    view: { position: [7, 5, 8], target: [0, 1, 0] }, focusRevision: 0, cancelRevision: 0,
    remotePeers: [], scaleSensitivity: 0.006,
    onSelect: vi.fn(), onGestureStart: vi.fn(() => true), onGestureChange: vi.fn(), onGestureEnd: vi.fn(), onViewChange: vi.fn(), onError: vi.fn(),
    resolveAsset: vi.fn(),
  };
}

afterEach(cleanup);
beforeEach(() => { mocks.construct.mockReset(); mocks.instances.length = 0; });

describe('viewport effect ownership under React Activity (inner#1689)', () => {
  it('rebuilds visible resources after Activity cleanup while retaining the host and camera input', async () => {
    const initial = props();
    const page = render(<React.Activity mode='visible'><SceneViewport {...initial} /></React.Activity>);
    const host = page.getByTestId('three-d-viewport-host');
    expect(mocks.instances).toHaveLength(1);
    await act(async () => { page.rerender(<React.Activity mode='hidden'><SceneViewport {...initial} /></React.Activity>); });
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(host.isConnected).toBe(true);
    const restored = { ...initial, view: { position: [4, 3, 9] as [number, number, number], target: [1, 0, 0] as [number, number, number] } };
    await act(async () => { page.rerender(<React.Activity mode='visible'><SceneViewport {...restored} /></React.Activity>); });
    expect(mocks.instances).toHaveLength(2);
    expect(page.getByTestId('three-d-viewport-host')).toBe(host);
    expect(mocks.construct.mock.calls[1][1].view).toEqual(restored.view);
    page.unmount();
    expect(mocks.instances[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('does not retain the resource disposed by StrictMode effect replay', () => {
    const initial = props();
    const page = render(<React.StrictMode><SceneViewport {...initial} /></React.StrictMode>);
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(mocks.instances[1].dispose).toHaveBeenCalledTimes(0);
    page.unmount();
    expect(mocks.instances[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('reports construction failure through the parent error surface', () => {
    const initial = props();
    const failure = new Error('WebGL unavailable');
    mocks.construct.mockImplementation(() => { throw failure; });
    render(<SceneViewport {...initial} />);
    expect(initial.onError).toHaveBeenCalledWith(failure);
    expect(mocks.instances).toHaveLength(0);
  });
});
