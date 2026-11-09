// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { t } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { SceneGenerateDialog } from '@web/spaces/three-d/SceneGenerateDialog';
import { I23D, MODE_LABEL, MULTIVIEW, PROJECT, RAW_CATALOG, SPACE, T23D, projectImage, valueLabel } from '@web/spaces/three-d/__tests__/scene-generate-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: api.get,
  apiPost: api.post,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } };
});

const GENERATIONS = `/projects/${PROJECT}/three-d/${SPACE}/generations`;

/** What the dialog is opened with besides blank: an Agent proposal or a Retry. */
interface Fill {
  source: 'agent' | 'retry';
  origin: 'space' | 'agent';
  mode: 't23d' | 'i23d';
  prompt: string;
  params: Record<string, unknown>;
  images: { assetId: string; url: string; displayName: string | null }[];
}

/**
 * A retry or proposal fill.
 * @param over - What differs from a blank text-to-3D fill.
 * @returns The fill.
 */
function fillOf(over: Partial<Fill>): Fill {
  return { source: 'retry', origin: 'space', mode: 't23d', prompt: '', params: {}, images: [], ...over };
}

/**
 * A Project image as a view slot holds it.
 * @param assetId - Its asset id.
 * @returns The slot image.
 */
function view(assetId: string): Fill['images'][number] {
  return { assetId, url: `https://cdn.test/${assetId}.png`, displayName: `${assetId}.png` };
}

interface Rendered {
  onOpenChange: ReturnType<typeof vi.fn>;
  onSubmitted: ReturnType<typeof vi.fn>;
  rerender: (open: boolean, fill: Fill | null) => void;
}

/**
 * Render the dialog open inside the providers it needs.
 * @param fill - What it opens with; null for a blank opening.
 * @returns The handlers and a way to reopen it.
 */
function renderDialog(fill: Fill | null = null): Rendered {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onSubmitted = vi.fn();
  /**
   * The dialog at one open state and fill.
   * @param open - Whether it is open.
   * @param current - What it opens with.
   * @returns The element.
   */
  const tree = (open: boolean, current: Fill | null): React.JSX.Element => <QueryClientProvider client={client}><TooltipProvider>
    <SceneGenerateDialog projectId={PROJECT} spaceId={SPACE} open={open} onOpenChange={onOpenChange} fill={current} onSubmitted={onSubmitted} />
  </TooltipProvider></QueryClientProvider>;
  const result = render(tree(true, fill));
  return { onOpenChange, onSubmitted, rerender: (open, next) => result.rerender(tree(open, next)) };
}

/**
 * The open dialog, once the catalog has drawn its settings.
 * @returns The dialog element.
 */
async function ready(): Promise<HTMLElement> {
  await screen.findByTestId('generate-param-texture-toggle');
  return screen.getByRole('dialog');
}

/**
 * The image a view slot shows, by its address.
 * @param index - The slot, front first.
 * @returns The address, or null when the slot is empty.
 */
function slotImage(index: number): string | null {
  return screen.getByTestId(`scene-generate-view-${index}`).querySelector('img')?.getAttribute('src') ?? null;
}

/**
 * Which view slots offer to be filled now.
 * @returns One flag per slot, front first.
 */
function addable(): boolean[] {
  return [0, 1, 2, 3].map((index) => screen.queryByTestId(`scene-generate-view-${index}-add`) !== null);
}

/**
 * The messages one toast type was shown with.
 * @param fn - The mocked toast method.
 * @returns Its first arguments.
 */
function shown(fn: unknown): unknown[] {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
}

/**
 * Switch the way to generate from the footer pill.
 * @param user - The user driving the page.
 * @param mode - The mode to pick.
 */
async function pickMode(user: ReturnType<typeof userEvent.setup>, mode: 't23d' | 'i23d'): Promise<void> {
  await user.click(screen.getByTestId('scene-generate-mode'));
  await user.click(await screen.findByTestId(`scene-generate-mode-${mode}`));
}

