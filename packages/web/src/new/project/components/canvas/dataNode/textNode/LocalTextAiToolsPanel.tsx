/**
 * Text-node AI — sheet UI aligned with `new/textEditor/ui/AIMenu` (card + optional notes + Refine/Create; dropdown → phased loading).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FC,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  RiArrowDropDownLine,
  RiContractUpDownLine,
  RiExchangeLine,
  RiExpandUpDownLine,
  RiFileTextLine,
  RiFilmLine,
  RiGroupLine,
  RiPlayListAddLine,
  RiSparkling2Line,
  RiTranslateAi,
} from 'react-icons/ri';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import Tooltip from '@/components/base/tooltip';
import { Button } from '@/components/base/button';
import { Icon } from '@/components/base/icon';
import Input from '@/components/base/input';
import Select from '@/components/base/select';
import { cn } from '@/utils/classnames';
import CanvasOutputPendingProgressOverlay from '../../common/CanvasOutputPendingProgressOverlay';

export type TextAiToolId =
  | 'polish'
  | 'expand'
  | 'summarize'
  | 'translate'
  | 'rewrite'
  | 'continue'
  | 'generate'
  | 'character'
  | 'storyboard'
  | 'script';

export const MOCK_REPLACEMENT: Record<TextAiToolId, string> = {
  polish: '[POLISH] This is fixed replacement content.',
  expand: '[EXPAND] This is fixed replacement content.',
  summarize: '[SUMMARIZE] This is fixed replacement content.',
  translate: '[TRANSLATE] This is fixed replacement content.',
  rewrite: '[REWRITE] This is fixed replacement content.',
  continue: '[CONTINUE] This is fixed replacement content.',
  generate: '[GENERATE] This is fixed replacement content.',
  character: '[CHARACTER] This is fixed replacement content.',
  storyboard: '[STORYBOARD] This is fixed replacement content.',
  script: '[SCRIPT] This is fixed replacement content.',
};

/** First toolbar dropdown: adjust existing text (includes translate / rewrite as row actions). */
export const REFINE_TOOLS: { id: 'polish' | 'expand' | 'summarize' | 'translate' | 'rewrite' | 'continue'; labelKey: string; def: string; icon: React.ReactNode }[] = [
  { id: 'polish', labelKey: 'project.textAi.polish', def: 'Polish', icon: <RiSparkling2Line size={16} /> },
  { id: 'expand', labelKey: 'project.textAi.expand', def: 'Expand', icon: <RiExpandUpDownLine size={16} /> },
  { id: 'summarize', labelKey: 'project.textAi.summarize', def: 'Summarize', icon: <RiContractUpDownLine size={16} /> },
  { id: 'translate', labelKey: 'project.textAi.translate', def: 'Translate', icon: <RiTranslateAi size={16} /> },
  { id: 'rewrite', labelKey: 'project.textAi.rewrite', def: 'Rewrite', icon: <RiExchangeLine size={16} /> },
  { id: 'continue', labelKey: 'project.textAi.continue', def: 'Continue', icon: <RiPlayListAddLine size={16} /> },
];

const STYLES: { key: string; labelKey: string; def: string }[] = [
  { key: 'formal', labelKey: 'project.textAi.style.formal', def: 'Formal' },
  { key: 'casual', labelKey: 'project.textAi.style.casual', def: 'Casual' },
  { key: 'technical', labelKey: 'project.textAi.style.technical', def: 'Technical' },
  { key: 'creative', labelKey: 'project.textAi.style.creative', def: 'Creative' },
];

export const CREATE_TOOLS: { id: 'generate' | 'character' | 'storyboard' | 'script'; labelKey: string; def: string; icon: React.ReactNode }[] = [
  { id: 'generate', labelKey: 'project.textAi.generate', def: 'Generate', icon: <RiSparkling2Line size={16} /> },
  { id: 'character', labelKey: 'project.textAi.character', def: 'Character', icon: <RiGroupLine size={16} /> },
  { id: 'storyboard', labelKey: 'project.textAi.storyboard', def: 'Storyboard', icon: <RiFilmLine size={16} /> },
  { id: 'script', labelKey: 'project.textAi.script', def: 'Script', icon: <RiFileTextLine size={16} /> },
];

const shellClass =
  'pointer-events-auto flex w-[min(100vw-24px,640px)] max-w-[640px] flex-col gap-2 rounded-[16px] border border-border-default-base bg-background-default-secondary px-3 py-2 shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05)]';

