// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The desktop client's Downloads panel (inner#2041, design §7.3.1): it shows the
 * list the client keeps, read again after every notice, newest row only until
 * the user expands it; finished rows name the folder and reveal the file. It
 * sits at the bottom left of the page's layout until the user drags it by its
 * title bar; the dragged place is kept per account and held inside the window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { DesktopBridge, DesktopDownloadList } from '@breatic/shared';

import { DownloadPanel } from '@web/features/desktop-downloads/DownloadPanel';
import { DownloadPanelAnchor } from '@web/features/desktop-downloads/DownloadPanelAnchor';
import * as preferences from '@web/lib/user-preferences-storage';
import { useCurrentUserStore, type CurrentUser } from '@web/stores/current-user';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';

const MiB = 1024 * 1024;

/**
 * Put a client bridge on the page that serves a list.
 * @param first - The list the client holds at mount.
 * @param platform - The client's platform.
 * @returns The bridge doubles and a way to change the list and notify.
 */
function inClient(first: DesktopDownloadList, platform = 'darwin') {
  let list = first;
  const listeners = new Set<() => void>();
  const order: string[] = [];
  const bridge = {
    platform,
    listDownloads: vi.fn(async () => {
      order.push('list');
      return list;
    }),
    onDownloadsChanged: vi.fn((listener: () => void) => {
      order.push('subscribe');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    dismissDownloads: vi.fn(async () => undefined),
    revealDownload: vi.fn(async () => undefined),
  };
  (window as { breaticDesktop?: unknown }).breaticDesktop = bridge as unknown as DesktopBridge;
  return {
    bridge,
    order,
    /**
     * Change the client's list and send the notice.
     * @param next - The new list.
     */
    change: async (next: DesktopDownloadList) => {
      list = next;
      await act(async () => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const running = { id: '3', name: 'clip.mp4', state: 'progressing', received: 10 * MiB, total: 86 * MiB } as const;
const done = { id: '2', name: 'still.png', state: 'completed', folder: 'Downloads' } as const;
const failed = { id: '1', name: 'voice.mp3', state: 'failed' } as const;

afterEach(() => {
  delete (window as { breaticDesktop?: unknown }).breaticDesktop;
});

describe('DownloadPanel', () => {
  it('renders nothing in a browser', () => {
    const { container } = renderWithTooltips(<DownloadPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('subscribes before reading the list, and shows only the newest row', async () => {
    const { order } = inClient({ open: true, items: [running, done, failed] });
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    expect(order.slice(0, 2)).toEqual(['subscribe', 'list']);
    expect(screen.getByText('10 MiB / 86 MiB')).toBeInTheDocument();
    expect(screen.queryByText('still.png')).not.toBeInTheDocument();
  });

  it('expands to every row and collapses back to the newest', async () => {
    inClient({ open: true, items: [running, done, failed] });
    renderWithTooltips(<DownloadPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'All 3' }));
    expect(screen.getByText('still.png')).toBeInTheDocument();
    expect(screen.getByText('voice.mp3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Latest only' }));
    expect(screen.queryByText('still.png')).not.toBeInTheDocument();
  });

  it('offers no expand button for a single download', async () => {
    inClient({ open: true, items: [running] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('clip.mp4');
    expect(screen.queryByRole('button', { name: /^All / })).not.toBeInTheDocument();
  });

  it('sums up running, then failed, then done in the title bar', async () => {
    const { change } = inClient({ open: true, items: [running, failed] });
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByText('1 downloading')).toBeInTheDocument();
    await change({ open: true, items: [done, failed] });
    expect(await screen.findByText('1 failed')).toBeInTheDocument();
    await change({ open: true, items: [done] });
    expect(await screen.findByText('Complete')).toBeInTheDocument();
  });

  it('reads the list again on each notice and replaces what it shows', async () => {
    const { change, bridge } = inClient({ open: true, items: [running] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('clip.mp4');
    await change({ open: true, items: [{ ...running, received: 43 * MiB }] });
    expect(await screen.findByText('43 MiB / 86 MiB')).toBeInTheDocument();
    expect(bridge.listDownloads).toHaveBeenCalledTimes(2);
  });

  it('shows the amount alone when the size is unknown', async () => {
    inClient({ open: true, items: [{ ...running, total: 0 }] });
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByText('10 MiB downloaded')).toBeInTheDocument();
  });

  it('names the folder of a finished download and reveals it in Finder on macOS', async () => {
    const { bridge } = inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByText('Saved in Downloads')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(bridge.revealDownload).toHaveBeenCalledWith('2');
  });

  it('reveals in the folder on Windows and Linux', async () => {
    inClient({ open: true, items: [done] }, 'win32');
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByRole('button', { name: 'Show in folder' })).toBeInTheDocument();
  });

  it('says a failed download failed', async () => {
    inClient({ open: true, items: [failed] });
    renderWithTooltips(<DownloadPanel />);
    expect(await screen.findByText('Download failed. Please download it again.')).toBeInTheDocument();
  });

  it('closes through the client', async () => {
    const { bridge } = inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(bridge.dismissDownloads).toHaveBeenCalled();
  });

  it('stays hidden while the client holds it closed, and appears when it opens', async () => {
    const { change, bridge } = inClient({ open: false, items: [running] });
    renderWithTooltips(<DownloadPanel />);
    await waitFor(() => expect(bridge.listDownloads).toHaveBeenCalled());
    expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument();
    await change({ open: true, items: [running] });
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
  });
});

describe('DownloadPanel position', () => {
  /** The panel element. */
  const panel = (): HTMLElement => screen.getByTestId('desktop-download-panel');
  /** Its title bar, which drags it. */
  const titleBar = (): HTMLElement => screen.getByRole('heading', { name: 'Downloads' }).parentElement!;

  beforeEach(() => {
    useCurrentUserStore.setState({ user: { id: 'u1' } as CurrentUser });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    useCurrentUserStore.setState({ user: null });
    vi.restoreAllMocks();
  });

  it('sits 12px from the bottom-left corner of the window on a page without an anchor', async () => {
    inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('still.png');
    expect(panel().style.left).toBe('12px');
    expect(panel().style.bottom).toBe('12px');
  });

  it('takes its left edge from the page anchor, again when the anchor area resizes, and back to 12px once it goes', async () => {
    let left = 300;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { left: this.hasAttribute('data-download-panel-anchor') ? left : 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const resized: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    });
    inClient({ open: true, items: [done] });
    const view = renderWithTooltips(<div><DownloadPanelAnchor /><DownloadPanel /></div>);
    await screen.findByText('still.png');
    expect(panel().style.left).toBe('300px');
    left = 420;
    act(() => resized.forEach((callback) => callback()));
    expect(panel().style.left).toBe('420px');
    view.rerender(<div><DownloadPanel /></div>);
    expect(panel().style.left).toBe('12px');
  });

  it('follows a drag by its title bar and keeps the place for the account', async () => {
    const write = vi.spyOn(preferences, 'writeUserPreference');
    inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('still.png');
    fireEvent.pointerDown(titleBar(), { clientX: 100, clientY: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 500 });
    expect(panel().style.left).toBe('312px');
    expect(panel().style.bottom).toBe('212px');
    expect(write).toHaveBeenCalledWith('u1', { downloadPanelPosition: { left: 312, bottom: 212 } });
  });

  it('does not move when a title bar button is pressed', async () => {
    inClient({ open: true, items: [done, failed] });
    renderWithTooltips(<DownloadPanel />);
    const button = await screen.findByRole('button', { name: 'All 2' });
    fireEvent.pointerDown(button, { clientX: 100, clientY: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 500 });
    expect(panel().style.left).toBe('12px');
  });

  it('opens where the account left it', async () => {
    vi.spyOn(preferences, 'readUserPreferences').mockReturnValue({ ...preferences.DEFAULT_USER_PREFERENCES, downloadPanelPosition: { left: 500, bottom: 40 } });
    inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('still.png');
    expect(panel().style.left).toBe('500px');
    expect(panel().style.bottom).toBe('40px');
  });

  it('stays inside the window when dragged past its edge, and is pulled back in when the window shrinks', async () => {
    inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('still.png');
    fireEvent.pointerDown(titleBar(), { clientX: 100, clientY: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: -5000 });
    fireEvent.pointerUp(window, { clientX: 5000, clientY: -5000 });
    expect(panel().style.left).toBe(`${1200 - 320}px`);
    fireEvent.pointerDown(titleBar(), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: -5000, clientY: 5000 });
    fireEvent.pointerUp(window, { clientX: -5000, clientY: 5000 });
    expect(panel().style.left).toBe('0px');
    expect(panel().style.bottom).toBe('0px');
  });

  it('pulls a kept place back inside a window that has since shrunk', async () => {
    vi.spyOn(preferences, 'readUserPreferences').mockReturnValue({ ...preferences.DEFAULT_USER_PREFERENCES, downloadPanelPosition: { left: 1100, bottom: 40 } });
    inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel />);
    await screen.findByText('still.png');
    expect(panel().style.left).toBe(`${1200 - 320}px`);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().style.left).toBe(`${900 - 320}px`);
  });
});