/**
 * Open a setting's menu and pick a value.
 * @param user - The user driving the page.
 * @param param - The setting.
 * @param value - The value to pick.
 */
async function pick(user: ReturnType<typeof userEvent.setup>, param: string, value: string): Promise<void> {
  await user.click(screen.getByTestId(`generate-param-${param}-menu`));
  await user.click(await screen.findByTestId(`generate-param-${param}-option-${value}`));
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (url: string) => {
    if (url === '/models') return RAW_CATALOG;
    if (url === `/projects/${PROJECT}/assets`) return { items: [projectImage('a1'), projectImage('a2')], nextCursor: null };
    throw new Error(`unexpected GET ${url}`);
  });
});
afterEach(() => {
  cleanup();
  resetRunOnceForTests();
  vi.clearAllMocks();
});

describe('SceneGenerateDialog (inner#1691 design 7.1)', () => {
  it('switches between Text to 3D and Image to 3D from the bottom bar, swapping the middle section whole', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    expect(screen.getByTestId('scene-generate-mode')).toHaveTextContent(MODE_LABEL.t23d);
    expect(screen.getByTestId('scene-generate-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-generate-view-0')).toBeNull();

    await pickMode(user, 'i23d');
    expect(screen.getByTestId('scene-generate-mode')).toHaveTextContent(MODE_LABEL.i23d);
    expect(screen.queryByTestId('scene-generate-prompt')).toBeNull();
    expect([0, 1, 2, 3].map((index) => screen.queryByTestId(`scene-generate-view-${index}`) !== null)).toEqual([true, true, true, true]);
  });

  it('draws the settings all three entries declare on top and the current mode\'s own settings in the middle', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    const common = screen.getByTestId('scene-generate-common');
    for (const name of ['texture', 'pbr', 'smart_low_poly', 'generate_parts', 'export_uv', 'rig_skeleton']) expect(within(common).getByTestId(`generate-param-${name}-toggle`)).toBeInTheDocument();
    // Rig skeleton is the last common switch and starts off (inner#1692).
    const toggles = within(common).getAllByTestId(/^generate-param-.*-toggle$/u);
    expect(toggles.at(-1)).toHaveAttribute('data-testid', 'generate-param-rig_skeleton-toggle');
    expect(toggles.at(-1)).toHaveAttribute('aria-checked', 'false');
    for (const name of ['face_limit', 'model_seed', 'texture_seed']) expect(within(common).getByTestId(`generate-param-${name}-input`)).toBeInTheDocument();
    expect(within(common).getByTestId('generate-param-geometry_quality-menu')).toBeInTheDocument();
    expect(within(common).queryByTestId('generate-param-negative_prompt-input')).toBeNull();
    expect(within(common).queryByTestId('generate-param-texture_alignment-menu')).toBeNull();

    const textSection = screen.getByTestId('scene-generate-mode-section');
    expect(within(textSection).getByTestId('generate-param-negative_prompt-input')).toBeInTheDocument();
    expect(within(textSection).queryByTestId('generate-param-enable_image_autofix-toggle')).toBeNull();

    await pickMode(user, 'i23d');
    const imageSection = screen.getByTestId('scene-generate-mode-section');
    expect(within(imageSection).getByTestId('generate-param-texture_alignment-menu')).toBeInTheDocument();
    expect(within(imageSection).getByTestId('generate-param-orientation-menu')).toBeInTheDocument();
    expect(within(imageSection).getByTestId('generate-param-enable_image_autofix-toggle')).toBeInTheDocument();
    expect(within(imageSection).queryByTestId('generate-param-negative_prompt-input')).toBeNull();
  });

  it('shows each choice as its held value beside its name, listing every value only once opened', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    const menu = screen.getByTestId('generate-param-texture_quality-menu');
    expect(menu).toHaveTextContent('Standard');
    expect(menu.parentElement).toHaveTextContent(t('canvas.generatePanel.param.texture_quality'));
    expect(screen.queryByTestId('generate-param-texture_quality-option-fast')).toBeNull();

    await user.click(menu);
    expect(await screen.findByTestId('generate-param-texture_quality-option-standard')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('generate-param-texture_quality-option-fast')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('generate-param-texture_quality-option-detailed')).toHaveAttribute('aria-pressed', 'false');
  });

  it('lets the view slots fill only in front, left, back, right order', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await pickMode(user, 'i23d');
    expect(addable()).toEqual([true, false, false, false]);

    await user.click(screen.getByTestId('scene-generate-view-0-add'));
    await user.click(await screen.findByTestId('scene-generate-view-pick-project'));
    await user.click(await screen.findByTestId('scene-image-picker-item-a1'));
    await waitFor(() => expect(slotImage(0)).toBe('https://cdn.test/a1.png'));
    expect(addable()).toEqual([false, true, false, false]);
  });

  it('moves the later views forward when a middle one is removed', async () => {
    const user = userEvent.setup();
    renderDialog(fillOf({ mode: 'i23d', images: [view('front'), view('left'), view('back')] }));
    await ready();
    expect([0, 1, 2, 3].map(slotImage)).toEqual(['https://cdn.test/front.png', 'https://cdn.test/left.png', 'https://cdn.test/back.png', null]);

    await user.click(screen.getByTestId('scene-generate-view-1-change'));
    await user.click(await screen.findByTestId('scene-generate-view-remove'));
    expect([0, 1, 2, 3].map(slotImage)).toEqual(['https://cdn.test/front.png', 'https://cdn.test/back.png', null, null]);
    expect(addable()).toEqual([false, false, true, false]);
  });

  it('submits the single-image entry when only the front view is filled', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ task_id: 'task-1', row_id: 'row-1', status: 'pending' });
    renderDialog(fillOf({ mode: 'i23d', images: [view('a1')] }));
    await ready();
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0]![0]).toBe(GENERATIONS);
    expect(api.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ mode: 'i23d', model: I23D, image_asset_ids: ['a1'], origin: 'space' }));
    expect(api.post.mock.calls[0]![2]).toEqual(expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }));
  });

  it('submits the multi-view entry, views in order, when more than the front is filled', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ task_id: 'task-1', row_id: 'row-1', status: 'pending' });
    renderDialog(fillOf({ mode: 'i23d', origin: 'agent', images: [view('a1'), view('a2')] }));
    await ready();
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ mode: 'i23d', model: MULTIVIEW, image_asset_ids: ['a1', 'a2'], origin: 'agent' }));
  });

  it('submits the text entry with the prompt as typed', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ task_id: 'task-1', row_id: 'row-1', status: 'pending' });
    renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A brass desk lamp');
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ mode: 't23d', model: T23D, prompt: 'A brass desk lamp', origin: 'space' }));
  });

  it('shows a control a forced value locks as aria-disabled, and a click says that force\'s reason without changing it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    // PBR is on by default, so Texture is held on by pbr_needs_texture.
    const texture = screen.getByTestId('generate-param-texture-toggle');
    expect(texture).toHaveAttribute('aria-disabled', 'true');
    expect(texture).not.toBeDisabled();
    await user.click(texture);
    expect(texture).toHaveAttribute('aria-checked', 'true');
    expect(shown(toast.warning)).toEqual([t('spaces.threeD.force.pbr_needs_texture')]);

    await user.click(screen.getByTestId('generate-param-generate_parts-toggle'));
    const pbr = screen.getByTestId('generate-param-pbr-toggle');
    expect(pbr).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('generate-param-texture-toggle')).toHaveAttribute('aria-checked', 'false');
    expect(pbr).toHaveAttribute('aria-disabled', 'true');
    await user.click(pbr);
    expect(pbr).toHaveAttribute('aria-checked', 'false');
    expect(shown(toast.warning)).toEqual([t('spaces.threeD.force.pbr_needs_texture'), t('spaces.threeD.force.parts_geometry_only')]);
  });

  it('holds the texture version at v3.5 under Fast, its menu saying why when pressed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await pick(user, 'texture_quality', 'fast');
    expect(screen.getByTestId('generate-param-texture_version-menu')).toHaveTextContent(valueLabel('texture_version', 'v3.5'));
    const version = screen.getByTestId('generate-param-texture_version-menu');
    expect(version).toHaveAttribute('aria-disabled', 'true');
    await user.click(version);
    expect(screen.queryByTestId('generate-param-texture_version-option-v3.0')).toBeNull();
    expect(version).toHaveTextContent(valueLabel('texture_version', 'v3.5'));
    expect(shown(toast.warning)).toEqual([t('spaces.threeD.force.fast_uses_v35')]);
  });

  it('marks a value outside its rule and keeps Generate unavailable until it is fixed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A lamp');
    expect(screen.getByTestId('scene-generate-run')).toBeEnabled();

    const faceLimit = screen.getByTestId('generate-param-face_limit-input');
    await user.type(faceLimit, '0');
    expect(faceLimit).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('scene-generate-run')).toBeDisabled();

    // Smart low-poly bounds the face limit to 500 to 20000.
    await user.clear(faceLimit);
    await user.click(screen.getByTestId('generate-param-smart_low_poly-toggle'));
    await user.type(faceLimit, '30000');
    expect(faceLimit).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('scene-generate-run')).toBeDisabled();

    await user.clear(faceLimit);
    await user.type(faceLimit, '20000');
    expect(faceLimit).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('scene-generate-run')).toBeEnabled();
  });

  it('opens blank with the last input cleared, and a retry or proposal fill replaces everything', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A lamp');
    await pick(user, 'texture_quality', 'detailed');

    rerender(false, null);
    rerender(true, null);
    await ready();
    expect(screen.getByTestId('scene-generate-prompt')).toHaveValue('');
    expect(screen.getByTestId('generate-param-texture_quality-menu')).toHaveTextContent(valueLabel('texture_quality', 'standard'));

    await user.type(screen.getByTestId('scene-generate-prompt'), 'Something else');
    rerender(true, fillOf({ source: 'agent', origin: 'agent', prompt: 'A stone lion', params: { texture_quality: 'detailed', geometry_quality: 'detailed', negative_prompt: 'base', rig_skeleton: true } }));
    await waitFor(() => expect(screen.getByTestId('scene-generate-prompt')).toHaveValue('A stone lion'));
    // A proposal that asks for a skeleton opens with the switch on (inner#1692 acceptance 3).
    expect(screen.getByTestId('generate-param-rig_skeleton-toggle')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('generate-param-negative_prompt-input')).toHaveValue('base');
    expect(screen.getByTestId('generate-param-texture_quality-menu')).toHaveTextContent(valueLabel('texture_quality', 'detailed'));
    expect(screen.getByTestId('generate-param-geometry_quality-menu')).toHaveTextContent(valueLabel('geometry_quality', 'detailed'));

    rerender(false, null);
    rerender(true, fillOf({ mode: 'i23d', images: [view('a1')], params: { texture_alignment: 'geometry' } }));
    await ready();
    expect(screen.getByTestId('scene-generate-mode')).toHaveTextContent(MODE_LABEL.i23d);
    expect(slotImage(0)).toBe('https://cdn.test/a1.png');
    expect(screen.getByTestId('generate-param-texture_alignment-menu')).toHaveTextContent(valueLabel('texture_alignment', 'geometry'));
    expect(screen.getByTestId('generate-param-texture_quality-menu')).toHaveTextContent(valueLabel('texture_quality', 'standard'));
  });

  it('closes while the submit waits, and the answer still hands its row on', async () => {
    const user = userEvent.setup();
    const answer = Promise.withResolvers<unknown>();
    api.post.mockReturnValue(answer.promise);
    const { onOpenChange, onSubmitted } = renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A lamp');
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(screen.getByTestId('scene-generate-run')).toHaveAttribute('aria-busy', 'true'));

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmitted).not.toHaveBeenCalled();

    answer.resolve({ task_id: 'task-1', row_id: 'row-1', status: 'pending' });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('row-1'));
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('says a refusal of ours in the words the server wrote', async () => {
    const user = userEvent.setup();
    const sentence = 'View slot 2 (left) is not an image in this Project.';
    api.post.mockRejectedValue(new ApiException({ status: 422, message: sentence, fromServer: true }));
    renderDialog(fillOf({ mode: 'i23d', images: [view('a1'), view('a2')] }));
    await ready();
    await user.click(screen.getByTestId('scene-generate-run'));

    await waitFor(() => expect(shown(toast.error)).toEqual([sentence]));
  });

  it('says the model list is unavailable and closes when it cannot load', async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === '/models') throw new Error('the model list is down');
      throw new Error(`unexpected GET ${url}`);
    });
    const { onOpenChange } = renderDialog();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(shown(toast.error)).toEqual([t('canvas.generatePanel.catalogUnavailable')]);
  });

  it('says no model is configured and closes when the list serves no 3D model', async () => {
    api.get.mockImplementation(async (url: string) => {
      if (url === '/models') return { ...RAW_CATALOG, three_d: [] };
      throw new Error(`unexpected GET ${url}`);
    });
    const { onOpenChange } = renderDialog();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(shown(toast.warning)).toEqual([t('canvas.generatePanel.catalogNoModels')]);
  });

  it('shows which model runs', async () => {
    renderDialog();
    await ready();
    expect(screen.getByTestId('scene-generate-model')).toHaveTextContent('Tripo H3.1');
  });

  it('stays open with every input kept when the credits are not enough', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new ApiException({ status: 402, message: 'Insufficient credits', fromServer: true }));
    const { onOpenChange, onSubmitted } = renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A lamp');
    await pick(user, 'texture_quality', 'detailed');
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    const credits = t('canvas.generatePanel.errorCredits');
    await waitFor(() => expect(screen.queryByText(credits) !== null || shown(toast.error).includes(credits)).toBe(true));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByTestId('scene-generate-prompt')).toHaveValue('A lamp');
    expect(screen.getByTestId('generate-param-texture_quality-menu')).toHaveTextContent(valueLabel('texture_quality', 'detailed'));
    expect(screen.getByTestId('scene-generate-run')).toBeEnabled();
  });

  it('closes and hands the failed row over when the server opened the row but could not start it', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ task_id: 'task-9', row_id: 'row-9', status: 'failed' });
    const { onOpenChange, onSubmitted } = renderDialog();
    await ready();
    await user.type(screen.getByTestId('scene-generate-prompt'), 'A lamp');
    await user.click(screen.getByTestId('scene-generate-run'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSubmitted).toHaveBeenCalledWith('row-9');
  });

  it('shows the credits the price table gives for the settings as resolved', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    const credit = screen.getByTestId('scene-generate-credit');
    // Text to 3D, Standard texture: $0.24.
    await waitFor(() => expect(credit).toHaveTextContent(/^24$/));
    // Image to 3D, Standard texture: $0.36.
    await pickMode(user, 'i23d');
    await waitFor(() => expect(credit).toHaveTextContent(/^36$/));
    await pickMode(user, 't23d');
    await waitFor(() => expect(credit).toHaveTextContent(/^24$/));
    // Detailed texture: $0.36.
    await pick(user, 'texture_quality', 'detailed');
    await waitFor(() => expect(credit).toHaveTextContent(/^36$/));
    // Separate parts forces geometry only, priced as $0.12 plus $0.24 whatever the texture quality held.
    await user.click(screen.getByTestId('generate-param-generate_parts-toggle'));
    await waitFor(() => expect(credit).toHaveTextContent(/^36$/));
    // Detailed geometry adds $0.24.
    await pick(user, 'geometry_quality', 'detailed');
    await waitFor(() => expect(credit).toHaveTextContent(/^60$/));
  });
});

