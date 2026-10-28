// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DocumentMediaViews } from '@web/spaces/document/DocumentMediaViews';
import { TooltipProvider } from '@web/components/ui/tooltip';

const editors: ReturnType<typeof buildDocumentEditor>[] = [];
afterEach(() => { cleanup(); for (const editor of editors.splice(0)) editor.unmount(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

function open(type: 'image' | 'video' = 'image', width = 80) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-media-box') ? width : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  editors.push(editor);
  const scroller = document.createElement('div'); scroller.setAttribute('data-radix-scroll-area-viewport', '');
  const host = document.createElement('div'); scroller.appendChild(host); document.body.appendChild(scroller);
  editor.mount(host);
  const rendered = render(<TooltipProvider><DocumentMediaViews editor={editor} /></TooltipProvider>);
  act(() => editor.replaceBlocks(editor.document, [{ type, props: { url: '/clip.mp4', caption: 'Shared A', mediaWidth: 240, mediaHeight: 160 } }] as never));
  const id = (editor.document[0] as { id: string }).id;
  return { editor, id, rendered, scroller };
}

describe('document media control integration', () => {
  it('releases a keyboard panel on its owned document scroll, past a nested table viewport', async () => {
    const { editor, rendered, scroller } = open('video');
    const nested = document.createElement('div');
    nested.setAttribute('data-radix-scroll-area-viewport', '');
    nested.appendChild(scroller.firstElementChild!);
    scroller.appendChild(nested);
    rendered.rerender(<TooltipProvider><DocumentMediaViews editor={editor} viewport={scroller} /></TooltipProvider>);
    const trigger = screen.getByTestId('doc-media-video-trigger');
    act(() => trigger.focus()); fireEvent.keyDown(trigger, { key: 'Enter' });
    await screen.findByTestId('doc-media-video-panel');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
    vi.spyOn(screen.getByTestId('doc-media-box'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -100, 80, 50));
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.queryByTestId('doc-media-video-panel')).toBeNull());
  });
  it('focuses an already hovered video panel when Enter explicitly opens it', async () => {
    open('video');
    fireEvent.pointerEnter(screen.getByTestId('doc-media-frame'));
    const panel = await screen.findByTestId('doc-media-video-panel');
    const trigger = screen.getByTestId('doc-media-video-trigger');
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(panel).toHaveFocus();
  });
  it('selects the inline video without taking focus from its seek control', () => {
    const { editor } = open('video', 240);
    const seek = screen.getByTestId('seek');
    const thumb = seek.querySelector<HTMLElement>('[role="slider"]')!;
    act(() => thumb.focus());
    fireEvent.pointerDown(thumb, { button: 0, pointerId: 7, clientX: 20 });
    expect(thumb).toHaveFocus();
    expect(editor.prosemirrorState.selection.toJSON()).toMatchObject({ type: 'node' });
  });
  it('returns from a focused floating seek control to its video entry on Escape', async () => {
    open('video');
    const trigger = screen.getByTestId('doc-media-video-trigger');
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
    const panel = await screen.findByTestId('doc-media-video-panel');
    const thumb = panel.querySelector<HTMLElement>('[role="slider"]')!;
    act(() => thumb.focus());
    fireEvent.keyDown(thumb, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByTestId('doc-media-video-panel')).toBeNull();
  });
  it('opens the narrow video panel by keyboard and hands caption focus over', async () => {
    open('video');
    const trigger = screen.getByTestId('doc-media-video-trigger');
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
    const panel = await screen.findByTestId('doc-media-video-panel');
    expect(panel).toHaveFocus();
    expect(panel.querySelector('[data-testid="seek"]')).not.toBeNull();
    fireEvent.click(panel.querySelector('[data-testid="doc-media-caption-button"]')!);
    await waitFor(() => expect(screen.getByTestId('doc-media-caption-input')).toHaveFocus());
    expect(screen.queryByTestId('doc-media-video-panel')).toBeNull();
  });

  it('keeps a dirty caption copyable through a role change and rejects its late blur', async () => {
    const { editor, id, rendered } = open();
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    fireEvent.change(screen.getByTestId('doc-media-caption-input'), { target: { value: 'Local draft' } });
    act(() => { editor.isEditable = false; });
    rendered.rerender(<TooltipProvider><DocumentMediaViews editor={editor} readOnly /></TooltipProvider>);
    const field = screen.getByTestId('doc-media-caption-input');
    expect(field).toHaveValue('Local draft');
    expect(field).toHaveAttribute('readonly');
    fireEvent.blur(field);
    expect((editor.getBlock(id) as unknown as { props: { caption: string } }).props.caption).toBe('Shared A');
    act(() => { editor.isEditable = true; });
    rendered.rerender(<TooltipProvider><DocumentMediaViews editor={editor} /></TooltipProvider>);
    expect(screen.getByTestId('doc-media-caption-input')).toHaveValue('Local draft');
    fireEvent.keyDown(screen.getByTestId('doc-media-caption-input'), { key: 'Enter' });
    await waitFor(() => expect((editor.getBlock(id) as unknown as { props: { caption: string } }).props.caption).toBe('Local draft'));
  });

  it('preserves a dirty draft when a media view remounts and cancels to the latest shared caption', async () => {
    const { editor, id, rendered } = open();
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    fireEvent.change(screen.getByTestId('doc-media-caption-input'), { target: { value: 'Local draft' } });
    rendered.unmount();
    act(() => editor.updateBlock(id, { props: { caption: 'Shared B' } } as never));
    render(<TooltipProvider><DocumentMediaViews editor={editor} /></TooltipProvider>);
    expect(screen.getByTestId('doc-media-caption-input')).toHaveValue('Local draft');
    fireEvent.keyDown(screen.getByTestId('doc-media-caption-input'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    expect(screen.getByTestId('doc-media-caption-input')).toHaveValue('Shared B');
  });
  it('follows a clean shared caption without writing it back on blur', () => {
    const { editor, id } = open();
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    act(() => editor.updateBlock(id, { props: { caption: 'Shared B' } } as never));
    expect(screen.getByTestId('doc-media-caption-input')).toHaveValue('Shared B');
    const update = vi.spyOn(editor, 'updateBlock');
    fireEvent.blur(screen.getByTestId('doc-media-caption-input'));
    expect(update).not.toHaveBeenCalled();
  });

  it('retains a deleted target draft and restores it when the same block id returns', () => {
    const { editor, id } = open();
    const block = editor.getBlock(id);
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    fireEvent.change(screen.getByTestId('doc-media-caption-input'), { target: { value: 'Draft to keep' } });
    act(() => editor.removeBlocks([id]));
    expect(screen.getByTestId('doc-media-caption-retained').querySelector('input')).toHaveValue('Draft to keep');
    act(() => editor.replaceBlocks(editor.document, [block] as never));
    expect(screen.getByTestId('doc-media-caption-input')).toHaveValue('Draft to keep');
    expect(screen.queryByTestId('doc-media-caption-retained')).toBeNull();
  });

  it('hands focused editing actions to the video entry when permission becomes read-only', async () => {
    const { editor, rendered } = open('video');
    const trigger = screen.getByTestId('doc-media-video-trigger');
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
    const panel = await screen.findByTestId('doc-media-video-panel');
    const action = panel.querySelector<HTMLElement>('[data-testid="doc-media-caption-button"]')!;
    act(() => action.focus());
    expect(action).toHaveFocus();
    act(() => { editor.isEditable = false; });
    rendered.rerender(<TooltipProvider><DocumentMediaViews editor={editor} readOnly /></TooltipProvider>);
    expect(screen.getByTestId('doc-media-video-trigger')).toHaveFocus();
  });

  it('cancels a retained copyable draft with Escape', () => {
    const { editor, id } = open();
    fireEvent.click(screen.getByTestId('doc-media-caption-button'));
    fireEvent.change(screen.getByTestId('doc-media-caption-input'), { target: { value: 'Draft to discard' } });
    act(() => editor.removeBlocks([id]));
    const field = screen.getByTestId('doc-media-caption-retained').querySelector('input')!;
    field.focus(); fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByTestId('doc-media-caption-retained')).toBeNull();
  });

  it('keeps a new outside focus when an Escape close callback arrives later', async () => {
    open('video');
    const trigger = screen.getByTestId('doc-media-video-trigger');
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' });
    const panel = await screen.findByTestId('doc-media-video-panel');
    fireEvent.keyDown(panel, { key: 'Escape' });
    const outside = document.createElement('input'); document.body.appendChild(outside);
    act(() => outside.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(outside).toHaveFocus();
  });

});