/** Matches `LocalTextFormatToolbar` shell so AI triggers sit in one top bar with format controls. */
const triggerBarShellClass =
  'pointer-events-auto flex flex-wrap items-center gap-1 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]';

const triggerClass =
  'flex h-8 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[8px] border-0 bg-transparent px-2 text-[13px] text-text-default-base transition-colors hover:bg-background-default-base-hover';

export type TextAiPanelFields = {
  instructions?: string;
  language?: string;
  style?: string;
  name?: string;
  traits?: string;
  context?: string;
  scene_count?: string;
  scene_description?: string;
  characters?: string;
};

export interface LocalTextAiToolsPanelProps {
  /** When false, edit tools that need body text are disabled. */
  hasDocumentText: boolean;
  activeTool: TextAiToolId | null;
  fields: TextAiPanelFields;
  onActiveToolChange: (tool: TextAiToolId | null) => void;
  onFieldsChange: (next: TextAiPanelFields) => void;
  /** Mock insert — parent ensures edit mode then applies plain text (same idea as `AIMenu` preview). */
  onMockRun: (tool: TextAiToolId) => void;
  isRunning: boolean;
}

export type LocalTextAiTriggerBarProps = Pick<
  LocalTextAiToolsPanelProps,
  'hasDocumentText' | 'fields' | 'onActiveToolChange' | 'onFieldsChange'
> & {
  /**
   * Dropdown popup placement (`bottom-start` when the strip sits on the top `NodeToolbar`, like image tools).
   *
   * @defaultValue `'top-start'`
   */
  menuPlacement?: 'top-start' | 'bottom-start';
  /** Omit bordered shell — parent renders one combined bar (see `localTextNodeTopToolbarShellClass` in `LocalTextFormatToolbar`). */
  embedded?: boolean;
  /**
   * Merge default field patches then start the run (canvas node: bottom uses `AIMenu`-aligned loading).
   * When set, menu clicks do not navigate the legacy form panel.
   */
  onRunImmediate?: (tool: TextAiToolId) => void;
  /**
   * When set, Refine menu applies field patches then opens the bottom notes panel instead of {@link onRunImmediate}.
   */
  onRefineNotesPanel?: (tool: TextAiToolId) => void;
  /**
   * When set, Create menu opens the same bottom sheet flow as Refine (preflight pill → form), instead of {@link onRunImmediate}.
   */
  onCreateNotesPanel?: (tool: 'generate' | 'character' | 'storyboard' | 'script') => void;
  /** Disable dropdown triggers during phased loading. */
  isRunning?: boolean;
};

/** Matches image `UpscaleBottomToolbar` / `MultiAngleBottomToolbar` bottom cards (border, width, padding). */
const bottomFormShellClass =
  'nodrag nopan relative overflow-hidden pointer-events-auto w-[min(100vw-24px,430px)] max-w-[430px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]';

const bottomToolbarIconBtnClass =
  'nodrag nopan flex h-8 w-8 items-center justify-center rounded-[4px] text-icon-base transition-colors hover:bg-background-default-base-hover';

/** Primary multi-line field — same visual as `UpscaleBottomToolbar` prompt textarea. */
const bottomToolbarTextareaClass =
  'w-full resize-none rounded-[8px] border border-border-default-base bg-transparent px-2 py-1.5 text-[13px] text-text-default-base outline-none placeholder:text-text-default-tertiary disabled:cursor-not-allowed disabled:opacity-60';

/** Mock Run delay in `TextNode.handleMockAiRun` — overlay animation length while “loading”. */
const TEXT_AI_RUN_OVERLAY_MS = 1250 as const;

/** Delay after choosing a Refine tool before the optional-notes form appears (same shell as {@link UpscaleBottomToolbar}). */
export const TEXT_AI_REFINE_PREFLIGHT_MS = 1250 as const;

/** Outer prompt card — same classes as `AIMenu` root prompt container (see `AIMenu.tsx`). */
const aimMenuPromptOuterClass = cn(
  'nodrag nopan flex items-center gap-2 rounded-[12px] bg-background-default-base pl-3 pr-2',
  'border border-border-default-base',
  'shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_8px_24px_rgba(12,12,13,0.12)]',
);

