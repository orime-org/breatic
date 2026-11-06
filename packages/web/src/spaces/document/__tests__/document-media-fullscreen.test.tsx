// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentMediaViews } from '@web/spaces/document/DocumentMediaViews';
import { TooltipProvider } from '@web/components/ui/tooltip';

const editors: ReturnType<typeof buildDocumentEditor>[] = [];

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * A body holding one media block shown at a given width.
 * @param type - The block's type.
 * @param width - Its width on screen: 80 puts a video's transport in the floating panel.
 * @param readOnly - Whether the reader may only view.
 * @returns The editor.
 */
function open(type: 'image' | 'video' | 'audio', width: number, readOnly = false): ReturnType<typeof buildDocumentEditor> {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-media-box') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  editors.push(editor);
  const scroller = document.createElement('div');
  scroller.setAttribute('data-radix-scroll-area-viewport', '');
  const host = document.createElement('div');
  scroller.appendChild(host);
  document.body.appendChild(scroller);
  editor.mount(host);
  render(<TooltipProvider><DocumentMediaViews editor={editor} readOnly={readOnly} /></TooltipProvider>);
  act(() => editor.replaceBlocks(editor.document, [
    { type, props: { url: type === 'image' ? '/a.png' : '/clip.mp4', mediaWidth: 240, mediaHeight: 160 } },
  ] as never));
  return editor;
}

/**
 * The actions a toolbar offers.
 * @param toolbar - The toolbar.
 * @returns Their `data-action` names.
 */
function actions(toolbar: HTMLElement): (string | null)[] {
  return within(toolbar).queryAllByRole('button').map((b) => b.getAttribute('data-action'));
}

/**
 * The inline player's element.
 * @returns The video in the body.
 */
function inlineVideo(): HTMLVideoElement {
  return within(screen.getByTestId('doc-media-box')).getByTestId('media-element') as HTMLVideoElement;
}

/**
 * The full-screen player's element.
 * @returns The video in the full-screen layer.
 */
function fullVideo(): HTMLVideoElement {
  return within(screen.getByTestId('media-fullscreen')).getByTestId('media-element') as HTMLVideoElement;
}

// inner#1844: a document video opens full screen from its toolbar, as an
// image does, and goes on from where it was.
describe('a document video full screen', () => {
  it('opens from the inline toolbar at the inline position and hands it back', async () => {
    open('video', 600);
    inlineVideo().currentTime = 5;
    fireEvent.click(screen.getAllByTestId('doc-media-fullscreen')[0]!);
    expect(fullVideo().currentTime).toBe(5);

    fullVideo().currentTime = 12;
    fireEvent.keyDown(fullVideo(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('media-fullscreen')).toBeNull());
    expect(inlineVideo().currentTime).toBe(12);
  });

  // inner#1844 round 1: what opened stays on screen while the block changes.
  it('keeps showing what it opened on when the block gets a new file', () => {
    const editor = open('video', 600);
    fireEvent.click(screen.getAllByTestId('doc-media-fullscreen')[0]!);
    const id = (editor.document[0] as { id: string }).id;
    act(() => editor.updateBlock(id, { props: { url: '/other.mp4' } } as never));
    expect(fullVideo().getAttribute('src')).toBe('/clip.mp4');
  });

  it('opens from the narrow video panel, closes the panel and returns the focus to the body', async () => {
    const editor = open('video', 80);
    fireEvent.pointerEnter(screen.getByTestId('doc-media-frame'));
    const panel = await screen.findByTestId('doc-media-video-panel');
    inlineVideo().currentTime = 3;
    fireEvent.click(within(panel).getByTestId('doc-media-fullscreen'));
    await waitFor(() => expect(screen.queryByTestId('doc-media-video-panel')).toBeNull());
    expect(fullVideo().currentTime).toBe(3);

    fullVideo().currentTime = 9;
    fireEvent.keyDown(fullVideo(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('media-fullscreen')).toBeNull());
    expect(inlineVideo().currentTime).toBe(9);
    expect(editor.prosemirrorView!.dom.contains(document.activeElement)).toBe(true);
  });
});

// inner#1844: a viewer has no editing actions but can still open full screen.
describe('a read-only media toolbar', () => {
  it.each(['image', 'video'] as const)('offers only full screen on an inline %s', (type) => {
    open(type, 600, true);
    const toolbar = screen.getByTestId('doc-media-toolbar');
    expect(actions(toolbar)).toEqual(['fullscreen']);
    expect(toolbar.hasAttribute('inert')).toBe(false);
  });

  it('offers only full screen in the narrow video panel', async () => {
    open('video', 80, true);
    fireEvent.pointerEnter(screen.getByTestId('doc-media-frame'));
    const panel = await screen.findByTestId('doc-media-video-panel');
    expect(actions(within(panel).getByTestId('doc-media-toolbar'))).toEqual(['fullscreen']);
  });

  // The read-only body hides every [data-media-chrome] but the viewer's own.
  it.each([
    ['image', true],
    ['video', true],
    ['audio', false],
  ] as const)('marks the %s toolbar layer as a viewer\'s: %s', (type, kept) => {
    open(type, 600, true);
    const layer = screen.getByTestId('doc-media-toolbar').closest('[data-media-chrome]');
    expect(layer?.hasAttribute('data-media-viewer')).toBe(kept);
  });

  it('stays hidden on audio, which has nothing a viewer can do', () => {
    open('audio', 600, true);
    const toolbar = screen.getByTestId('doc-media-toolbar');
    expect(toolbar.hasAttribute('inert')).toBe(true);
    expect(toolbar.className).toContain('invisible');
  });
});

// inner#1844: a narrow video's row of icons belongs to its floating panel. The
// layer over the picture takes no pointer, so the bar passing through it on its
// way into the panel never lands under the hand and closes the panel.
describe('a narrow video', () => {
  it('lets the pointer through the layer over its picture while the panel is open', async () => {
    open('video', 80);
    fireEvent.pointerEnter(screen.getByTestId('doc-media-frame'));
    await screen.findByTestId('doc-media-video-panel');
    const layer = document.querySelector('[data-media-viewer]');
    expect(layer?.className).toContain('pointer-events-none');
  });

  it('keeps the layer over a wide video taking the pointer while its bar is up', () => {
    open('video', 600);
    fireEvent.pointerEnter(screen.getByTestId('doc-media-frame'));
    const layer = document.querySelector('[data-media-viewer]');
    expect(layer?.className).toContain('pointer-events-auto');
  });
});
