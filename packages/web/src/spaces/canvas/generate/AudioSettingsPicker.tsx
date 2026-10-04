// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ChevronDown, Volume2 } from 'lucide-react';
import * as React from 'react';

import { getLocale, type ModelEntry, type Voice } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
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
import { PARAMS_PILL_CLASS } from '@web/spaces/canvas/generate/generate-tools';
import { fixedEntries } from '@web/spaces/canvas/generate/fixed-entries';
import { ItemsEditor } from '@web/spaces/canvas/generate/ItemsEditor';
import { modelControls, ownControlSummary, type ModelControl } from '@web/spaces/canvas/generate/model-controls';
import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';
import { OptionList } from '@web/spaces/canvas/generate/OptionList';
import { ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { ParamSliderRow } from '@web/spaces/canvas/generate/ParamSliderRow';
import { isStandInOn, STAND_IN_ON } from '@web/spaces/canvas/generate/stand-in';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { useSamplePlayer } from '@web/spaces/canvas/generate/use-sample-player';
import { VoiceList } from '@web/spaces/canvas/generate/VoiceList';
import { SecondPanelFrame, SecondPanelRow, useSecondPanelSide } from '@web/spaces/canvas/generate/second-panel';
import { voiceParamName } from '@web/spaces/canvas/generate/voice-param';
import type { VoiceListState } from '@web/spaces/canvas/generate/voice-list-state';

/** The second panel's width in pixels. */
const SECOND_PANEL_WIDTH = 288;

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
  /** The mode the panel is in; a control declared only for other modes is not drawn. */
  mode: string;
  /** Everything the node holds for the active model, by param name. */
  value: Record<string, unknown>;
  /** Called with the changed params only. */
  onChange: (partial: object) => void;
  /** The voice list. */
  voice: VoiceSource;
}

/**
 * A held value a slider can show.
 * @param held - What the node holds.
 * @returns The number, or undefined when it is not one.
 */
function asNumber(held: unknown): number | undefined {
  return typeof held === 'number' ? held : undefined;
}

/**
 * A held value an option list can show.
 * @param held - What the node holds.
 * @returns The value, or undefined when it is neither a string nor a number.
 */
function asChoice(held: unknown): string | number | undefined {
  return typeof held === 'string' || typeof held === 'number' ? held : undefined;
}

/**
 * The key naming which second panel is open.
 * @param row - The row that opens it.
 * @returns The key.
 */
