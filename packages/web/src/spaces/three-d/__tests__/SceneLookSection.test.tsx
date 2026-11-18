// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The appearance section of the properties panel (inner#1693 design 3.1-3.6).
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import * as sectionModule from '@web/spaces/three-d/SceneLookSection';

const ID = '11111111-1111-4111-8111-111111111111';
const IMAGE = '66666666-6666-4666-8666-666666666666';
const PARTS = [
  { key: '0', name: 'Jacket', color: '#ffffff', hasMap: true, unlit: false, line: false, mapRepeat: [3, 4] as [number, number], mapOffset: [0.5, 0] as [number, number], mapRotation: 30 },
  { key: '1', name: null, color: '#5f5f5f', hasMap: false, unlit: false, line: false },
  { key: 'd', name: null, color: '#f4f4f4', hasMap: false, unlit: true, line: false },
];

type Props = {
  objectId: string;
  parts: typeof PARTS | 'loading' | 'failed';
  look: Record<string, Record<string, unknown>>;
  selectedPart: string | null;
  mutable: boolean;
  onSelectPart: (part: string | null) => void;
  onCommand: (command: unknown) => void;
  onChoosePicture: (part: string) => void;
  showingPictures?: ReadonlySet<string>;
  uploadPercentOf?: (part: string) => number | null;
};

afterEach(() => cleanup());

/**
 * Renders the section.
 * @param props - Overrides.
 * @returns The mocks.
 * @throws {AssertionError} When SceneLookSection is not exported.
 */
function renderSection(props: Partial<Props> = {}): { onCommand: ReturnType<typeof vi.fn>; onSelectPart: ReturnType<typeof vi.fn>; onChoosePicture: ReturnType<typeof vi.fn> } {
  const Section = (sectionModule as Record<string, unknown>).SceneLookSection as React.ComponentType<Props> | undefined;
  expect(Section, 'SceneLookSection must be exported').toBeDefined();
  const Mounted = Section as React.ComponentType<Props>;
  const onCommand = vi.fn(); const onSelectPart = vi.fn(); const onChoosePicture = vi.fn();
  render(<TooltipProvider><Mounted objectId={ID} parts={PARTS} look={{}} selectedPart={null} mutable
    onSelectPart={onSelectPart} onCommand={onCommand} onChoosePicture={onChoosePicture} {...props} /></TooltipProvider>);
  return { onCommand, onSelectPart, onChoosePicture };
}

