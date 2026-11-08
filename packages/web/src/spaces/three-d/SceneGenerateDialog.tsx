// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus, RefreshCw, Upload, X } from 'lucide-react';
import {
  SCENE_VIEW_SLOTS, THREE_D_GENERATION_MODES, applyForces, checkParamCombination, getLocale, resolveParams,
  type ModelEntry, type ParamViolation, type SceneGenerationBody, type ThreeDGenerationMode,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { assetsApi } from '@web/data/api/assets';
import { projectImagesQueryKey, submitSceneGeneration } from '@web/data/api/scene';
import { ApiException } from '@web/data/api/types';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { runMediaUpload } from '@web/data/upload/media-upload';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { PanelRunFooter } from '@web/spaces/canvas/_shared/PanelRunFooter';
import { creditEstimateText } from '@web/spaces/canvas/generate/credit-estimate-text';
import { executeErrorMessage } from '@web/spaces/canvas/generate/execute-error-message';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import type { ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { ParamOptionGroup, type ParamOption } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { useCreditEstimate } from '@web/spaces/canvas/generate/use-credit-estimate';
import { SCENE_VIEW_ACCEPT, SceneImagePickerDialog } from '@web/spaces/three-d/SceneImagePickerDialog';
import { SCENE_MODE_LABELS, commonSceneParams, sceneEntryFor, sceneGenerateIntent } from '@web/spaces/three-d/scene-generation';
import type { SceneGenerateFill, SceneViewImage } from '@web/stores/scene-proposals';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';

interface SceneGenerateDialogProps {
  projectId: string;
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What it opens with; null for a blank opening. */
  fill: SceneGenerateFill | null;
  /** Told the row the server opened, once the dialog has closed on it (pending or failed). */
  onSubmitted: (rowId: string) => void;
  /** Where focus goes once it closes. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * One view slot: a picture, an upload on its way, or an upload that failed,
 * which keeps its place until the user replaces or removes it.
 */
type ViewSlot = ({ kind: 'image' } & SceneViewImage) | { kind: 'uploading'; id: string; percent: number } | { kind: 'failed' };

const NO_ENTRIES: readonly ModelEntry[] = [];

/**
 * Whether a resolved value is one a setting can be sent as.
 * @param value - The value.
 * @returns True for a string, number, boolean or null.
 */
function isSettingValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Put a picture or an upload into a slot: the slot it names, or the next empty one.
 * @param views - The slots.
 * @param index - The slot.
 * @param slot - What goes in.
 * @returns The slots, at most four.
 */
function put(views: readonly ViewSlot[], index: number, slot: ViewSlot): ViewSlot[] {
  const next = [...views];
  if (index < next.length) next[index] = slot;
  else next.push(slot);
  return next.slice(0, SCENE_VIEW_SLOTS.length);
}

/**
 * The 3D Space's generation dialog (inner#1691 design 7.1): the settings every
 * entry shares on top, the current mode's own content in the middle, the mode
 * switch, the estimate and Generate in the bottom row. Opened blank it starts
 * empty; opened from a proposal or a Retry it holds exactly what that carries.
 * It closes on the server's answer, a row that failed to start included, and
 * stays open with everything kept on a refusal. Closed while a submit waits,
 * the submit carries on: the answer still opens the task list on its row.
 * @param props - The Space, the open state, the fill and the submit hand-off.
 * @param props.projectId - The project.
 * @param props.spaceId - The 3D Space the run's row lands in.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Opens or closes it.
 * @param props.fill - What it opens with.
 * @param props.onSubmitted - Told the row once the dialog closed on it.
 * @param props.onCloseAutoFocus - Where focus goes once it closes.
 * @returns The dialog.
 */
export const SceneGenerateDialog = React.memo(function SceneGenerateDialog({ projectId, spaceId, open, onOpenChange, fill, onSubmitted, onCloseAutoFocus }: SceneGenerateDialogProps): React.JSX.Element {
  const t = useTranslation();
  const intent = sceneGenerateIntent(spaceId);
  const submitting = useRunning(intent) !== undefined;
  // Each opening, and each new fill while open, starts the form over.
  const [version, setVersion] = React.useState(0);
  const [seen, setSeen] = React.useState({ open, fill });
  if (seen.open !== open || seen.fill !== fill) {
    setSeen({ open, fill });
    if (open) setVersion((value) => value + 1);
  }
  const close = React.useCallback((): void => onOpenChange(false), [onOpenChange]);
  // A model list that failed, cannot load offline or serves no 3D model leaves
  // nothing to build the dialog from; it says so and closes, as the Canvas
  // generation panel does (generate-panel-frame.tsx).
  const catalog = useQuery(modelCatalogQuery());
  const catalogError = catalog.isError && catalog.data === undefined;
  const catalogOffline = !catalogError && catalog.data === undefined && catalog.fetchStatus === 'paused';
  const noModels = catalog.data !== undefined && catalog.data.three_d.length === 0;
  React.useEffect(() => {
    if (!open) return;
    if (catalogError) toast.error(t('canvas.generatePanel.catalogUnavailable'), { id: 'scene-generate-catalog-unavailable' });
    else if (catalogOffline) toast.warning(t('canvas.generatePanel.catalogOffline'), { id: 'scene-generate-catalog-offline' });
    else if (noModels) toast.warning(t('canvas.generatePanel.catalogNoModels'), { id: 'scene-generate-catalog-no-models' });
    else return;
    onOpenChange(false);
  }, [open, catalogError, catalogOffline, noModels, onOpenChange, t]);
  const description = fill?.source === 'agent' ? t('spaces.threeD.generateDialog.descriptionAgent')
    : fill?.source === 'retry' ? t('spaces.threeD.generateDialog.descriptionRetry') : t('spaces.threeD.generateDialog.descriptionBlank');
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className='max-w-[640px]' onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader><DialogTitle>{t('spaces.threeD.generate')}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <SceneGenerateForm key={version} projectId={projectId} spaceId={spaceId} fill={fill} intent={intent} submitting={submitting} onClose={close} onSubmitted={onSubmitted} />
    </DialogContent>
  </Dialog>;
});

interface SceneGenerateFormProps {
  projectId: string;
  spaceId: string;
  fill: SceneGenerateFill | null;
  intent: string;
  submitting: boolean;
  onClose: () => void;
  onSubmitted: (rowId: string) => void;
}

/**
 * The dialog's inputs, settings and bottom row; remounted for each opening.
 * @param props - As the dialog hands them down.
 * @param props.projectId - The project.
 * @param props.spaceId - The 3D Space.
 * @param props.fill - What it starts with.
 * @param props.intent - The run-once intent of Generate.
 * @param props.submitting - Whether a submit waits.
 * @param props.onClose - Closes the dialog, also while a submit waits.
 * @param props.onSubmitted - Told the row the server opened.
 * @returns The form.
 */
function SceneGenerateForm({ projectId, spaceId, fill, intent, submitting, onClose, onSubmitted }: SceneGenerateFormProps): React.JSX.Element {
  const t = useTranslation();
  const locale = getLocale();
  const queryClient = useQueryClient();
  const catalog = useQuery(modelCatalogQuery());
  const entries = catalog.data?.three_d ?? NO_ENTRIES;
  const [mode, setMode] = React.useState<ThreeDGenerationMode>(fill?.mode ?? 't23d');
  const [prompt, setPrompt] = React.useState(fill?.prompt ?? '');
  const [params, setParams] = React.useState<Record<string, unknown>>(() => fill?.params ?? {});
  const [views, setViews] = React.useState<ViewSlot[]>(() => (fill?.images ?? []).slice(0, SCENE_VIEW_SLOTS.length).map((image) => ({ kind: 'image', ...image })));
  const [picking, setPicking] = React.useState<number | null>(null);
  const origin = fill?.origin ?? 'space';

  const entry = sceneEntryFor(entries, mode, views.length);
  const common = React.useMemo(() => commonSceneParams(entries), [entries]);
  const resolved = React.useMemo(() => (entry ? resolveParams(entry, params) : {}), [entry, params]);
  // What is sent: the panel's settings as they resolve, never the view params.
  const settings = React.useMemo((): SceneGenerationBody['params'] => Object.fromEntries(Object.entries(resolved).filter(
    (pair): pair is [string, string | number | boolean | null] => entry?.params[pair[0]]?.fill === 'panel' && isSettingValue(pair[1]),
  )), [resolved, entry]);
  const violations = React.useMemo(() => (entry ? checkParamCombination(entry, mode === 't23d' ? { ...settings, prompt } : settings) : []), [entry, mode, settings, prompt]);
  const ruleText = React.useCallback((violation: ParamViolation): string => {
    switch (violation.rule) {
      case 'bounds': return t('spaces.threeD.generateDialog.rule.bounds', { min: violation.min ?? 0, max: violation.max ?? 0 });
      case 'integer': return t('spaces.threeD.generateDialog.rule.integer');
      case 'max_length':
      case 'prompt_max_length': return t('spaces.threeD.generateDialog.rule.length', { max: violation.max });
      default: return t('spaces.threeD.generateDialog.rule.values');
    }
    // The sentences follow the locale, which `t` itself does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale]);
  const errors = React.useMemo(() => Object.fromEntries(violations.map((violation) => [violation.param, ruleText(violation)])), [violations, ruleText]);
  const locked = React.useMemo(() => {
    const held: Record<string, string> = {};
    for (const [param, force] of Object.entries(applyForces(entry?.forces ?? [], resolved).forcedBy)) {
      if (force.lock) held[param] = t(`spaces.threeD.force.${force.id}`);
    }
    return held;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, resolved, t, locale]);

  /**
   * Whether a control's condition holds, so it is drawn.
   * @param control - The control.
   * @returns True when it has no condition or its param survives resolution.
   */
  const shown = React.useCallback((control: ModelControl): boolean => entry?.params[control.name]?.when === undefined || resolved[control.name] !== undefined, [entry, resolved]);
  const commonToggles = React.useCallback((control: ModelControl): boolean => common.has(control.name) && control.kind === 'toggle' && shown(control), [common, shown]);
  const commonChoices = React.useCallback((control: ModelControl): boolean => common.has(control.name) && control.kind === 'choice' && shown(control), [common, shown]);
  const commonNumbers = React.useCallback((control: ModelControl): boolean => common.has(control.name) && control.kind === 'integer' && shown(control), [common, shown]);
  const ownSettings = React.useCallback((control: ModelControl): boolean => !common.has(control.name) && shown(control), [common, shown]);
  const change = React.useCallback((partial: Record<string, unknown>): void => setParams((previous) => ({ ...previous, ...partial })), []);

  const estimateInput = React.useMemo(() => ({ params: settings, ...(mode === 't23d' ? { prompt } : {}) }), [settings, mode, prompt]);
  const estimate = useCreditEstimate(entry, estimateInput, catalog.data?.credit_multiplier ?? 1);
  const creditText = estimate ? creditEstimateText(estimate, t) : '';

  // Uploads into the view slots; any still running is cancelled when the form goes.
  const uploads = React.useRef(new Set<AbortController>());
  React.useEffect(() => {
    const running = uploads.current;
    return (): void => { for (const controller of running) controller.abort(); };
  }, []);
  const startUpload = React.useCallback((index: number, file: File): void => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    uploads.current.add(controller);
    setViews((previous) => put(previous, index, { kind: 'uploading', id, percent: 0 }));
    /**
     * Land the upload in its slot, or mark the slot failed where it stands, so
     * no later view moves into a place the user did not put it.
     * @param image - The stored picture, or null when the upload did not give one.
     */
    const settle = (image: SceneViewImage | null): void => {
      if (controller.signal.aborted || !uploads.current.delete(controller)) return;
      setViews((previous) => previous.map((slot) => (slot.kind === 'uploading' && slot.id === id ? (image === null ? { kind: 'failed' } : { kind: 'image', ...image }) : slot)));
      if (image !== null) void queryClient.invalidateQueries({ queryKey: projectImagesQueryKey(projectId) });
    };
    void runMediaUpload(file, { projectId, spaceId }, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile,
      requestTicket: assetsApi.requestUploadTicket,
      sendToIngest: sendFileAndFinish,
      onProgress: (fraction) => {
        if (controller.signal.aborted) return;
        const percent = Math.round(fraction * 100);
        setViews((previous) => previous.map((slot) => (slot.kind === 'uploading' && slot.id === id ? { ...slot, percent } : slot)));
      },
      onSuccess: (stored) => settle(stored.kind === 'image' ? { assetId: stored.assetId, url: stored.fileUrl, displayName: file.name } : null),
      onFailure: () => settle(null),
    }, controller.signal).catch(() => settle(null));
  }, [projectId, spaceId, queryClient]);

  const fileInput = React.useRef<HTMLInputElement>(null);
  const uploadSlot = React.useRef(0);
  const chooseFile = React.useCallback((index: number): void => {
    uploadSlot.current = index;
    fileInput.current?.click();
  }, []);
  const fileChosen = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file !== undefined) startUpload(uploadSlot.current, file);
  }, [startUpload]);
  const removeView = React.useCallback((index: number): void => setViews((previous) => previous.filter((_, i) => i !== index)), []);
  const pickerOpenChange = React.useCallback((next: boolean): void => { if (!next) setPicking(null); }, []);
  const picked = React.useCallback((image: SceneViewImage): void => {
    if (picking === null) return;
    setViews((previous) => put(previous, picking, { kind: 'image', ...image }));
  }, [picking]);
  const pickedFile = React.useCallback((file: File): void => {
    if (picking !== null) startUpload(picking, file);
  }, [picking, startUpload]);

  // Views fill in order: one whose upload failed is replaced or removed before the next is offered.
  const failedView = views.some((slot) => slot.kind === 'failed');
  const viewsReady = views.length > 0 && views.every((slot) => slot.kind === 'image');
  const ready = entry !== undefined && violations.length === 0 && (mode === 't23d' ? prompt.trim() !== '' : viewsReady);
  const submit = React.useCallback((): void => {
    if (entry === undefined || !ready) return;
    const body: SceneGenerationBody = {
      mode, model: entry.name, params: settings, origin,
      ...(mode === 't23d' ? { prompt } : { image_asset_ids: views.flatMap((slot) => (slot.kind === 'image' ? [slot.assetId] : [])) }),
    };
    void runOnce(intent, {
      scope: 'generate',
      prepare: () => body,
      send: (key, sent: SceneGenerationBody) => submitSceneGeneration(projectId, spaceId, sent, key),
      // A row that failed to start closes the dialog too: its reason and Retry are on the row.
      onDone: (answer) => {
        onClose();
        onSubmitted(answer.row_id);
        return undefined;
      },
      onFailure: async (err) => {
        // A 422 of ours names the rule or the view slot, in the user's language.
        const ours = err instanceof ApiException && err.status === 422 && err.fromServer;
        toast.error(ours ? err.message : await executeErrorMessage(err instanceof ApiException ? err.status : undefined, t));
      },
    });
  }, [entry, ready, mode, settings, origin, prompt, views, intent, projectId, spaceId, onClose, onSubmitted, t]);

  const modeOptions = React.useMemo((): ParamOption[] => THREE_D_GENERATION_MODES.map((value) => ({ value, label: SCENE_MODE_LABELS[value], disabled: submitting })), [submitting]);
  const selectMode = React.useCallback((value: string | number): void => setMode(value === 'i23d' ? 'i23d' : 't23d'), []);
  const promptError = errors.prompt;

  return <>
    <fieldset disabled={submitting} className='flex min-w-0 flex-col gap-4 px-4 pb-4'>
      {entry === undefined ? <p className='py-6 text-sm text-muted-foreground'>{t('spaces.threeD.loading')}</p> : <>
        <section data-testid='scene-generate-common' className='flex flex-col gap-3'>
          <p className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.generateDialog.common')}</p>
          <ModelParamControls model={entry} mode={mode} value={resolved} onChange={change} include={commonToggles} locked={locked} errors={errors} className='grid grid-cols-2 gap-x-6 gap-y-3' />
          <ModelParamControls model={entry} mode={mode} value={resolved} onChange={change} include={commonChoices} locked={locked} errors={errors} />
          <ModelParamControls model={entry} mode={mode} value={resolved} onChange={change} include={commonNumbers} locked={locked} errors={errors} className='grid grid-cols-2 gap-x-6 gap-y-3' />
        </section>
        <section data-testid='scene-generate-mode-section' className='flex flex-col gap-3 rounded-overlay border border-border p-3'>
          {mode === 't23d' ? <div className='flex flex-col gap-1.5'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor={`${spaceId}-scene-prompt`} className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.generateDialog.prompt')}</Label>
              <span className='text-xs tabular-nums text-muted-foreground'>{`${[...prompt].length}/${entry.prompt_max_length ?? ''}`}</span>
            </div>
            <Textarea id={`${spaceId}-scene-prompt`} data-testid='scene-generate-prompt' className='min-h-24' value={prompt} onChange={(event) => setPrompt(event.target.value)}
              placeholder={t('spaces.threeD.generateDialog.promptPlaceholder')} aria-invalid={promptError === undefined ? undefined : true} />
            {promptError === undefined ? null : <p className='text-xs text-status-error'>{promptError}</p>}
          </div> : <div className='flex flex-col gap-2'>
            <p className='text-xs font-medium text-muted-foreground'>{t('spaces.threeD.generateDialog.views')}</p>
            <div className='grid grid-cols-4 gap-2'>
              {SCENE_VIEW_SLOTS.map((view, index) => <ViewSlotCell key={view} view={view} index={index} slot={views[index]} next={index === views.length && !failedView}
                onUpload={chooseFile} onPick={setPicking} onRemove={removeView} />)}
            </div>
            <p className='text-xs text-muted-foreground'>{t('spaces.threeD.generateDialog.viewsHint')}</p>
          </div>}
          <ModelParamControls model={entry} mode={mode} value={resolved} onChange={change} include={ownSettings} locked={locked} errors={errors} />
        </section>
      </>}
      <Input ref={fileInput} data-testid='scene-generate-view-file-input' type='file' accept={SCENE_VIEW_ACCEPT} onChange={fileChosen} className='hidden' />
    </fieldset>
    <PanelRunFooter
      leading={<div className='flex min-w-0 items-center gap-3'>
        <ParamOptionGroup label='' options={modeOptions} value={mode} onSelect={selectMode} testIdPrefix='scene-generate-mode' />
        {entry === undefined ? null : <span data-testid='scene-generate-model' className='truncate text-xs text-muted-foreground'>{entry.display_name}</span>}
      </div>}
      creditText={creditText}
      runLabel={t('spaces.threeD.submit')}
      disabled={!ready}
      loading={submitting}
      onRun={submit}
      creditTestId='scene-generate-credit'
      runTestId='scene-generate-run'
    />
    <SceneImagePickerDialog projectId={projectId} open={picking !== null} onOpenChange={pickerOpenChange} onPick={picked} onPickFile={pickedFile} />
  </>;
}