/** Single shell for Refine optional-notes — aligned with {@link UpscaleBottomToolbar} (wide card, one container). */
const textRefineUnifiedShellClass =
  'nodrag nopan pointer-events-auto flex w-[min(100vw-24px,560px)] min-w-[280px] flex-col rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-[12px] shadow-[0_1px_3px_rgba(0,0,0,0.08)]';

/** Pill loading bar (fig.1): white rounded bar, green status, dots, dark stop control. */
const textAiLoadingPillClass =
  'nodrag nopan flex w-full min-w-0 items-center justify-between gap-3 rounded-full border border-[#E8E8E8] bg-background-default-base px-4 py-2 shadow-[0px_1px_4px_rgba(12,12,13,0.1)]';

/** Green send control — same dimensions as {@link UpscaleBottomToolbar} send. */
const textAiUpscaleSendButtonClass =
  '!h-[28px] !w-[52px] !min-w-[52px] !py-[2px] !pl-[16px] !pr-[12px] !bg-[#2FB344] !border-[#2FB344] hover:!bg-[#28A13D] hover:!border-[#28A13D] disabled:!bg-[#D8D8D8] disabled:!border-[#D8D8D8]';

/** Default credits shown for text mini-tool until API provides a live cost. */
export const TEXT_AI_REFINE_CREDIT_PLACEHOLDER = 120 as const;

/**
 * Fig.1 pill: white bar, green status label, gray dots, dark round stop (white square).
 *
 * @param props.label - Status line (e.g. “Thinking”, “AI is writing”).
 */
const TextAiLoadingPill: FC<{
  label: string;
  onStop: () => void;
  stopAriaLabel: string;
  /** Extra classes on the pill root (e.g. width). */
  className?: string;
  /** Canvas: prevent drag pan when interacting with the sheet. */
  onRootMouseDown?: (e: ReactMouseEvent<HTMLDivElement>) => void;
}> = ({ label, onStop, stopAriaLabel, className, onRootMouseDown }) => {
  const handleStopKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onStop();
      }
    },
    [onStop],
  );

  const loadingDots = (
    <span className='inline-flex items-center gap-1 text-[#B8B8B8]'>
      <span className='h-1.5 w-1.5 rounded-full bg-current opacity-90' />
      <span className='h-1.5 w-1.5 rounded-full bg-current opacity-90' />
      <span className='h-1.5 w-1.5 rounded-full bg-current opacity-90' />
    </span>
  );

  return (
    <div className={cn(textAiLoadingPillClass, className)} onMouseDown={onRootMouseDown}>
      <div className='flex min-w-0 flex-1 items-center gap-2'>
        <span className='truncate text-[14px] font-medium' style={{ color: '#2FB344' }}>
          {label}
        </span>
        {loadingDots}
      </div>
      <button
        type='button'
        className='nodrag nopan flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] transition-colors hover:bg-[#2D2D2D]'
        onMouseDown={(e) => e.preventDefault()}
        onClick={onStop}
        onKeyDown={handleStopKeyDown}
        aria-label={stopAriaLabel}
      >
        <span className='block h-2 w-2 rounded-[1px] bg-white' aria-hidden />
      </button>
    </div>
  );
};

export type TextAiRunPhase = 'thinking' | 'writing' | null;

/** Refine tools that share optional-notes + body validation in the bottom sheet. */
export function isLocalTextAiRefineSheetTool(id: TextAiToolId): id is (typeof REFINE_TOOLS)[number]['id'] {
  return ['polish', 'expand', 'summarize', 'translate', 'rewrite', 'continue'].includes(id);
}

/** Localized toolbar title for any text AI tool (Refine + Create). */
export function getTextAiToolDisplayTitle(tool: TextAiToolId, t: TFunction): string {
  const refineRow = REFINE_TOOLS.find((x) => x.id === tool);
  if (refineRow) return t(refineRow.labelKey, refineRow.def);
  const createRow = CREATE_TOOLS.find((x) => x.id === tool);
  if (createRow) return t(createRow.labelKey, createRow.def);
  return tool;
}

/** Menu icon for sheet / form header — matches Refine/Create dropdown rows. */
export function getTextAiToolHeaderIcon(tool: TextAiToolId): ReactNode | null {
  const refineRow = REFINE_TOOLS.find((x) => x.id === tool);
  if (refineRow) return refineRow.icon;
  const createRow = CREATE_TOOLS.find((x) => x.id === tool);
  if (createRow) return createRow.icon;
  return null;
}