describe('SceneLookSection', () => {
  it('says the parts are loading, and that they cannot be changed when the model failed', () => {
    renderSection({ parts: 'loading' });
    expect(screen.getByTestId('scene-look-loading')).toBeTruthy();
    cleanup();
    renderSection({ parts: 'failed' });
    expect(screen.getByTestId('scene-look-unavailable')).toBeTruthy();
  });

  it('lists one row per part, naming unnamed parts by position and the default part last, with a dot on changed ones', () => {
    renderSection({ look: { 1: { color: '#ff0000' } } });
    const rows = screen.getAllByTestId(/^scene-look-part-/u).map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual(['scene-look-part-0', 'scene-look-part-1', 'scene-look-part-d']);
    expect(screen.getByTestId('scene-look-part-0').textContent).toContain('Jacket');
    expect(screen.queryByTestId('scene-look-modified-0')).toBeNull();
    expect(screen.getByTestId('scene-look-modified-1')).toBeTruthy();
  });

  it('selects a part by its row and clears it on a second click', () => {
    const { onSelectPart } = renderSection();
    fireEvent.click(screen.getByTestId('scene-look-part-1'));
    expect(onSelectPart).toHaveBeenLastCalledWith('1');
    cleanup();
    const again = renderSection({ selectedPart: '1' });
    fireEvent.click(screen.getByTestId('scene-look-part-1'));
    expect(again.onSelectPart).toHaveBeenLastCalledWith(null);
  });

  it('writes a preset as one look command with its values and leaves colour and picture alone', () => {
    const { onCommand } = renderSection({ selectedPart: '1' });
    fireEvent.click(screen.getByTestId('scene-look-preset-metal'));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({ type: 'look', id: ID, part: '1', set: { roughness: 0.15, metalness: 1, opacity: 1, transmission: 0 } });
  });

  it('disables finish controls on an unlit part and says why', () => {
    renderSection({ selectedPart: 'd' });
    expect((screen.getByTestId('scene-look-preset-metal') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('scene-look-unlit-note')).toBeTruthy();
  });

  it('disables every control without a note on a locked object or for a Viewer', () => {
    renderSection({ selectedPart: '0', mutable: false });
    expect((screen.getByTestId('scene-look-preset-metal') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('scene-look-reset-all') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('scene-look-locked-note')).toBeNull();
  });

  it('disables reset all on an object without a look and a part reset on an unchanged part', () => {
    renderSection({ selectedPart: '1' });
    expect((screen.getByTestId('scene-look-reset-all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('scene-look-reset-part') as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a user picture with its tiling, and turns the model picture off with none', () => {
    const user = renderSection({ selectedPart: '0', look: { 0: { map: IMAGE, mapRepeat: [2, 2] } } });
    fireEvent.click(screen.getByTestId('scene-look-remove-image'));
    expect(user.onCommand).toHaveBeenCalledWith({ type: 'look', id: ID, part: '0', set: { map: null, mapRepeat: null, mapOffset: null, mapRotation: null } });
    cleanup();
    const own = renderSection({ selectedPart: '0' });
    fireEvent.click(screen.getByTestId('scene-look-remove-image'));
    expect(own.onCommand).toHaveBeenCalledWith({ type: 'look', id: ID, part: '0', set: { map: 'none' } });
  });

  it('offers no remove on a part without any picture and asks for a picture instead', () => {
    const { onChoosePicture } = renderSection({ selectedPart: '1' });
    expect(screen.queryByTestId('scene-look-remove-image')).toBeNull();
    fireEvent.click(screen.getByTestId('scene-look-choose-image'));
    expect(onChoosePicture).toHaveBeenCalledWith('1');
  });

  it('resets every part with one null-part command', () => {
    const { onCommand } = renderSection({ look: { 1: { color: '#ff0000' } } });
    fireEvent.click(screen.getByTestId('scene-look-reset-all'));
    expect(onCommand).toHaveBeenCalledWith({ type: 'look', id: ID, part: null, set: {} });
  });

  it('starts the own picture\'s tiling, offset and rotation from the model and keeps the other axis when one box changes', () => {
    const { onCommand } = renderSection({ selectedPart: '0' });
    expect((screen.getByTestId('scene-look-repeat-0') as HTMLInputElement).value).toBe('3');
    expect((screen.getByTestId('scene-look-repeat-1') as HTMLInputElement).value).toBe('4');
    expect((screen.getByTestId('scene-look-offset-0') as HTMLInputElement).value).toBe('0.5');
    const box = screen.getByTestId('scene-look-repeat-0') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '2' } });
    fireEvent.blur(box);
    expect(onCommand).toHaveBeenCalledWith({ type: 'look', id: ID, part: '0', set: { mapRepeat: [2, 4] } });
  });

  it('changes one axis of a mirrored model picture and takes a mirrored count, refusing one nearer 0 than 0.01', () => {
    const mirrored = [{ ...PARTS[0]!, mapRepeat: [-1, 1] as [number, number], mapOffset: [60, 0] as [number, number] }, ...PARTS.slice(1)] as typeof PARTS;
    const { onCommand } = renderSection({ selectedPart: '0', parts: mirrored });
    const across = screen.getByTestId('scene-look-repeat-0') as HTMLInputElement;
    const down = screen.getByTestId('scene-look-repeat-1') as HTMLInputElement;
    expect(across.value).toBe('-1');
    fireEvent.change(down, { target: { value: '2' } });
    fireEvent.blur(down);
    expect(onCommand).toHaveBeenLastCalledWith({ type: 'look', id: ID, part: '0', set: { mapRepeat: [-1, 2] } });
    fireEvent.change(across, { target: { value: '-0.001' } });
    fireEvent.blur(across);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(across.value).toBe('-1');
    const offset = screen.getByTestId('scene-look-offset-1') as HTMLInputElement;
    fireEvent.change(offset, { target: { value: '80' } });
    fireEvent.blur(offset);
    expect(onCommand).toHaveBeenLastCalledWith({ type: 'look', id: ID, part: '0', set: { mapOffset: [60, 80] } });
  });

  it('shows a stored user picture\'s part at white only while the scene shows the picture, and in the model colour otherwise', () => {
    const swatch = (): HTMLElement => screen.getByTestId('scene-look-part-1').querySelector('span') as HTMLElement;
    renderSection({ look: { 1: { map: IMAGE } }, showingPictures: new Set() });
    expect(swatch().style.backgroundColor).toBe('rgb(95, 95, 95)');
    cleanup();
    renderSection({ look: { 1: { map: IMAGE } }, showingPictures: new Set([IMAGE]) });
    expect(swatch().style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('starts a user picture\'s tiling at one', () => {
    renderSection({ selectedPart: '0', look: { 0: { map: IMAGE } } });
    expect((screen.getByTestId('scene-look-repeat-0') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('scene-look-offset-0') as HTMLInputElement).value).toBe('0');
  });

  it('shows a running upload on its part row while no part is expanded', () => {
    renderSection({ uploadPercentOf: (part) => (part === '1' ? 40 : null) });
    expect(screen.getByTestId('scene-look-upload-1').textContent).toBe('40%');
    expect(screen.queryByTestId('scene-look-upload-0')).toBeNull();
  });
});