const upload = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  runMediaUpload: upload.run,
}));

/** The callbacks the dialog handed the one upload it started. */
interface UploadSinks {
  onProgress?: (fraction: number) => void;
  onSuccess: (stored: { assetId: string; fileUrl: string; kind: string; width: number | null; height: number | null }) => void;
  onFailure: (outcome: { reason: string }) => void;
}

/**
 * Start an upload into the front view slot from its menu and keep the upload pending.
 * @param user - The pointer driving the dialog.
 * @returns The callbacks of the upload the dialog started.
 */
async function startFrontUpload(user: ReturnType<typeof userEvent.setup>): Promise<UploadSinks> {
  let sinks: UploadSinks | undefined;
  upload.run.mockImplementation((_file: File, _context: unknown, deps: UploadSinks) => {
    sinks = deps;
    return new Promise<void>(() => undefined);
  });
  await pickMode(user, 'i23d');
  await user.click(screen.getByTestId('scene-generate-view-0-add'));
  await user.click(await screen.findByTestId('scene-generate-view-upload'));
  await user.upload(screen.getByTestId('scene-generate-view-file-input'), new File(['png'], 'front.png', { type: 'image/png' }));
  await waitFor(() => expect(upload.run).toHaveBeenCalledTimes(1));
  if (sinks === undefined) throw new Error('the dialog started no upload');
  return sinks;
}

