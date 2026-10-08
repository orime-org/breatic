// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ArrowUp, FlipHorizontal2, FlipVertical2, Film, ImageIcon, Loader2, Music, RotateCcw, RotateCw, Star } from 'lucide-react';
import * as React from 'react';

import {
  defaultAdjustValue,
  parseAdjustValue,
  type AdjustValue,
  type ModelEntry,
} from '@breatic/shared';
import {
  isModelTool,
  localParamLabelKey,
  UPRIGHT,
  type LocalToolSpec,
  type MiniToolMedium,
  type MiniToolParam,
  type MiniToolSlotValue,
  type MiniToolSpec,
} from '@breatic/shared/mini-tools';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Slider } from '@web/components/ui/slider';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { CanvasPanel } from '@web/spaces/canvas/_shared/CanvasPanel';
import { SlotTool, type SlotPick } from '@web/spaces/canvas/generate/generate-tools';
import type { ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import {
  aspectRatioOf,
  rectForAspect,
  setRectSide,
  type CropRect,
  type MiniToolRefusal,
  type MiniToolSourceInfo,
  type SizeTierChoice,
} from '@web/spaces/canvas/mini-tool/mini-tool-view';

/** What a slot holds in the draft. */
type HeldSlot = MiniToolSlotValue | readonly MiniToolSlotValue[] | undefined;

export interface MiniToolPanelProps {
  spec: MiniToolSpec;
  /** A model tool's controls, read from its pinned model. */
  modelControls: readonly ModelControl[] | undefined;
  /** The pinned model's catalog entry, for a model tool. */
  modelEntry: ModelEntry | undefined;
  /** The params the run would be sent. */
  params: Readonly<Record<string, unknown>>;
  /** Called with the changed params only. */
  onParams: (partial: Record<string, unknown>) => void;
  source: MiniToolSourceInfo;
  /** A model tool's params chosen as output sizes, as they fall on the source. */
  sizeTiers: readonly SizeTierChoice[];
  slots: Readonly<Record<string, HeldSlot>>;
  /** How many items each list slot holds at most. */
  slotCaps: Readonly<Record<string, number | undefined>>;
  /** The slot whose pick is running, if any. */
  pickingSlot: string | null;
  onPickSlot: (slotKey: string) => void;
  onClearSlot: (slotKey: string, url?: string) => void;
  prompt: string;
  onPrompt: (prompt: string) => void;
  /** The cost line beside Run. */
  creditText: string;
  refusal: MiniToolRefusal;
  onRun: () => void;
  onClose: () => void;
}

/** The icon an empty slot shows: what it wants. */
const SLOT_ICONS = { image: ImageIcon, audio: Music, video: Film } as const;

/** Signed adjust sliders run from -100 to 100, as the request schema bounds them. */
const ADJUST_FIELDS = Object.keys(defaultAdjustValue) as (keyof AdjustValue)[];

/**
 * A slot's picks as a list.
 * @param held - What the slot holds.
 * @returns Zero or more picks.
 */
function picksOf(held: HeldSlot): readonly MiniToolSlotValue[] {
  if (held === undefined) return [];
  return Array.isArray(held) ? (held as readonly MiniToolSlotValue[]) : [held as MiniToolSlotValue];
}

/**
 * What a slot button paints for one pick.
 * @param accepts - The slot's medium.
 * @param value - The pick.
 * @returns The pick as the slot button takes it.
 */
function slotPick(accepts: MiniToolMedium, value: MiniToolSlotValue): SlotPick {
  const thumbnail = accepts === 'image' ? value.url : value.cover;
  return { kind: accepts, url: value.url, ...(thumbnail !== undefined && { thumbnail }) };
}

/** One size tier: its name over the pixel size it comes to, in the option chrome. */
const SIZE_TIER_CLASS =
  'flex min-w-0 flex-col items-center gap-0.5 rounded-overlay border border-border px-2 py-1.5 text-xs text-foreground ' +
  'transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
  'aria-[current=true]:border-active-border aria-[current=true]:bg-accent-strong aria-[current=true]:hover:bg-accent-strong ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent';

/**
 * A megapixel param as output sizes: each tier names its size on the source.
 * @param props - Component props.
 * @param props.choice - The tiers on the source and the one in use.
 * @param props.label - The control's name.
 * @param props.onParams - Called with the picked tier's label.
 * @returns The group.
 */
const SizeTierGroup = React.memo(function SizeTierGroup({
  choice,
  label,
  onParams,
}: {
  choice: SizeTierChoice;
  label: string;
  onParams: (partial: Record<string, unknown>) => void;
}): React.JSX.Element {
  return (
    <div>
      <p className='mb-1.5 text-xs font-medium text-muted-foreground'>{label}</p>
      <div className='grid grid-cols-3 gap-1.5'>
        {choice.options.map((option) => (
          <Button
            key={option.label}
            type='button'
            variant={null}
            size={null}
            data-testid={`mini-tool-size-${choice.key}-${option.label}`}
            aria-current={option.label === choice.selected}
            disabled={!option.usable}
            onClick={() => onParams({ [choice.key]: option.label })}
            className={SIZE_TIER_CLASS}
          >
            <span>{option.label}</span>
            <span className='text-2xs tabular-nums text-muted-foreground'>
              {option.width}×{option.height}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
});

/**
 * Seconds as `m:ss.s`.
 * @param seconds - The time.
 * @returns The text.
 */
function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * The parameter panel of one mini-tool (inner#888 §7.6): the tool's controls,
 * its slots and prompt, and a footer with the cost and Run.
 * @param props - Component props.
 * @returns The panel.
 */
export const MiniToolPanel = React.memo(function MiniToolPanel(props: MiniToolPanelProps): React.JSX.Element {
  const {
    spec,
    modelControls,
    modelEntry,
    params,
    onParams,
    sizeTiers,
    slots,
    slotCaps,
    pickingSlot,
    onPickSlot,
    onClearSlot,
    prompt,
    onPrompt,
    creditText,
    refusal,
    onRun,
    onClose,
  } = props;
  const t = useTranslation();
  const blocked = refusal === 'slotMissing' || refusal === 'promptMissing' || refusal === 'exporting';
  return (
    <CanvasPanel
      title={
        <span data-testid='mini-tool-panel-title' className='text-sm font-semibold'>
          {t(spec.labelKey)}
        </span>
      }
      closeLabel={t('canvas.miniTool.panel.close')}
      closeTestId='mini-tool-panel-close'
      onClose={onClose}
    >
      <div className='flex flex-col gap-2.5 px-3 pb-2.5'>
        {spec.slots.length > 0 ? (
          <div className='flex flex-wrap gap-1.5'>
            {spec.slots.map((slot) => {
              const picks = picksOf(slots[slot.key]);
              const required = modelEntry?.params[slot.param]?.optional !== true;
              const label = t('canvas.miniTool.panel.slot', { kind: slot.accepts, required: required ? 'yes' : 'no' });
              const testId = `mini-tool-slot-${spec.id}-${slot.key}`;
              const cap = slotCaps[slot.key];
              const room = slot.many ? cap === undefined || picks.length < cap : picks.length === 0;
              return (
                <React.Fragment key={slot.key}>
                  {/* A one-item slot is one button, filled or not, so focus
                      returns to it by its test id when a pick ends. */}
                  {(slot.many ? picks : []).map((value) => (
                    <SlotTool
                      key={value.url}
                      testId={`${testId}-${value.url}`}
                      thumbnailTestId={`${testId}-thumb`}
                      clearTestId={`${testId}-clear`}
                      Icon={SLOT_ICONS[slot.accepts]}
                      onPick={() => onPickSlot(slot.key)}
                      active={pickingSlot === slot.key}
                      pick={slotPick(slot.accepts, value)}
                      onClear={() => onClearSlot(slot.key, slot.many ? value.url : undefined)}
                      disabled={false}
                      clearLabel={t('canvas.miniTool.panel.clearSlot')}
                      label={label}
                      tip={t(slot.bannerKey)}
                    />
                  ))}
                  {room || !slot.many ? (
                    <SlotTool
                      testId={testId}
                      thumbnailTestId={`${testId}-thumb`}
                      clearTestId={`${testId}-clear`}
                      Icon={SLOT_ICONS[slot.accepts]}
                      onPick={() => onPickSlot(slot.key)}
                      active={pickingSlot === slot.key}
                      {...(!slot.many && picks[0] !== undefined && { pick: slotPick(slot.accepts, picks[0]) })}
                      onClear={() => onClearSlot(slot.key)}
                      disabled={false}
                      clearLabel={t('canvas.miniTool.panel.clearSlot')}
                      label={label}
                      tip={t(slot.bannerKey)}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        ) : null}
        {sizeTiers.map((choice) => (
          <SizeTierGroup
            key={choice.key}
            choice={choice}
            label={t(`canvas.generatePanel.param.${choice.key}`)}
            onParams={onParams}
          />
        ))}
        {isModelTool(spec) ? (
          modelEntry !== undefined && modelControls !== undefined && modelControls.length > 0 ? (
            <ModelParamControls
              model={modelEntry}
              mode=''
              value={params}
              onChange={onParams}
              controls={modelControls}
            />
          ) : null
        ) : (
          spec.params.map((param) => (
            <LocalParamControl
              key={param.key}
              param={param}
              spec={spec}
              params={params}
              onParams={onParams}
              source={props.source}
            />
          ))
        )}
        {spec.prompt !== undefined ? (
          <Textarea
            data-testid='mini-tool-prompt'
            value={prompt}
            placeholder={t(spec.prompt.placeholderKey)}
            onChange={(event) => onPrompt(event.target.value)}
            rows={3}
            className='resize-none text-sm'
          />
        ) : null}
      </div>
      <div className='flex items-center justify-end gap-1.5 border-t border-border px-3 py-2'>
        <span
          data-testid='mini-tool-credit'
          className='flex items-center gap-0.5 text-xs font-medium tabular-nums text-muted-foreground'
        >
          <Star className='h-3.5 w-3.5' aria-hidden='true' />
          {creditText}
        </span>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='mini-tool-run'
          aria-label={t('canvas.miniTool.panel.run')}
          disabled={blocked}
          onClick={onRun}
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed'
        >
          {refusal === 'exporting' ? (
            <Loader2 className='h-4 w-4 animate-spin' aria-hidden='true' />
          ) : (
            <ArrowUp className='h-4 w-4' aria-hidden='true' />
          )}
        </Button>
      </div>
    </CanvasPanel>
  );
});

interface LocalParamControlProps {
  param: MiniToolParam;
  spec: LocalToolSpec;
  params: Readonly<Record<string, unknown>>;
  onParams: (partial: Record<string, unknown>) => void;
  source: MiniToolSourceInfo;
}

interface RectSideInputProps {
  side: 'w' | 'h';
  /** The side's size in source pixels. */
  value: number;
  onCommit: (side: 'w' | 'h', value: number) => void;
}

/**
 * One side of the crop, typed as digits. The field holds what is being typed
 * and writes it when the field is left or Enter is pressed, so a side can be
 * cleared and retyped; a field left empty goes back to the side's size.
 * @param root0 - Component props.
 * @param root0.side - Which side.
 * @param root0.value - The side's size.
 * @param root0.onCommit - Receives the typed size.
 * @returns The field.
 */
function RectSideInput({ side, value, onCommit }: RectSideInputProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);
  /**
   * Write what was typed, if anything, and stop holding it.
   */
  const commit = (): void => {
    if (draft !== null && draft !== '') onCommit(side, Number(draft));
    setDraft(null);
  };
  return (
    <Input
      type='text'
      inputMode='numeric'
      autoComplete='off'
      data-testid={`mini-tool-rect-${side}`}
      aria-label={side === 'w' ? 'W' : 'H'}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      className='h-8 w-24 text-xs tabular-nums'
    />
  );
}

/**
 * The control one browser or container param calls for.
 * @param root0 - Component props.
 * @param root0.param - The param.
 * @param root0.spec - The tool.
 * @param root0.params - The draft params.
 * @param root0.onParams - Called with the changed params.
 * @param root0.source - What the source is showing.
 * @returns The control, or null when it waits on the source's size or length.
 */
function LocalParamControl({ param, spec, params, onParams, source }: LocalParamControlProps): React.JSX.Element | null {
  const t = useTranslation();
  const label = t(localParamLabelKey(param.key));
  const size =
    source.width !== undefined && source.height !== undefined ? { width: source.width, height: source.height } : null;
  switch (param.kind) {
    case 'number':
      return (
        <ParamSliderRow
          name={param.key}
          label={label}
          min={param.min}
          max={param.max}
          step={param.step}
          value={typeof params[param.key] === 'number' ? (params[param.key] as number) : param.default}
          format={(value) => (param.unit === undefined ? String(value) : `${value}${param.unit}`)}
          onChange={onParams}
          testIdPrefix='mini-tool-param'
          className={undefined}
        />
      );
    case 'enum': {
      // A rectangle locked to this choice is reshaped with it.
      const locked = spec.params.find((p) => p.kind === 'rect' && p.aspect === param.key);
      return (
        <ParamOptionGroup
          label={label}
          options={param.options.map((option) => ({
            value: option.value,
            label: option.label ?? option.value,
          }))}
          value={typeof params[param.key] === 'string' ? (params[param.key] as string) : param.default}
          onSelect={(value) => {
            const ratio = size === null ? null : aspectRatioOf(value, size);
            onParams(
              locked !== undefined && size !== null && ratio !== null
                ? { [param.key]: value, [locked.key]: rectForAspect(ratio, size) }
                : { [param.key]: value },
            );
          }}
          testIdPrefix={`mini-tool-param-${param.key}`}
        />
      );
    }
    case 'rect': {
      if (size === null) return null;
      const rect = (params[param.key] as CropRect | null | undefined) ?? { x: 0, y: 0, w: size.width, h: size.height };
      const ratio = param.aspect === undefined ? null : aspectRatioOf(params[param.aspect], size);
      /**
       * Write the rectangle after one side is typed.
       * @param side - Which side.
       * @param value - The typed size.
       * @returns Nothing.
       */
      const set = (side: 'w' | 'h', value: number): void =>
        onParams({ [param.key]: setRectSide(rect, side, value, ratio, size) });
      return (
        <div className='flex flex-col gap-1.5'>
          <span className='text-xs font-medium text-muted-foreground'>{label}</span>
          <div className='flex items-center gap-1.5'>
            <RectSideInput side='w' value={Math.round(rect.w)} onCommit={set} />
            <span className='text-xs text-muted-foreground'>×</span>
            <RectSideInput side='h' value={Math.round(rect.h)} onCommit={set} />
          </div>
        </div>
      );
    }
    case 'range': {
      const duration = source.duration;
      if (duration === undefined || duration <= 0) return null;
      const held = params[param.key] as { start: number; end: number } | null | undefined;
      const range = held ?? { start: 0, end: duration };
      return (
        <div className='flex flex-col gap-1.5'>
          <Slider
            data-testid='mini-tool-range'
            aria-label={label}
            min={0}
            max={duration}
            step={0.1}
            minStepsBetweenThumbs={1}
            value={[range.start, range.end]}
            onValueChange={([start, end]) => {
              if (start !== undefined && end !== undefined) onParams({ [param.key]: { start, end } });
            }}
          />
          <div className='flex justify-between text-xs tabular-nums text-muted-foreground'>
            <span>
              {clock(range.start)} – {clock(range.end)}
            </span>
            <span>{t('canvas.miniTool.panel.rangeLength', { seconds: (range.end - range.start).toFixed(1) })}</span>
          </div>
        </div>
      );
    }
    case 'adjust': {
      const value = parseAdjustValue(params[param.key]);
      return (
        <ScrollArea viewportClassName='max-h-64 pr-2'>
          <div className='flex flex-col gap-2'>
            {ADJUST_FIELDS.map((field) => (
              <ParamSliderRow
                key={field}
                name={field}
                label={t(`canvas.miniTool.adjust.${field}`)}
                min={-100}
                max={100}
                step={1}
                value={value[field]}
                format={String}
                onChange={(partial) => onParams({ [param.key]: { ...value, ...partial } })}
                testIdPrefix='mini-tool-adjust'
                className={undefined}
              />
            ))}
          </div>
        </ScrollArea>
      );
    }
    case 'orient': {
      const held = (params[param.key] as typeof UPRIGHT | undefined) ?? UPRIGHT;
      // Each button is one value the orientation can take, and value names are
      // English in every language; the control's own name is the localized one.
      const buttons = [
        { id: 'left', Icon: RotateCcw, label: '−90°', next: { ...held, turns: (held.turns + 3) % 4 } },
        { id: 'right', Icon: RotateCw, label: '90°', next: { ...held, turns: (held.turns + 1) % 4 } },
        { id: 'flipX', Icon: FlipHorizontal2, label: 'Flip', next: { ...held, flipX: !held.flipX } },
        { id: 'flipY', Icon: FlipVertical2, label: 'Flip', next: { ...held, flipY: !held.flipY } },
      ] as const;
      return (
        <div className='grid grid-cols-4 gap-1.5'>
          {buttons.map((button) => (
            <Button
              key={button.id}
              type='button'
              variant='outline'
              size='sm'
              data-testid={`mini-tool-orient-${button.id}`}
              aria-pressed={button.id === 'flipX' ? held.flipX : button.id === 'flipY' ? held.flipY : undefined}
              onClick={() => onParams({ [param.key]: button.next })}
              className='min-w-0 gap-1 text-xs aria-pressed:bg-accent-strong'
            >
              <button.Icon className='h-3.5 w-3.5' aria-hidden='true' />
              {button.label}
            </Button>
          ))}
        </div>
      );
    }
  }
}