interface ViewSlotCellProps {
  view: (typeof SCENE_VIEW_SLOTS)[number];
  index: number;
  slot: ViewSlot | undefined;
  /** Whether this is the slot that fills next. */
  next: boolean;
  onUpload: (index: number) => void;
  onPick: (index: number) => void;
  onRemove: (index: number) => void;
}

/**
 * One view slot: its picture with a menu to change or remove it, its upload's
 * progress, its failed upload with the same menu, the add menu when it fills
 * next, or a dash until the one before it is filled.
 * @param props - The slot and what its menu does.
 * @param props.view - Which view it is.
 * @param props.index - Its place, front first.
 * @param props.slot - What it holds.
 * @param props.next - Whether it fills next.
 * @param props.onUpload - Chooses a file to upload into it.
 * @param props.onPick - Opens the Project picker for it.
 * @param props.onRemove - Empties it, moving the later views forward.
 * @returns The slot.
 */
const ViewSlotCell = React.memo(function ViewSlotCell({ view, index, slot, next, onUpload, onPick, onRemove }: ViewSlotCellProps): React.JSX.Element {
  const t = useTranslation();
  const name = t(`spaces.threeD.generateDialog.view.${view}`);
  /**
   * The slot's menu: upload, choose from the Project and, for a slot in use, remove.
   * @param filled - Whether the slot holds a picture or a failed upload.
   * @returns The menu content.
   */
  const menu = (filled: boolean): React.JSX.Element => <DropdownMenuContent align='start'>
    <DropdownMenuItem data-testid='scene-generate-view-upload' onSelect={() => onUpload(index)}><Upload />{t('spaces.threeD.generateDialog.upload')}</DropdownMenuItem>
    <DropdownMenuItem data-testid='scene-generate-view-pick-project' onSelect={() => onPick(index)}><FolderOpen />{t('spaces.threeD.generateDialog.pickProject')}</DropdownMenuItem>
    {filled ? <><DropdownMenuSeparator />
      <DropdownMenuItem data-testid='scene-generate-view-remove' onSelect={() => onRemove(index)}><X />{t('spaces.threeD.generateDialog.removeView')}</DropdownMenuItem></> : null}
  </DropdownMenuContent>;
  return <div className='flex min-w-0 flex-col gap-1'>
    <div data-testid={`scene-generate-view-${index}`} className='relative flex aspect-square items-center justify-center overflow-hidden rounded-chrome border border-dashed border-border'>
      {slot?.kind === 'image' ? <>
        <img src={slot.url} alt='' className='absolute inset-0 size-full object-cover' />
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild>
          <Button type='button' variant='secondary' size='chrome' data-testid={`scene-generate-view-${index}-change`} aria-label={t('spaces.threeD.generateDialog.changeView', { view: name })}
            className='absolute right-1 top-1 size-6'><RefreshCw className='size-3.5' /></Button>
        </DropdownMenuTrigger>{menu(true)}</DropdownMenu>
      </> : slot?.kind === 'uploading' ? <span role='progressbar' aria-valuenow={slot.percent} aria-valuemin={0} aria-valuemax={100}
        className='absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-muted'>
        <span className='block h-full bg-foreground' style={{ width: `${slot.percent}%` }} />
      </span> : slot?.kind === 'failed' || next ? <>
        <DropdownMenu modal={false}><DropdownMenuTrigger asChild>
          <Button type='button' variant='ghost' size='icon' data-testid={`scene-generate-view-${index}-add`} aria-label={t('spaces.threeD.generateDialog.addView', { view: name })}><Plus className='size-4' /></Button>
        </DropdownMenuTrigger>{menu(slot?.kind === 'failed')}</DropdownMenu>
        {slot?.kind === 'failed' ? <p data-testid={`scene-generate-view-${index}-error`} className='absolute inset-x-1 bottom-1 text-center text-xs leading-tight text-status-error'>{t('spaces.threeD.generateDialog.uploadFailed')}</p> : null}
      </> : <Tooltip><TooltipTrigger asChild><span className='text-xs text-muted-foreground'>—</span></TooltipTrigger>
        <TooltipContent>{t('spaces.threeD.generateDialog.fillEarlier')}</TooltipContent></Tooltip>}
    </div>
    <p className='truncate text-center text-xs text-muted-foreground'>{index === 0 ? `${name} · ${t('spaces.threeD.generateDialog.required')}` : name}</p>
  </div>;
});
