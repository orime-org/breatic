/**
 * Text-node AI tool strip — UI only (no mini-tools API). Mock insert strings align with `new/textEditor/ui/AIMenu`.
 */
import { memo, useCallback, useEffect, useMemo, useRef, type FC } from 'react';
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
import Dropdown, { type MenuItemType } from '@/ui/dropdown';
import Tooltip from '@/ui/tooltip';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import Input from '@/ui/input';
import Select from '@/ui/select';
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
const REFINE_TOOLS: { id: 'polish' | 'expand' | 'summarize' | 'translate' | 'rewrite' | 'continue'; labelKey: string; def: string; icon: React.ReactNode }[] = [
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

const CREATE_TOOLS: { id: 'generate' | 'character' | 'storyboard' | 'script'; labelKey: string; def: string; icon: React.ReactNode }[] = [
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

export const LocalTextAiTriggerBar: FC<LocalTextAiTriggerBarProps> = ({
  hasDocumentText,
  fields,
  onActiveToolChange,
  onFieldsChange,
  menuPlacement = 'top-start',
  embedded = false,
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
    [fields, onActiveToolChange, onFieldsChange],
  );

  const onCreateMenuClick = useCallback(
    (key: string | number) => {
      const id = String(key) as 'generate' | 'character' | 'storyboard' | 'script';
      onActiveToolChange(id);
      onFieldsChange({});
    },
    [onActiveToolChange, onFieldsChange],
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
          <button type='button' className={triggerClass} disabled={!hasDocumentText} aria-haspopup='listbox'>
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
          <button type='button' className={triggerClass} aria-haspopup='listbox'>
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

  const toolTitle = useMemo(() => {
    const map: Record<TextAiToolId, string> = {
      polish: t('project.textAi.polish', 'Polish'),
      expand: t('project.textAi.expand', 'Expand'),
      summarize: t('project.textAi.summarize', 'Summarize'),
      translate: t('project.textAi.translate', 'Translate'),
      rewrite: t('project.textAi.rewrite', 'Rewrite'),
      continue: t('project.textAi.continue', 'Continue'),
      generate: t('project.textAi.generate', 'Generate'),
      character: t('project.textAi.character', 'Character'),
      storyboard: t('project.textAi.storyboard', 'Storyboard'),
      script: t('project.textAi.script', 'Script'),
    };
    return map[activeTool];
  }, [activeTool, t]);

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
        <div className='flex items-center justify-between gap-1 px-1 pb-1'>
          <div className='inline-flex min-w-0 items-center gap-1'>
            <Icon
              name='project-excalidraw-top-quick-edit-icon'
              width={18}
              height={18}
              color='var(--color-icon-base)'
            />
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

        {activeTool === 'rewrite' ? (
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.targetStyle', 'Style')}</span>
            <Select
              size='middle'
              options={styleSelectOptions}
              value={fields.style ?? 'formal'}
              onChange={(v) => onFieldsChange({ ...fields, style: String(v) })}
              disabled={isRunning}
            />
          </label>
        ) : null}

        {['polish', 'expand', 'summarize', 'continue', 'translate', 'rewrite'].includes(activeTool) ? (
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-tertiary'>
              {t('project.textAi.optionalHint', 'Optional notes')}
            </span>
            <div className='flex'>
              <textarea
                className={`${bottomToolbarTextareaClass} min-h-[96px]`}
                placeholder={t('project.textAi.instructionsPlaceholder', 'Extra instructions…')}
                value={fields.instructions ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
                disabled={isRunning}
              />
            </div>
          </label>
        ) : null}

        {activeTool === 'generate' ? (
          <label className='flex flex-col gap-1'>
            <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.instructions', 'Instructions')} *</span>
            <div className='flex'>
              <textarea
                className={`${bottomToolbarTextareaClass} min-h-[96px]`}
                value={fields.instructions ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
                disabled={isRunning}
              />
            </div>
          </label>
        ) : null}

        {activeTool === 'character' ? (
          <div className='flex flex-col gap-2'>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.characterName', 'Name')} *</span>
              <Input
                inputType='text'
                value={fields.name ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, name: e.target.value })}
                disabled={isRunning}
              />
            </label>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.traits', 'Traits')}</span>
              <div className='flex'>
                <textarea
                  className={`${bottomToolbarTextareaClass} min-h-[72px]`}
                  value={fields.traits ?? ''}
                  onChange={(e) => onFieldsChange({ ...fields, traits: e.target.value })}
                  disabled={isRunning}
                />
              </div>
            </label>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.context', 'Context')}</span>
              <div className='flex'>
                <textarea
                  className={`${bottomToolbarTextareaClass} min-h-[72px]`}
                  value={fields.context ?? ''}
                  onChange={(e) => onFieldsChange({ ...fields, context: e.target.value })}
                  disabled={isRunning}
                />
              </div>
            </label>
          </div>
        ) : null}

        {activeTool === 'storyboard' ? (
          <div className='flex flex-col gap-2'>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.storyboardBrief', 'Outline / brief')} *</span>
              <div className='flex'>
                <textarea
                  className={`${bottomToolbarTextareaClass} min-h-[96px]`}
                  value={fields.instructions ?? ''}
                  onChange={(e) => onFieldsChange({ ...fields, instructions: e.target.value })}
                  disabled={isRunning}
                />
              </div>
            </label>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.sceneCount', 'Scene count')}</span>
              <Input
                className='max-w-[120px]'
                inputType='number'
                min={1}
                value={fields.scene_count ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, scene_count: e.target.value })}
                disabled={isRunning}
              />
            </label>
          </div>
        ) : null}

        {activeTool === 'script' ? (
          <div className='flex flex-col gap-2'>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-secondary'>{t('project.textAi.sceneDescription', 'Scene')} *</span>
              <div className='flex'>
                <textarea
                  className={`${bottomToolbarTextareaClass} min-h-[96px]`}
                  value={fields.scene_description ?? ''}
                  onChange={(e) => onFieldsChange({ ...fields, scene_description: e.target.value })}
                  disabled={isRunning}
                />
              </div>
            </label>
            <label className='flex flex-col gap-1'>
              <span className='text-[12px] text-text-default-tertiary'>{t('project.textAi.charactersCsv', 'Characters (comma-separated)')}</span>
              <Input
                inputType='text'
                value={fields.characters ?? ''}
                onChange={(e) => onFieldsChange({ ...fields, characters: e.target.value })}
                disabled={isRunning}
              />
            </label>
          </div>
        ) : null}

        {!hasDocumentText && ['polish', 'expand', 'summarize', 'translate', 'rewrite', 'continue'].includes(activeTool) ? (
          <p className='text-[12px] text-text-default-tertiary'>{t('project.textAi.needBody', 'Add text in the node first, or open edit mode.')}</p>
        ) : null}

        <div className='mt-3 flex justify-end gap-2 px-1'>
          <Button type='default' size='small' onClick={() => onActiveToolChange(null)} disabled={isRunning}>
            {t('project.textAi.cancel', 'Cancel')}
          </Button>
          <Button type='primary' size='small' onClick={handleRun} disabled={!canRun} loading={isRunning}>
            {t('project.textAi.run', 'Run')}
          </Button>
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