describe('SceneGenerateDialog view slot uploads (inner#1691 design 7.1)', () => {
  beforeEach(() => { upload.run.mockReset(); });

  it('shows the upload progress in its slot and keeps Generate unavailable until it lands', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    const sinks = await startFrontUpload(user);

    sinks.onProgress?.(0.5);
    await waitFor(() => expect(within(screen.getByTestId('scene-generate-view-0')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50'));
    expect(screen.getByTestId('scene-generate-run')).toBeDisabled();

    sinks.onSuccess({ assetId: 'up1', fileUrl: 'https://cdn.test/up1.png', kind: 'image', width: 512, height: 512 });
    await waitFor(() => expect(slotImage(0)).toBe('https://cdn.test/up1.png'));
    expect(within(screen.getByTestId('scene-generate-view-0')).queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('scene-generate-run')).toBeEnabled();
  });

  it('keeps a failed upload in its slot, says so there, and offers nothing after it until it is replaced or removed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await ready();
    const sinks = await startFrontUpload(user);

    sinks.onFailure({ reason: 'network' });
    await waitFor(() => expect(screen.getByTestId('scene-generate-view-0-error')).toBeInTheDocument());
    expect(slotImage(0)).toBeNull();
    expect(addable()).toEqual([true, false, false, false]);
    expect(screen.getByTestId('scene-generate-run')).toBeDisabled();

    await user.click(screen.getByTestId('scene-generate-view-0-add'));
    await user.click(await screen.findByTestId('scene-generate-view-remove'));
    expect(screen.queryByTestId('scene-generate-view-0-error')).toBeNull();
    expect(addable()).toEqual([true, false, false, false]);
  });

  it('leaves the later views where they are when replacing the front one fails', async () => {
    const user = userEvent.setup();
    let sinks: UploadSinks | undefined;
    upload.run.mockImplementation((_file: File, _context: unknown, deps: UploadSinks) => {
      sinks = deps;
      return new Promise<void>(() => undefined);
    });
    renderDialog(fillOf({ mode: 'i23d', images: [view('front'), view('left')] }));
    await ready();
    await user.click(screen.getByTestId('scene-generate-view-0-change'));
    await user.click(await screen.findByTestId('scene-generate-view-upload'));
    await user.upload(screen.getByTestId('scene-generate-view-file-input'), new File(['png'], 'new-front.png', { type: 'image/png' }));
    await waitFor(() => expect(upload.run).toHaveBeenCalledTimes(1));

    sinks!.onFailure({ reason: 'network' });
    await waitFor(() => expect(screen.getByTestId('scene-generate-view-0-error')).toBeInTheDocument());
    expect(slotImage(1)).toBe('https://cdn.test/left.png');
    expect(screen.getByTestId('scene-generate-run')).toBeDisabled();
  });
});
