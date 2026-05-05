/**
 * Floating rich-text controls for local canvas text nodes — same chrome as `imageNode/Toolbar` (icon + label, single bar).
 */
import React, { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/base/icon';
import Tooltip from '@/components/base/tooltip';
import Divider from '@/components/base/divider';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';
import type { LocalTextRichTextFormatState } from './LocalTextNodeContent';

export type { LocalTextRichTextFormatState } from './LocalTextNodeContent';

/** Shared outer chrome when the format strip sits alone or wraps Refine/Create in {@link TextNode}. */
export const localTextNodeTopToolbarShellClass =
  'pointer-events-auto flex flex-wrap items-center gap-0 rounded-[8px] border border-border-default-base bg-background-default-base px-[6px] py-[4px] shadow-[0px_1px_4px_0px_rgba(12,12,13,0.05),0px_1px_8px_1px_rgba(12,12,13,0.05)]';

const shellClass = localTextNodeTopToolbarShellClass;

const actionBtnClass =
  'flex h-8 shrink-0 items-center gap-1 rounded-[6px] px-[8px] text-icon-base transition-colors hover:bg-background-default-base-hover';

export interface LocalTextFormatToolbarProps {
  formatState: LocalTextRichTextFormatState;
  /** Empty placeholder: only Edit + Copy until the editor mounts. */
  placeholderMode?: boolean;
  onEditFromToolbar?: (e: React.MouseEvent) => void;
  onH1: (e: React.MouseEvent) => void;
  onH2: (e: React.MouseEvent) => void;
  onH3: (e: React.MouseEvent) => void;
  onParagraph: (e: React.MouseEvent) => void;
  onOrderedList: (e: React.MouseEvent) => void;
  onUnorderedList: (e: React.MouseEvent) => void;
  onBold: (e: React.MouseEvent) => void;
  onCopy?: (e: React.MouseEvent) => void;
  /**
   * Omit outer bordered shell — parent renders one combined bar (e.g. with AI triggers).
   * Trailing divider after Copy is omitted; parent inserts the separator.
   */
  embedded?: boolean;
}

const LocalTextFormatToolbar: React.FC<LocalTextFormatToolbarProps> = ({
  formatState,
  placeholderMode = false,
  onEditFromToolbar,
  onH1,
  onH2,
  onH3,
  onParagraph,
  onOrderedList,
  onUnorderedList,
  onBold,
  onCopy,
  embedded = false,
}) => {
  const { t } = useTranslation();
  const outerClass = embedded ? 'flex min-w-0 shrink-0 items-center gap-0' : shellClass;

  const headingItems: MenuItemType[] = [
    {
      key: 'h1',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-h1-icon' width={10} height={10} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>H1</span>
        </div>
      ),
    },
    {
      key: 'h2',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-h2-icon' width={12} height={12} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>H2</span>
        </div>
      ),
    },
    {
      key: 'h3',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-h3-icon' width={12} height={12} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>H3</span>
        </div>
      ),
    },
    {
      key: 'p',
      label: (
        <div className='flex items-center gap-1'>
          <Icon name='project-paragraph-icon' width={10} height={10} color='var(--color-icon-base)' />
          <span className='text-[13px] text-text-default-base'>
            {t('project.toolbar.textParagraph', 'Paragraph')}
          </span>
        </div>
      ),
    },
  ];

  const onHeadingMenu = useCallback(
    (key: string | number) => {
      const fakeEv = { preventDefault: () => {}, stopPropagation: () => {} } as React.MouseEvent;
      if (key === 'h1') onH1(fakeEv);
      if (key === 'h2') onH2(fakeEv);
      if (key === 'h3') onH3(fakeEv);
      if (key === 'p') onParagraph(fakeEv);
    },
    [onH1, onH2, onH3, onParagraph],
  );

  if (placeholderMode) {
    return (
      <div className={outerClass} onMouseDown={(e) => e.stopPropagation()}>
        <Tooltip title={t('project.toolbar.textEdit', 'Edit')} placement='top' offset={4}>
          <button
            type='button'
            className={actionBtnClass}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEditFromToolbar?.(e);
            }}
          >
            <Icon name='project-launch-editor-icon' width={20} height={20} color='var(--color-icon-base)' />
            <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
              {t('project.toolbar.textEdit', 'Edit')}
            </span>
          </button>
        </Tooltip>
        {onCopy ? (
          <>
            <Divider type='vertical' className='mx-[2px] h-[18px]' />
            <Tooltip title={t('project.toolbar.copy', 'Copy')} placement='top' offset={4}>
              <button
                type='button'
                className={actionBtnClass}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCopy(e);
                }}
              >
                <Icon name='project-copy-icon' width={16} height={16} color='var(--color-icon-base)' />
                <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
                  {t('project.toolbar.copy', 'Copy')}
                </span>
              </button>
            </Tooltip>
            {!embedded ? <Divider type='vertical' className='mx-[2px] h-[18px]' /> : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className={outerClass} onMouseDown={(e) => e.stopPropagation()}>
      <Tooltip title={t('project.toolbar.textBold', 'Bold')} placement='top' offset={4}>
        <button
          type='button'
          className={`${actionBtnClass} ${formatState.bold ? 'bg-background-default-base-hover' : ''}`}
          onMouseDown={onBold}
          aria-pressed={formatState.bold}
        >
          <Icon
            name='project-bold-icon'
            width={12}
            height={12}
            color={formatState.bold ? 'var(--color-text-default-base)' : 'var(--color-icon-base)'}
          />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.textBold', 'Bold')}
          </span>
        </button>
      </Tooltip>
      <Tooltip title={t('project.toolbar.textNumberedList', 'Numbered list')} placement='top' offset={4}>
        <button
          type='button'
          className={`${actionBtnClass} ${formatState.orderedList ? 'bg-background-default-base-hover' : ''}`}
          onMouseDown={onOrderedList}
          aria-pressed={formatState.orderedList}
        >
          <Icon
            name='project-list-ordered-icon'
            width={12}
            height={12}
            color={formatState.orderedList ? 'var(--color-text-default-base)' : 'var(--color-icon-base)'}
          />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.textNumberedList', 'Numbered')}
          </span>
        </button>
      </Tooltip>
      <Tooltip title={t('project.toolbar.textBulletList', 'Bullet list')} placement='top' offset={4}>
        <button
          type='button'
          className={`${actionBtnClass} ${formatState.unorderedList ? 'bg-background-default-base-hover' : ''}`}
          onMouseDown={onUnorderedList}
          aria-pressed={formatState.unorderedList}
        >
          <Icon
            name='project-list-unordered-icon'
            width={12}
            height={12}
            color={formatState.unorderedList ? 'var(--color-text-default-base)' : 'var(--color-icon-base)'}
          />
          <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
            {t('project.toolbar.textBulletList', 'Bullet')}
          </span>
        </button>
      </Tooltip>
      <Divider type='vertical' className='mx-[2px] h-[18px]' />
      <Dropdown
        trigger='click'
        placement='bottom-end'
        offset={6}
        items={headingItems}
        onClick={(key) => onHeadingMenu(key)}
        popupClassName='rounded-[8px] border border-border-default-base shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'
        itemClassName='min-h-8 px-2 py-1.5'
      >
        <Tooltip title={t('project.toolbar.textHeadings', 'Headings')} placement='top' offset={4}>
          <button type='button' className={`${actionBtnClass} max-w-[140px]`}>
            <Icon name='project-h2-icon' width={14} height={14} color='var(--color-icon-base)' />
            <span className='max-w-[100px] truncate text-[14px] leading-none text-text-default-base'>
              {formatState.block === 'h1'
                ? 'H1'
                : formatState.block === 'h2'
                  ? 'H2'
                  : formatState.block === 'h3'
                    ? 'H3'
                    : t('project.toolbar.textParagraph', 'Paragraph')}
            </span>
          </button>
        </Tooltip>
      </Dropdown>
      {onCopy ? (
        <>
          <Divider type='vertical' className='mx-[2px] h-[18px]' />
          <Tooltip title={t('project.toolbar.copy', 'Copy')} placement='top' offset={4}>
            <button
              type='button'
              className={actionBtnClass}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCopy(e);
              }}
            >
              <Icon name='project-copy-icon' width={16} height={16} color='var(--color-icon-base)' />
              <span className='whitespace-nowrap text-[14px] leading-none text-text-default-base'>
                {t('project.toolbar.copy', 'Copy')}
              </span>
            </button>
          </Tooltip>
          {!embedded ? <Divider type='vertical' className='mx-[2px] h-[18px]' /> : null}
        </>
      ) : null}
    </div>
  );
};

export default memo(LocalTextFormatToolbar);
