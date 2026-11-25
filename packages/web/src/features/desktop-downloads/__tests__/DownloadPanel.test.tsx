// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The desktop client's Downloads panel (inner#2041, design §7.3.1): it shows the
 * list the client keeps, read again after every notice, newest row only until
 * the user expands it; finished rows name the folder and reveal the file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { DesktopBridge, DesktopDownloadList } from '@breatic/shared';

import { DownloadPanel, downloadPanelPlacement } from '@web/features/desktop-downloads/DownloadPanel';
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
    const { container } = renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(container).toBeEmptyDOMElement();
  });

  it('subscribes before reading the list, and shows only the newest row', async () => {
    const { order } = inClient({ open: true, items: [running, done, failed] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
    expect(order.slice(0, 2)).toEqual(['subscribe', 'list']);
    expect(screen.getByText('10 MiB / 86 MiB')).toBeInTheDocument();
    expect(screen.queryByText('still.png')).not.toBeInTheDocument();
  });

  it('expands to every row and collapses back to the newest', async () => {
    inClient({ open: true, items: [running, done, failed] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    fireEvent.click(await screen.findByRole('button', { name: 'All 3' }));
    expect(screen.getByText('still.png')).toBeInTheDocument();
    expect(screen.getByText('voice.mp3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Latest only' }));
    expect(screen.queryByText('still.png')).not.toBeInTheDocument();
  });

  it('offers no expand button for a single download', async () => {
    inClient({ open: true, items: [running] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    await screen.findByText('clip.mp4');
    expect(screen.queryByRole('button', { name: /^All / })).not.toBeInTheDocument();
  });

  it('sums up running, then failed, then done in the title bar', async () => {
    const { change } = inClient({ open: true, items: [running, failed] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByText('1 downloading')).toBeInTheDocument();
    await change({ open: true, items: [done, failed] });
    expect(await screen.findByText('1 failed')).toBeInTheDocument();
    await change({ open: true, items: [done] });
    expect(await screen.findByText('Complete')).toBeInTheDocument();
  });

  it('reads the list again on each notice and replaces what it shows', async () => {
    const { change, bridge } = inClient({ open: true, items: [running] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    await screen.findByText('clip.mp4');
    await change({ open: true, items: [{ ...running, received: 43 * MiB }] });
    expect(await screen.findByText('43 MiB / 86 MiB')).toBeInTheDocument();
    expect(bridge.listDownloads).toHaveBeenCalledTimes(2);
  });

  it('shows the amount alone when the size is unknown', async () => {
    inClient({ open: true, items: [{ ...running, total: 0 }] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByText('10 MiB downloaded')).toBeInTheDocument();
  });

  it('names the folder of a finished download and reveals it in Finder on macOS', async () => {
    const { bridge } = inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByText('Saved in Downloads')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(bridge.revealDownload).toHaveBeenCalledWith('2');
  });

  it('reveals in the folder on Windows and Linux', async () => {
    inClient({ open: true, items: [done] }, 'win32');
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByRole('button', { name: 'Show in folder' })).toBeInTheDocument();
  });

  it('says a failed download failed', async () => {
    inClient({ open: true, items: [failed] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    expect(await screen.findByText('Download failed. Please download it again.')).toBeInTheDocument();
  });

  it('closes through the client', async () => {
    const { bridge } = inClient({ open: true, items: [done] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(bridge.dismissDownloads).toHaveBeenCalled();
  });

  it('stays hidden while the client holds it closed, and appears when it opens', async () => {
    const { change, bridge } = inClient({ open: false, items: [running] });
    renderWithTooltips(<DownloadPanel pathname='/studio' />);
    await waitFor(() => expect(bridge.listDownloads).toHaveBeenCalled());
    expect(screen.queryByText('clip.mp4')).not.toBeInTheDocument();
    await change({ open: true, items: [running] });
    expect(await screen.findByText('clip.mp4')).toBeInTheDocument();
  });
});

describe('downloadPanelPlacement', () => {
  it.each([
    ['/project/abc', 'project'],
    ['/project/abc/space/1', 'project'],
    ['/studio', 'studio'],
    ['/studio/my-studio/members', 'studio'],
    ['/recovery-code', 'page'],
    ['/login', 'page'],
  ] as const)('places the panel on %s beside the %s navigation', (pathname, placement) => {
    expect(downloadPanelPlacement(pathname)).toBe(placement);
  });
});
