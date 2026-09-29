// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, ChevronRight, Volume2 } from 'lucide-react';
import * as React from 'react';

import { getLocale, type ModelEntry, type Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import {
  audioParamControls,
  formatAudioParam,
  type AudioParamControl,
} from '@web/spaces/canvas/generate/audio-params';
import {
  choiceLabel,
  hasSettings,
  settingsLayout,
  type SettingsRow,
} from '@web/spaces/canvas/generate/audio-settings';
import { ItemsEditor } from '@web/spaces/canvas/generate/ItemsEditor';
import { modelControls, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { OptionList } from '@web/spaces/canvas/generate/OptionList';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { SampleButton } from '@web/spaces/canvas/generate/SampleButton';
import { isStandInOn, STAND_IN_ON } from '@web/spaces/canvas/generate/stand-in';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { useSamplePlayer } from '@web/spaces/canvas/generate/use-sample-player';
import { VoiceList } from '@web/spaces/canvas/generate/VoiceList';
import { voiceParamName } from '@web/spaces/canvas/generate/voice-param';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/**
 * How far the second panel reaches beside the first: its `w-72` plus the
 * `ml-2` / `mr-2` gap, in pixels. Read when deciding which side it opens on.
 */
const SECOND_PANEL_SPAN = 288 + 8;

/** What this picker's shared controls edit, by the catalog's own param names. */
export type AudioParamsValue = Record<string, number>;

/** Where the voice list comes from and where a pick goes, owned by the container. */
export interface VoiceSource {
  /** Where the list is. */
  list: VoiceListState;
  /** The id held in the node's record, or null when none is. */
  selectedId: string | null;
  /** That voice's name once fetched. */
  selectedName: string | null;
  /** Showing asks for a page; hiding throws the list away. */
  onOpenChange: (open: boolean) => void;
  /** What the user typed. */
  onQueryChange: (query: string) => void;
  /** The voice the user chose. */
  onPick: (voice: Voice) => void;
  /** The list reached its end. */
  onLoadMore: () => void;
}

interface AudioSettingsPickerProps {
  /** The current model, whose declarations decide what is offered. */
  model: ModelEntry;
  /** Everything the node holds for the active model, by param name. */
  value: Record<string, unknown>;
  /** Called with the changed params only. */
  onChange: (partial: object) => void;
  /** The voice list. */
  voice: VoiceSource;
}

/**
 * The value a control shows: what the node holds, or what the model would use.
 * @param model - The active model.
 * @param name - The param name.
 * @param held - What the node holds for it, if anything.
 * @returns The number to show, or undefined when neither is a number.
 */
function shownNumber(model: ModelEntry, name: string, held: unknown): number | undefined {
  if (typeof held === 'number') return held;
  const fallback = model.params[name]?.default;
  return typeof fallback === 'number' ? fallback : undefined;
}

/**
 * The value a choice shows: what the node holds, or the declared default.
 * @param model - The active model.
 * @param name - The param name.
 * @param held - What the node holds for it.
 * @returns The value, or undefined when neither is a string or number.
 */
function shownChoice(model: ModelEntry, name: string, held: unknown): string | number | undefined {
  const value = held ?? model.params[name]?.default;
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * The key naming which second panel is open.
 * @param row - The row that opens it.
 * @returns The key.
 */
function panelKey(row: SettingsRow): string {
  return `${row.kind}:${row.name}`;
}

/**
 * The audio panel's voice-and-settings pill (#2156, design §16): the pill
 * prints the voice and the key settings, and opens a first panel holding the
 * voice and the model's params. A voice, a long choice or a list of entries is
 * a row there that opens a second panel beside the first; everything else is
 * set in place.
 *
 * Which rows and controls appear comes from the model's declarations
 * (`audio-settings.ts`), never from its name. Every label is a locale key
 * rather than the yaml's English `label`: this panel is read in five languages.
 * @param root0 - Component props.
 * @param root0.model - The current model.
 * @param root0.value - What the node holds for it.
 * @param root0.onChange - Called with the changed params.
 * @param root0.voice - The voice list.
 * @returns The picker, or null when the model offers nothing to set.
 */
export const AudioSettingsPicker = React.memo(function AudioSettingsPicker({
  model,
  value,
  onChange,
  voice,
}: AudioSettingsPickerProps): React.JSX.Element | null {
  const t = useTranslation();
  const locale = getLocale();
  const [open, setOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<string | null>(null);
  const player = useSamplePlayer();
  // Keep the popover glued to its trigger as the canvas pans / zooms, matching
  // the panel it sits in (a ReactFlow NodeToolbar that tracks its node).
  useFollowCanvasViewport(open);

  const layout = React.useMemo(() => settingsLayout(model, value), [model, value]);
  const standIn = layout.standIn;
  const dialogue = standIn !== null && isStandInOn(value);
  const shared = React.useMemo(() => audioParamControls(model), [model]);

  // The voice list is fetched while a panel that reads it is showing: the
  // voice list itself, and the speakers, whose voices play their samples.
  const readsVoices = React.useCallback(
    (key: string | null) => key !== null && (key.startsWith('voice:') || key === `items:${standIn?.name}`),
    [standIn],
  );
  const onVoiceOpenChange = voice.onOpenChange;
  const stopSample = player.stop;
  const showPanel = React.useCallback(
    (next: string | null) => {
      if (readsVoices(panel) !== readsVoices(next)) onVoiceOpenChange(readsVoices(next));
      stopSample();
      setPanel(next);
    },
    [panel, readsVoices, onVoiceOpenChange, stopSample],
  );

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) showPanel(null);
    },
    [showPanel],
  );

  // The second panel opens to the right (design §16.1); when the pill sits
  // near the right edge and there is no room there, it opens to the left
  // instead, rather than being cut off by the window.
  const firstPanelRef = React.useRef<HTMLDivElement>(null);
  const [secondOnLeft, setSecondOnLeft] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = firstPanelRef.current;
    if (panel === null || !el) return;
    const box = el.getBoundingClientRect();
    setSecondOnLeft(box.right + SECOND_PANEL_SPAN > window.innerWidth && box.left >= SECOND_PANEL_SPAN);
  }, [panel]);

  const labelOf = React.useCallback(
    (control: ModelControl) => t(`canvas.generatePanel.audioParam.${control.name}`),
    [t],
  );
  const inlineOnly = React.useCallback(
    (control: ModelControl) => layout.inline.some((c) => c.name === control.name),
    [layout],
  );

  if (!hasSettings(model)) return null;

  /**
   * What a row of the first panel says it is set to.
   * @param row - The row.
   * @returns The value as the reader reads it.
   */
  const rowValue = (row: SettingsRow): string => {
    if (row.kind === 'voice') {
      return voice.selectedName ?? voice.selectedId ?? t('canvas.generatePanel.voicePlaceholder');
    }
    if (row.kind === 'choice') {
      const shown = shownChoice(model, row.name, value[row.name]);
      return shown === undefined ? '' : choiceLabel(model.params[row.name] ?? {}, shown, locale);
    }
    const entries = Array.isArray(value[row.name]) ? (value[row.name] as Record<string, unknown>[]) : [];
    return entries
      .map((entry) => Object.values(entry).filter((v) => typeof v === 'string' && v !== '').join(' · '))
      .filter((line) => line !== '')
      .join(', ');
  };

  const summary = [
    dialogue
      ? t('canvas.generatePanel.audioDialogueSummary', { count: standIn.min })
      : layout.rows.some((row) => row.kind === 'voice')
        ? rowValue(layout.rows.find((row) => row.kind === 'voice') as SettingsRow)
        : undefined,
    ...layout.rows.filter((row) => row.kind === 'choice').map(rowValue),
    ...shared.map((control) => {
      const shown = shownNumber(model, control.name, value[control.name]);
      return shown === undefined ? undefined : formatAudioParam(control.name, shown, t);
    }),
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ') || t('canvas.generatePanel.audioSettings');

  const hasVoice = voiceParamName(model) !== null;
  const openRow = layout.rows.find((row) => panelKey(row) === panel);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-audio-settings-trigger'
          aria-label={t('canvas.generatePanel.audioSettings')}
          className='flex h-8 min-w-0 max-w-[100px] items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          {hasVoice ? <Volume2 className='h-4 w-4 shrink-0' aria-hidden='true' /> : null}
          {/* Truncated past 200px: the first words name the voice well enough
              to recognise, and the rest is one click away (design §16.1). */}
          <span className='truncate'>{summary}</span>
          <ChevronDown className='h-3.5 w-3.5 shrink-0 opacity-60' aria-hidden='true' />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={firstPanelRef}
        side='top'
        align='start'
        // Clip rather than flip at a screen edge: a following popover that
        // flipped would fight the follow and jump as the canvas pans (#1788).
        avoidCollisions={false}
        aria-label={t('canvas.generatePanel.audioSettings')}
        className='relative w-80 p-2 shadow-md'
      >
        <div className='flex flex-col gap-1'>
          {standIn !== null ? (
            <ParamOptionGroup
              label={t('canvas.generatePanel.audioReadingMode')}
              options={[
                { value: 'single', label: t('canvas.generatePanel.audioReadingSingle') },
                {
                  value: 'dialogue',
                  label: t('canvas.generatePanel.audioReadingDialogue', { count: standIn.min }),
                },
              ]}
              value={dialogue ? 'dialogue' : 'single'}
              onSelect={(next) => {
                showPanel(null);
                onChange({ [STAND_IN_ON]: next === 'dialogue' });
              }}
              testIdPrefix='generate-audio-reading'
              className='px-2 pb-2 pt-1'
            />
          ) : null}
          {layout.rows.map((row) => (
            <Button
              key={panelKey(row)}
              type='button'
              variant='ghost'
              size='menu-item'
              aria-expanded={panel === panelKey(row)}
              data-testid={`generate-audio-row-${row.name}`}
              className={cn(
                'grid grid-cols-[72px_minmax(0,1fr)_16px] items-center gap-2',
                panel === panelKey(row) && 'bg-accent',
              )}
              onClick={() => showPanel(panel === panelKey(row) ? null : panelKey(row))}
            >
              <span className='truncate text-left text-muted-foreground'>
                {row.kind === 'voice'
                  ? t('canvas.generatePanel.audioVoice')
                  : t(`canvas.generatePanel.audioParam.${row.name}`)}
              </span>
              <span className='truncate text-left'>{rowValue(row)}</span>
              <ChevronRight className='h-3.5 w-3.5 opacity-60' aria-hidden='true' />
            </Button>
          ))}
          {(shared.length > 0 || layout.inline.length > 0) && layout.rows.length > 0 ? (
            <div className='mx-1 my-1 h-px bg-border' />
          ) : null}
          {shared.length > 0 || layout.inline.length > 0 ? (
            <div className='flex flex-col gap-3 px-2 py-1'>
              {shared.map((control) => (
                <ParamControlRow
                  key={control.name}
                  control={control}
                  label={t(control.labelKey)}
                  value={shownNumber(model, control.name, value[control.name])}
                  onChange={onChange}
                />
              ))}
              <ModelParamControls
                model={model}
                value={value}
                onChange={onChange}
                include={inlineOnly}
                labelOf={labelOf}
              />
            </div>
          ) : null}
        </div>

        {openRow !== undefined ? (
          <div
            data-testid='generate-audio-second-panel'
            data-side={secondOnLeft ? 'left' : 'right'}
            className={cn(
              'absolute bottom-0 w-72 overflow-hidden rounded-overlay border border-border bg-popover text-popover-foreground shadow-md',
              secondOnLeft ? 'right-full mr-2' : 'left-full ml-2',
            )}
          >
            {openRow.kind === 'voice' ? (
              <VoiceList
                list={voice.list}
                selectedId={voice.selectedId}
                onQueryChange={voice.onQueryChange}
                onPick={(picked) => {
                  voice.onPick(picked);
                  showPanel(null);
                }}
                onLoadMore={voice.onLoadMore}
                onRetry={() => voice.onOpenChange(true)}
                player={player}
              />
            ) : openRow.kind === 'choice' ? (
              <OptionList
                options={(model.params[openRow.name]?.values ?? [])
                  .filter((v): v is string | number => typeof v !== 'boolean')
                  .map((v) => ({ value: v, label: choiceLabel(model.params[openRow.name] ?? {}, v, locale) }))}
                value={shownChoice(model, openRow.name, value[openRow.name])}
                onPick={(picked) => {
                  onChange({ [openRow.name]: picked });
                  showPanel(null);
                }}
                searchPlaceholder={
                  model.params[openRow.name]?.value_locales !== undefined
                    ? t('canvas.generatePanel.audioLanguageSearch')
                    : ''
                }
                testIdPrefix={`generate-audio-option-${openRow.name}`}
              />
            ) : (
              <ItemsPanel
                model={model}
                name={openRow.name}
                held={value[openRow.name]}
                note={openRow.name === standIn?.name ? t('canvas.generatePanel.audioSpeakersNote') : undefined}
                voices={voice.list.voices}
                player={player}
                onChange={onChange}
              />
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});

interface ItemsPanelProps {
  model: ModelEntry;
  name: string;
  held: unknown;
  /** A line under the title, when the list needs one. */
  note: string | undefined;
  /** The voice list, whose samples a voice field plays. */
  voices: readonly Voice[];
  player: ReturnType<typeof useSamplePlayer>;
  onChange: (partial: Record<string, unknown>) => void;
}

/**
 * A list of entries in the second panel: Gemini's speakers, MiniMax's
 * pronunciations. A voice field plays its sample beside the choice, when the
 * voice list has one for it.
 * @param root0 - Props.
 * @param root0.model - The active model.
 * @param root0.name - The list param's name.
 * @param root0.held - What the node holds for it.
 * @param root0.note - A line under the title.
 * @param root0.voices - The voice list.
 * @param root0.player - Plays the samples.
 * @param root0.onChange - Called with the new list.
 * @returns The panel.
 */
function ItemsPanel({ model, name, held, note, voices, player, onChange }: ItemsPanelProps): React.JSX.Element | null {
  const t = useTranslation();
  const control = modelControls(model).find((c) => c.name === name);
  if (control?.kind !== 'items') return null;
  const spec = model.params[name];
  return (
    <div className='flex flex-col gap-2 p-3'>
      <ItemsEditor
        name={name}
        label={t(`canvas.generatePanel.audioParam.${name}`)}
        max={control.max}
        min={spec?.min_items}
        fields={control.fields}
        fieldLabel={(field) => t(`canvas.generatePanel.audioField.${field}`)}
        afterChoice={(field, chosen, index) => {
          if (field !== 'voice' || typeof chosen !== 'string') return null;
          const sample = voices.find((v) => v.id === chosen || v.name === chosen)?.previewUrl;
          if (sample === undefined) return null;
          return (
            <SampleButton
              name={chosen}
              testId={`generate-param-${name}-${index}-sample`}
              playing={player.playing === `${name}:${index}`}
              onToggle={() => player.toggle(`${name}:${index}`, sample)}
            />
          );
        }}
        held={held}
        onChange={onChange}
      />
      {note !== undefined ? <p className='text-xs text-muted-foreground'>{note}</p> : null}
    </div>
  );
}

interface ParamControlRowProps {
  control: AudioParamControl;
  label: string;
  /** What this param is currently set to. */
  value: number | undefined;
  onChange: (partial: AudioParamsValue) => void;
}

/**
 * One of the panel's shared speaking params, in the form its declaration
 * calls for.
 *
 * A param stating a short list of values reuses {@link ParamOptionGroup} — the
 * shape every option-style param in this product already has — so it cannot
 * drift from the ratio and camera rows. A range gets its name and current
 * value on one line with the slider under them, because a slider position
 * alone does not say what value it is at.
 * @param root0 - Component props.
 * @param root0.control - The control this param calls for.
 * @param root0.label - The localized param name.
 * @param root0.value - The value to show.
 * @param root0.onChange - Called with the changed param.
 * @returns The row.
 */
function ParamControlRow({
  control,
  label,
  value,
  onChange,
}: ParamControlRowProps): React.JSX.Element {
  const t = useTranslation();

  if (control.kind === 'choice') {
    return (
      <ParamOptionGroup
        label={label}
        options={control.options.map((option) => ({
          value: option,
          label: formatAudioParam(control.name, option, t),
        }))}
        value={value}
        onSelect={(next) => onChange({ [control.name]: Number(next) })}
        testIdPrefix={`generate-audio-${control.name}-option`}
      />
    );
  }

  return (
    <ParamSliderRow
      name={control.name}
      label={label}
      min={control.min}
      max={control.max}
      step={control.step}
      stops={control.stops?.map((stop) => ({ value: stop.value, label: t(stop.labelKey) }))}
      value={value}
      format={(v) => formatAudioParam(control.name, v, t)}
      onChange={onChange}
      testIdPrefix='generate-audio'
      className={undefined}
    />
  );
}