function panelKey(row: SettingsRow): string {
  return row.kind === 'speaker' ? `speaker:${row.index}` : `${row.kind}:${row.name}`;
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
 * @param root0.mode - The mode the panel is in.
 * @param root0.value - What the node holds for it.
 * @param root0.onChange - Called with the changed params.
 * @param root0.voice - The voice list.
 * @returns The picker, or null when the model offers nothing to set.
 */
export const AudioSettingsPicker = React.memo(function AudioSettingsPicker({
  model,
  mode,
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

  const layout = React.useMemo(() => settingsLayout(model, mode, value), [model, mode, value]);
  const standIn = layout.standIn;
  // The language the reader picked, for a voice that has a sample in each: the
  // model's param whose values name languages.
  const languageParam = Object.keys(model.params).find((name) => model.params[name]?.value_locales !== undefined);
  const language = languageParam === undefined ? undefined : asChoice(value[languageParam]);
  const dialogue = standIn !== null && isStandInOn(value);
  const shared = React.useMemo(() => audioParamControls(model), [model]);

  // The voice list is fetched while a panel that reads it is showing: the
  // voice list itself, and the speakers, whose voices play their samples.
  const readsVoices = React.useCallback(
    (key: string | null) => key !== null && (key.startsWith('voice:') || key.startsWith('speaker:')),
    [],
  );
  const onVoiceOpenChange = voice.onOpenChange;
  const onVoiceQueryChange = voice.onQueryChange;
  const stopSample = player.stop;
  const showPanel = React.useCallback(
    (next: string | null) => {
      if (readsVoices(panel) !== readsVoices(next)) onVoiceOpenChange(readsVoices(next));
      // One speaker's search would hide the next speaker's voice from its list.
      else if (readsVoices(next) && next !== panel) onVoiceQueryChange('');
      stopSample();
      setPanel(next);
    },
    [panel, readsVoices, onVoiceOpenChange, onVoiceQueryChange, stopSample],
  );

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) showPanel(null);
    },
    [showPanel],
  );

  const [firstPanelRef, secondOnLeft] = useSecondPanelSide(panel, SECOND_PANEL_WIDTH);

  const inlineOnly = React.useCallback(
    (control: ModelControl) => layout.inline.some((c) => c.name === control.name),
    [layout],
  );

  // The dialogue's speakers, one entry per speaker row, and which field of an
  // entry is the name (the text field) and which the voice (the choice).
  const speakerControl = standIn === null ? undefined : modelControls(model, mode).find((c) => c.name === standIn.name);
  const speakerFields = speakerControl?.kind === 'items' ? speakerControl.fields : [];
  const nameField = speakerFields.find((f) => f.kind === 'text')?.name;
  const voiceField = speakerFields.find((f) => f.kind === 'choice')?.name;
  const speakers =
    standIn === null
      ? []
      : fixedEntries(value[standIn.name], model.params[standIn.name]?.max_items ?? standIn.min, speakerFields);

  /**
   * Writes one field of one speaker, with the whole list as the node holds it.
   * @param index - Which speaker.
   * @param field - Which of its fields.
   * @param next - The new value.
   */
  const writeSpeaker = (index: number, field: string | undefined, next: unknown): void => {
    if (standIn === null || field === undefined) return;
    onChange({ [standIn.name]: speakers.map((entry, i) => (i === index ? { ...entry, [field]: next } : entry)) });
  };

  /**
   * A speaker's name, or its voice as the voice list names it.
   * @param index - Which speaker.
   * @param field - The field to read.
   * @returns The text, empty when unset.
   */
  const speakerText = (index: number, field: string | undefined): string => {
    const held = field === undefined ? undefined : speakers[index]?.[field];
    return typeof held === 'string' ? held : '';
  };
  /**
   * A voice as the voice list names it.
   * @param id - The voice id the node holds.
   * @returns Its name, or the id when the list does not carry it.
   */
  const voiceNameOf = (id: string): string => voice.list.voices.find((v) => v.id === id)?.name ?? id;

  if (!hasSettings(model, mode)) return null;

  /**
   * What a row of the first panel says it is set to.
   * @param row - The row.
   * @returns The value as the reader reads it.
   */
  const rowValue = (row: SettingsRow): string => {
    if (row.kind === 'speaker') {
      return [speakerText(row.index, nameField), voiceNameOf(speakerText(row.index, voiceField))]
        .filter((part) => part !== '')
        .join(' · ');
    }
    if (row.kind === 'voice') {
      return voice.selectedName ?? voice.selectedId ?? t('canvas.generatePanel.voicePlaceholder');
    }
    if (row.kind === 'choice') {
      const shown = asChoice(value[row.name]);
      return shown === undefined ? '' : choiceLabel(model.params[row.name] ?? {}, shown, locale);
    }
    const entries = Array.isArray(value[row.name]) ? (value[row.name] as Record<string, unknown>[]) : [];
    return entries
      .map((entry) => Object.values(entry).filter((v) => typeof v === 'string' && v !== '').join(' · '))
      .filter((line) => line !== '')
      .join(', ');
  };

  /**
   * What one row says on the pill: a voice or a choice by its value, the
   * dialogue by its speaker count, any other list by its name while it holds
   * something.
   * @param row - The row.
   * @returns The part, or undefined when the row has nothing to say.
   */
  const rowSummary = (row: SettingsRow): string | undefined => {
    if (row.kind === 'speaker') {
      return row.index === 0 && standIn !== null
        ? t('canvas.generatePanel.audioDialogueSummary', { count: standIn.min })
        : undefined;
    }
    if (row.kind !== 'items') return rowValue(row);
    const held = value[row.name];
    return Array.isArray(held) && held.length > 0 ? t(`canvas.generatePanel.param.${row.name}`) : undefined;
  };

  // The pill reads in the popover's order: the rows, then the shared speaking
  // controls, then the model's own controls set in place.
  const summary = [
    ...layout.rows.map(rowSummary),
    ...shared.map((control) => {
      const shown = asNumber(value[control.name]);
      return shown === undefined ? undefined : formatAudioParam(control.name, shown, t);
    }),
    ...ownControlSummary(model, mode, value, (name) => t(`canvas.generatePanel.param.${name}`), inlineOnly),
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
          className={PARAMS_PILL_CLASS}
        >
          {hasVoice ? <Volume2 className='h-4 w-4 shrink-0' aria-hidden='true' /> : null}
          {/* Truncated past 150px: the first words name the voice well enough
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
              className='px-1 pb-2 pt-1'
            />
          ) : null}
          {layout.rows.map((row) => (
            <SecondPanelRow
              key={panelKey(row)}
              label={
                row.kind === 'speaker'
                  ? t('canvas.generatePanel.audioSpeakerRow', { n: row.index + 1 })
                  : row.kind === 'voice'
                    ? t('canvas.generatePanel.audioVoice')
                    : t(`canvas.generatePanel.param.${row.name}`)
              }
              value={rowValue(row)}
              open={panel === panelKey(row)}
              onLeft={secondOnLeft}
              testId={row.kind === 'speaker' ? `generate-audio-row-${row.name}-${row.index}` : `generate-audio-row-${row.name}`}
              onClick={() => showPanel(panel === panelKey(row) ? null : panelKey(row))}
            />
          ))}
          {dialogue ? (
            <p className='px-1 pt-1 text-xs text-muted-foreground'>{t('canvas.generatePanel.audioSpeakersNote')}</p>
          ) : null}
          {(shared.length > 0 || layout.inline.length > 0) && layout.rows.length > 0 ? (
            <div className='mx-1 my-1 h-px bg-border' />
          ) : null}
          {shared.length > 0 || layout.inline.length > 0 ? (
            <div className='flex flex-col gap-3 px-1 py-1'>
              {shared.map((control) => (
                <ParamControlRow
                  key={control.name}
                  control={control}
                  label={t(control.labelKey)}
                  value={asNumber(value[control.name])}
                  onChange={onChange}
                />
              ))}
              <ModelParamControls
                model={model}
                mode={mode}
                value={value}
                onChange={onChange}
                include={inlineOnly}
              />
            </div>
          ) : null}
        </div>

        {openRow !== undefined ? (
          <SecondPanelFrame
            onLeft={secondOnLeft}
            maxWidth={SECOND_PANEL_WIDTH}
            testId='generate-audio-second-panel'
            className='overflow-hidden'
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
                language={language}
              />
            ) : openRow.kind === 'choice' ? (
              <OptionList
                options={(model.params[openRow.name]?.values ?? [])
                  .filter((v): v is string | number => typeof v !== 'boolean')
                  .map((v) => ({ value: v, label: choiceLabel(model.params[openRow.name] ?? {}, v, locale) }))}
                value={asChoice(value[openRow.name])}
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
            ) : openRow.kind === 'speaker' ? (
              <>
                <SpeakerNameBox
                  key={openRow.index}
                  label={t('canvas.generatePanel.paramField.speaker')}
                  placeholder={t('canvas.generatePanel.audioSpeakerRow', { n: openRow.index + 1 })}
                  held={speakerText(openRow.index, nameField)}
                  onCommit={(next) => writeSpeaker(openRow.index, nameField, next)}
                />
                <VoiceList
                  list={voice.list}
                  selectedId={speakerText(openRow.index, voiceField)}
                  onQueryChange={voice.onQueryChange}
                  onPick={(picked) => {
                    writeSpeaker(openRow.index, voiceField, picked.id);
                    showPanel(null);
                  }}
                  onLoadMore={voice.onLoadMore}
                  onRetry={() => voice.onOpenChange(true)}
                  player={player}
                  language={language}
                />
              </>
            ) : (
              <ItemsPanel model={model} mode={mode} name={openRow.name} held={value[openRow.name]} onChange={onChange} />
            )}
          </SecondPanelFrame>
        ) : null}
      </PopoverContent>
    </Popover>
  );
});

interface ItemsPanelProps {
  model: ModelEntry;
  /** The mode the panel is in; a control declared only for other modes is not drawn. */
  mode: string;
  name: string;
  held: unknown;
  onChange: (partial: Record<string, unknown>) => void;
}

/**
 * A list of entries in the second panel: MiniMax's pronunciations.
 * @param root0 - Props.
 * @param root0.model - The active model.
 * @param root0.mode - The mode the panel is in.
 * @param root0.name - The list param's name.
 * @param root0.held - What the node holds for it.
 * @param root0.onChange - Called with the new list.
 * @returns The panel.
 */
function ItemsPanel({ model, mode, name, held, onChange }: ItemsPanelProps): React.JSX.Element | null {
  const t = useTranslation();
  const control = modelControls(model, mode).find((c) => c.name === name);
  if (control?.kind !== 'items') return null;
  const spec = model.params[name];
  return (
    <div className='flex flex-col gap-2 p-3'>
      <ItemsEditor
        name={name}
        label={t(`canvas.generatePanel.param.${name}`)}
        max={control.max}
        min={spec?.min_items}
        fields={control.fields}
        fieldLabel={(field) => t(`canvas.generatePanel.paramField.${field}`)}
        held={held}
        onChange={onChange}
      />
    </div>
  );
}

interface SpeakerNameBoxProps {
  /** The box's name above it. */
  label: string;
  /** What the empty box says. */
  placeholder: string;
  /** The name the node holds. */
  held: string;
  /** Called with a changed name. */
  onCommit: (next: string) => void;
}

/**
 * A speaker's name, written when the reader leaves the box or presses Enter,
 * so each edit is one canvas undo step. The Enter that confirms an IME word
 * is not the reader finishing the name.
 * @param root0 - Props.
 * @param root0.label - The box's name.
 * @param root0.placeholder - What the empty box says.
 * @param root0.held - The name the node holds.
 * @param root0.onCommit - Called with a changed name.
 * @returns The box.
 */
function SpeakerNameBox({ label, placeholder, held, onCommit }: SpeakerNameBoxProps): React.JSX.Element {
  const id = React.useId();
  const [draft, setDraft] = React.useState<string | null>(null);
  /** Writes the draft, when it differs from what the node holds, and drops it. */
  const commit = (): void => {
    if (draft !== null && draft !== held) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className='border-b border-border p-3'>
      <label htmlFor={id} className='mb-1.5 block text-xs font-medium text-muted-foreground'>
        {label}
      </label>
      <Input
        autoComplete='off'
        id={id}
        data-testid='generate-audio-speaker-name'
        placeholder={placeholder}
        value={draft ?? held}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit();
        }}
        className='h-8 text-xs'
      />
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