export type TextAiToolSheetFormFieldsProps = {
  tool: TextAiToolId;
  fields: TextAiPanelFields;
  onFieldsChange: (next: TextAiPanelFields) => void;
  hasDocumentText: boolean;
  styleSelectOptions: Array<{ value: string; label: string }>;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Legacy panel disables inputs while mock run is in progress; canvas sheet hides the form instead. */
  fieldsDisabled?: boolean;
};

/**
 * Shared body fields for every text AI tool — used by {@link LocalTextAiSheetPanel} and {@link LocalTextAiToolFormPanel}
 * so Refine and Create flows share one implementation.
 */
export const TextAiToolSheetFormFields: FC<TextAiToolSheetFormFieldsProps> = ({
  tool,
  fields,
  onFieldsChange,
  hasDocumentText,
  styleSelectOptions,
  inputRef,
  fieldsDisabled = false,
}) => {
  const { t } = useTranslation();
  const ariaToolTitle = useMemo(() => getTextAiToolDisplayTitle(tool, t), [tool, t]);

  return (
    <>
      {tool === 'rewrite' ? (
        <label className='mb-2 flex flex-col gap-1'>
          <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.targetStyle', 'Style')}</span>
          <Select
            size='middle'
            options={styleSelectOptions}
            value={fields.style ?? 'formal'}
            onChange={(v) => onFieldsChange({ ...fields, style: String(v) })}
            disabled={fieldsDisabled}
          />
        </label>
      ) : null}

      {isLocalTextAiRefineSheetTool(tool) ? (
        <>
          <label className='flex flex-col gap-1'>
            <textarea
              ref={inputRef}
              rows={4}
              className={cn(bottomToolbarTextareaClass, 'min-h-[96px]')}
              placeholder={t('project.textAi.instructionsPlaceholder', 'Extra instructions…')}
              value={fields.instructions ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
              autoComplete='off'
              disabled={fieldsDisabled}
              aria-label={ariaToolTitle}
            />
          </label>
          {!hasDocumentText ? (
            <p className='mt-2 text-[12px] text-text-default-tertiary'>
              {t('project.textAi.needBody', 'Add text in the node first, or open edit mode.')}
            </p>
          ) : null}
        </>
      ) : tool === 'generate' ? (
        <label className='flex flex-col gap-1'>
          <textarea
            ref={inputRef}
            rows={4}
            className={cn(bottomToolbarTextareaClass, 'min-h-[96px]')}
            placeholder={t('project.textAi.generatePlaceholder', 'Describe what to generate…')}
            value={fields.instructions ?? ''}
            onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
            autoComplete='off'
            disabled={fieldsDisabled}
            aria-label={ariaToolTitle}
          />
        </label>
      ) : tool === 'character' ? (
        <div className='flex flex-col gap-2'>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.characterName', 'Name')} *</span>
            <Input
              inputType='text'
              value={fields.name ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, name: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.traits', 'Traits')}</span>
            <textarea
              className={`${bottomToolbarTextareaClass} min-h-[72px]`}
              value={fields.traits ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, traits: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.context', 'Context')}</span>
            <textarea
              className={`${bottomToolbarTextareaClass} min-h-[72px]`}
              value={fields.context ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, context: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
        </div>
      ) : tool === 'storyboard' ? (
        <div className='flex flex-col gap-2'>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.storyboardBrief', 'Outline / brief')} *</span>
            <textarea
              ref={inputRef}
              className={`${bottomToolbarTextareaClass} min-h-[96px]`}
              value={fields.instructions ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.sceneCount', 'Scene count')}</span>
            <Input
              className='max-w-[120px]'
              inputType='number'
              min={1}
              value={fields.scene_count ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, scene_count: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
        </div>
      ) : tool === 'script' ? (
        <div className='flex flex-col gap-2'>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.sceneDescription', 'Scene')} *</span>
            <textarea
              ref={inputRef}
              className={`${bottomToolbarTextareaClass} min-h-[96px]`}
              value={fields.scene_description ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, scene_description: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.charactersCsv', 'Characters (comma-separated)')}</span>
            <Input
              inputType='text'
              value={fields.characters ?? ''}
              onChange={(e) => onFieldsChange({ ...fields, characters: e.target.value })}
              disabled={fieldsDisabled}
            />
          </label>
        </div>
      ) : null}
    </>
  );
};

export interface LocalTextAiSheetPanelProps {
  hasDocumentText: boolean;
  fields: TextAiPanelFields;
  onFieldsChange: (next: TextAiPanelFields) => void;
  isRunning: boolean;
  runPhase: TextAiRunPhase;
  onCancelRun: () => void;
  /** Active Refine or Create tool — drives title, fields, and validation. */
  sheetTool?: TextAiToolId | null;
  onSheetClose?: () => void;
  /** Refine flow: primary action after optional notes */
  showRunButton?: boolean;
  onSubmitRun?: () => void;
  submitRunDisabled?: boolean;
  /** Refine flow: first-phase loading inside the same card before the notes field is shown */
  refinePreflightLoading?: boolean;
  /** Credits next to send (Upscale-aligned); placeholder until billing is wired */
  refineCreditCost?: number;
}

/**
 * Bottom sheet: `AIMenu`-matched prompt shell (optional notes) + inline thinking/writing row. Refine/Create live on the top toolbar.
 */
export const LocalTextAiSheetPanel: FC<LocalTextAiSheetPanelProps> = ({
  hasDocumentText,
  fields,
  onFieldsChange,
  isRunning,
  runPhase,
  onCancelRun,
  sheetTool = null,
  onSheetClose,
  showRunButton = false,
  onSubmitRun,
  submitRunDisabled = false,
  refinePreflightLoading = false,
  refineCreditCost = TEXT_AI_REFINE_CREDIT_PLACEHOLDER,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formShellRef = useRef<HTMLDivElement>(null);

  const handleSheetMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest('input, textarea, [contenteditable="true"], button, [role="menu"]')) return;
    e.preventDefault();
  }, []);

  const showLoading = isRunning && (runPhase === 'thinking' || runPhase === 'writing');
  const refineLoadingBlocking = refinePreflightLoading || showLoading;

  const sheetDisplayTitle = sheetTool ? getTextAiToolDisplayTitle(sheetTool, t) : '';
  const sheetTitleIcon = sheetTool ? getTextAiToolHeaderIcon(sheetTool) : null;

  const styleSelectOptions = useMemo(
    () =>
      STYLES.map((x) => ({
        value: x.key,
        label: t(x.labelKey, x.def),
      })),
    [t],
  );

  /** Focus first field when the sheet form mounts after preflight or after an AI run phase ends. */
  useEffect(() => {
    const blocking = refineLoadingBlocking;
    if (!sheetTool || blocking) return;
    requestAnimationFrame(() => {
      const el = (formShellRef.current?.querySelector('textarea, input') ??
        inputRef.current) as HTMLTextAreaElement | HTMLInputElement | null;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }, [sheetTool, refineLoadingBlocking]);

  if (sheetTool) {
    /** Preflight / thinking / writing: single pill only (no outer shell). */
    if (refineLoadingBlocking) {
      return (
        <TextAiLoadingPill
          className='w-[min(100vw-24px,640px)] min-w-[280px] max-w-[640px]'
          onRootMouseDown={handleSheetMouseDown}
          label={
            refinePreflightLoading
              ? t('project.textAi.thinking', 'Thinking')
              : runPhase === 'writing'
                ? t('project.textAi.aiWriting', 'AI is writing')
                : t('project.textAi.thinking', 'Thinking')
          }
          onStop={onCancelRun}
          stopAriaLabel={t('project.textAi.stopGeneration', 'Stop')}
        />
      );
    }

    return (
      <div ref={formShellRef} className={textRefineUnifiedShellClass} onMouseDown={handleSheetMouseDown}>
        <div className='flex items-center justify-between gap-2'>
          <div className='inline-flex min-w-0 items-center gap-1.5'>
            {sheetTitleIcon ? (
              <span className='flex shrink-0 text-icon-base' aria-hidden>
                {sheetTitleIcon}
              </span>
            ) : null}
            <span className='truncate text-sm font-bold text-text-default-base'>{sheetDisplayTitle}</span>
          </div>
          {onSheetClose ? (
            <Tooltip title={t('project.toolbar.exit', 'Exit')} placement='top' offset={4}>
              <button
                type='button'
                className={bottomToolbarIconBtnClass}
                onClick={onSheetClose}
                aria-label={t('project.toolbar.exit', 'Exit')}
              >
                <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} color='#383838' />
              </button>
            </Tooltip>
          ) : null}
        </div>

        <div className='mt-3 flex min-h-[52px] flex-col'>
          <TextAiToolSheetFormFields
            tool={sheetTool}
            fields={fields}
            onFieldsChange={onFieldsChange}
            hasDocumentText={hasDocumentText}
            styleSelectOptions={styleSelectOptions}
            inputRef={inputRef}
          />

          {showRunButton && onSubmitRun ? (
            <div className='mt-3 flex items-center justify-between gap-3 px-1'>
              <div className='min-w-0 flex-1' />
              <div className='flex items-center gap-1'>
                <div className='inline-flex items-center gap-1 text-[12px] font-semibold text-text-default-tertiary'>
                  <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
                  <span>{refineCreditCost}</span>
                </div>
                <Tooltip title={t('project.textAi.runRefine', 'Run')} placement='top' offset={4}>
                  <Button
                    type='primary'
                    size='medium'
                    shape='round'
                    className={cn('nodrag nopan', textAiUpscaleSendButtonClass)}
                    icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                    disabled={submitRunDisabled}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={onSubmitRun}
                    aria-label={t('project.textAi.runRefine', 'Run')}
                  />
                </Tooltip>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className='nodrag nopan flex w-full min-w-0 max-w-[min(100vw-24px,520px)] flex-col bg-transparent'
      onMouseDown={handleSheetMouseDown}
    >
      {showLoading ? (
        <TextAiLoadingPill
          label={
            runPhase === 'writing'
              ? t('project.textAi.aiWriting', 'AI is writing')
              : t('project.textAi.thinking', 'Thinking')
          }
          onStop={onCancelRun}
          stopAriaLabel={t('project.textAi.stopGeneration', 'Stop')}
        />
      ) : (
        <div className={cn(aimMenuPromptOuterClass, 'w-full min-w-0')}>
          <div className='flex w-full min-w-0 flex-col py-2'>
            <label className='flex flex-col gap-1'>
              <textarea
                ref={inputRef}
                rows={2}
                className='w-full resize-none bg-transparent text-[14px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
                placeholder={t('project.textAi.instructionsPlaceholder', 'Extra instructions…')}
                value={fields.instructions ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
                autoComplete='off'
                aria-label={t('project.textAi.instructionsPlaceholder', 'Extra instructions…')}
              />
            </label>

            {!hasDocumentText ? (
              <p className='mt-2 text-[12px] text-text-default-tertiary'>
                {t('project.textAi.needBody', 'Add text in the node first, or open edit mode.')}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export const LocalTextAiTriggerBar: FC<LocalTextAiTriggerBarProps> = ({
  hasDocumentText,
  fields,
  onActiveToolChange,
  onFieldsChange,
  menuPlacement = 'top-start',
  embedded = false,
  onRunImmediate,
  onRefineNotesPanel,
  onCreateNotesPanel,
  isRunning = false,
}) => {
  const { t } = useTranslation();

  const refineMenuItems: MenuItemType[] = useMemo(
    () =>
      REFINE_TOOLS.map((x) => ({
        key: x.id,
        label: (
          <span className='flex items-center gap-2 text-[13px] text-text-default-base'>
            <span className='text-icon-base'>{x.icon}</span>
            {t(x.labelKey, x.def)}
          </span>
        ),
      })),
    [t],
  );

  const createMenuItems: MenuItemType[] = useMemo(
    () =>
      CREATE_TOOLS.map((x) => ({
        key: x.id,
        label: (
          <span className='flex items-center gap-2 text-[13px] text-text-default-base'>
            <span className='text-icon-base'>{x.icon}</span>
            {t(x.labelKey, x.def)}
          </span>
        ),
      })),
    [t],
  );

  const onRefineMenuClick = useCallback(
    (key: string | number) => {
      const id = String(key) as 'polish' | 'expand' | 'summarize' | 'translate' | 'rewrite' | 'continue';
      if (onRefineNotesPanel) {
        if (id === 'translate') {
          onFieldsChange({
            ...fields,
            language: fields.language ?? 'English',
            instructions: fields.instructions ?? '',
          });
        } else if (id === 'rewrite') {
          onFieldsChange({
            ...fields,
            style: fields.style ?? 'formal',
            instructions: fields.instructions ?? '',
          });
        } else {
          onFieldsChange({ ...fields, instructions: fields.instructions ?? '' });
        }
        onRefineNotesPanel(id);
        return;
      }
      if (onRunImmediate) {
        if (id === 'translate') {
          onFieldsChange({
            ...fields,
            language: fields.language ?? 'English',
            instructions: fields.instructions ?? '',
          });
        } else if (id === 'rewrite') {
          onFieldsChange({
            ...fields,
            style: fields.style ?? 'formal',
            instructions: fields.instructions ?? '',
          });
        } else {
          onFieldsChange({ ...fields, instructions: fields.instructions ?? '' });
        }
        onRunImmediate(id);
        return;
      }
      if (id === 'translate') {
        onActiveToolChange('translate');
        onFieldsChange({
          ...fields,
          language: fields.language ?? 'English',
          instructions: fields.instructions ?? '',
        });
        return;
      }
      if (id === 'rewrite') {
        onActiveToolChange('rewrite');
        onFieldsChange({
          ...fields,
          style: fields.style ?? 'formal',
          instructions: fields.instructions ?? '',
        });
        return;
      }
      onActiveToolChange(id);
      onFieldsChange({ ...fields, instructions: fields.instructions ?? '' });
    },
    [fields, onActiveToolChange, onFieldsChange, onRefineNotesPanel, onRunImmediate],
  );

  const onCreateMenuClick = useCallback(
    (key: string | number) => {
      const id = String(key) as 'generate' | 'character' | 'storyboard' | 'script';
      if (onCreateNotesPanel) {
        onFieldsChange({ ...fields, instructions: fields.instructions ?? '' });
        onCreateNotesPanel(id);
        return;
      }
      if (onRunImmediate) {
        onFieldsChange({ ...fields, instructions: fields.instructions ?? '' });
        onRunImmediate(id);
        return;
      }
      onActiveToolChange(id);
      onFieldsChange({});
    },
    [fields, onActiveToolChange, onFieldsChange, onCreateNotesPanel, onRunImmediate],
  );

  /** Hover hints stay above the triggers so they don’t clash with the dropdown panel below. */
  const triggersBody = (
    <>
      <Dropdown
        trigger='click'
        placement={menuPlacement}
        offset={6}
        items={refineMenuItems}
        onClick={(key) => onRefineMenuClick(key)}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title={t('project.textAi.refineMenuHint', 'Adjust existing text')} placement='top' offset={4}>
          <button
            type='button'
            className={triggerClass}
            disabled={!hasDocumentText || isRunning}
            aria-haspopup='listbox'
          >
            <span className='max-w-[120px] truncate'>{t('project.textAi.refineMenu', 'Refine')}</span>
            <RiArrowDropDownLine size={18} className='shrink-0 text-icon-base' aria-hidden />
          </button>
        </Tooltip>
      </Dropdown>

      <Dropdown
        trigger='click'
        placement={menuPlacement}
        offset={6}
        items={createMenuItems}
        onClick={(key) => onCreateMenuClick(key)}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title={t('project.textAi.createGroup', 'Create')} placement='top' offset={4}>
          <button type='button' className={triggerClass} disabled={isRunning} aria-haspopup='listbox'>
            <span className='max-w-[120px] truncate'>{t('project.textAi.createGroup', 'Create')}</span>
            <RiArrowDropDownLine size={18} className='shrink-0 text-icon-base' aria-hidden />
          </button>
        </Tooltip>
      </Dropdown>
    </>
  );

  return embedded ? (
    <div
      className='flex min-w-0 flex-1 flex-wrap items-center gap-1'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {triggersBody}
    </div>
  ) : (
    <div className={triggerBarShellClass} onMouseDown={(e) => e.stopPropagation()}>
      <div className='flex flex-wrap items-center gap-1'>{triggersBody}</div>
    </div>
  );
};

export type LocalTextAiToolFormPanelProps = Omit<LocalTextAiToolsPanelProps, 'activeTool'> & { activeTool: TextAiToolId };

export const LocalTextAiToolFormPanel: FC<LocalTextAiToolFormPanelProps> = ({
  activeTool,
  fields,
  onFieldsChange,
  onActiveToolChange,
  hasDocumentText,
  onMockRun,
  isRunning,
}) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  const styleSelectOptions = useMemo(
    () =>
      STYLES.map((x) => ({
        value: x.key,
        label: t(x.labelKey, x.def),
      })),
    [t],
  );

  const toolTitle = useMemo(() => getTextAiToolDisplayTitle(activeTool, t), [activeTool, t]);
  const toolHeaderIcon = useMemo(() => getTextAiToolHeaderIcon(activeTool), [activeTool]);

  const canRun = useMemo(() => {
    if (isRunning) return false;
    if (['polish', 'expand', 'summarize', 'translate', 'rewrite', 'continue'].includes(activeTool)) {
      return hasDocumentText;
    }
    if (activeTool === 'generate') return (fields.instructions ?? '').trim().length > 0;
    if (activeTool === 'character') return (fields.name ?? '').trim().length > 0;
    if (activeTool === 'storyboard') return (fields.instructions ?? '').trim().length > 0;
    if (activeTool === 'script') return (fields.scene_description ?? '').trim().length > 0;
    return false;
  }, [activeTool, fields, hasDocumentText, isRunning]);

  const handleRun = () => {
    if (!canRun) return;
    onMockRun(activeTool);
  };

  useEffect(() => {
    const el = panelRef.current?.querySelector('textarea, input');
    if (el instanceof HTMLElement) {
      requestAnimationFrame(() => el.focus());
    }
  }, [activeTool]);

  return (
    <div
      ref={panelRef}
      className={bottomFormShellClass}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className='relative z-0 flex flex-col gap-2'>
        <div className='flex items-center justify-between gap-2 px-1 pb-1'>
          <div className='inline-flex min-w-0 items-center gap-1.5'>
            {toolHeaderIcon ? (
              <span className='flex shrink-0 text-icon-base' aria-hidden>
                {toolHeaderIcon}
              </span>
            ) : null}
            <span className='truncate text-sm font-bold text-text-default-base'>{toolTitle}</span>
          </div>
          <Tooltip title={t('project.toolbar.exit', 'Exit')} placement='top' offset={4}>
            <button
              type='button'
              className={bottomToolbarIconBtnClass}
              onClick={() => onActiveToolChange(null)}
              disabled={isRunning}
              aria-label={t('project.toolbar.exit', 'Exit')}
            >
              <Icon name='imageEditor-multi-angle-close-icon' width={18} height={18} color='#383838' />
            </button>
          </Tooltip>
        </div>

        <TextAiToolSheetFormFields
          tool={activeTool}
          fields={fields}
          onFieldsChange={onFieldsChange}
          hasDocumentText={hasDocumentText}
          styleSelectOptions={styleSelectOptions}
          fieldsDisabled={isRunning}
        />

        <div className='mt-3 flex items-center justify-between gap-3 px-1'>
          <div className='min-w-0 flex-1' />
          <div className='flex items-center gap-1'>
            <div className='inline-flex items-center gap-1 text-[12px] font-semibold text-text-default-tertiary'>
              <Icon name='imageEditor-nano-banana-credit-icon' width={16} height={16} />
              <span>{TEXT_AI_REFINE_CREDIT_PLACEHOLDER}</span>
            </div>
            <Tooltip title={t('project.textAi.runRefine', 'Run')} placement='top' offset={4}>
              <Button
                type='primary'
                size='medium'
                shape='round'
                className={cn('nodrag nopan', textAiUpscaleSendButtonClass)}
                icon={<Icon name='project-chat-send-icon' width={18} height={16} color='#fff' />}
                disabled={!canRun}
                loading={isRunning}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleRun}
                aria-label={t('project.textAi.runRefine', 'Run')}
              />
            </Tooltip>
          </div>
        </div>
      </div>
      {isRunning ? <CanvasOutputPendingProgressOverlay durationMs={TEXT_AI_RUN_OVERLAY_MS} /> : null}
    </div>
  );
};

const LocalTextAiToolsPanel: FC<LocalTextAiToolsPanelProps> = ({
  hasDocumentText,
  activeTool,
  fields,
  onActiveToolChange,
  onFieldsChange,
  onMockRun,
  isRunning,
}) => (
  <div className={shellClass} onMouseDown={(e) => e.stopPropagation()}>
    <LocalTextAiTriggerBar
      hasDocumentText={hasDocumentText}
      fields={fields}
      onActiveToolChange={onActiveToolChange}
      onFieldsChange={onFieldsChange}
      menuPlacement='top-start'
    />
    {activeTool ? (
      <LocalTextAiToolFormPanel
        activeTool={activeTool}
        hasDocumentText={hasDocumentText}
        fields={fields}
        onActiveToolChange={onActiveToolChange}
        onFieldsChange={onFieldsChange}
        onMockRun={onMockRun}
        isRunning={isRunning}
      />
    ) : null}
  </div>
);

export default memo(LocalTextAiToolsPanel);
