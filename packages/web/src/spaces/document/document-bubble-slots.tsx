// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 浮出条上四个悬停展开的格位：块类型 · 对齐 · 颜色 · AI。
 *
 * 四个共用 {@link DocumentBubbleMenu} 那层外壳（开合规则、焦点、滚轮、滚动即
 * 关全在那儿），这里只管每一格自己长什么样、菜单里装什么。
 *
 * 这一轮只有块类型菜单里的三项接得上命令（无序列表 · 有序列表 · 引用，它们
 * 今天就在条上），其余按「还没开放」的既有表示画 —— user 2026-08-23 的规则，
 * 原话在 `document-coming-tool.tsx` 的模块注释里，user 2026-08-26 确认沿用。
 */

import * as React from 'react';
import { ChevronDown, TextAlignStart, Sparkles } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { DocumentBubbleMenu } from '@web/spaces/document/document-bubble-menu';
import { UNAVAILABLE } from '@web/spaces/document/document-coming-tool';
import {
  BLOCK_TYPE_ITEMS,
  currentBlockTypeItem,
} from '@web/spaces/document/document-block-type';
import { BUBBLE_CONTROL_HEIGHT } from '@web/spaces/document/document-tool-button';

/** 一格的公共形态：`.bubble-drop` —— 28 高，左右 6px，三样东西之间 3px。 */
const SLOT = `flex ${BUBBLE_CONTROL_HEIGHT} items-center gap-[3px] px-1.5`;

/** 每一格都从条那里拿到的几样。 */
interface SlotProps {
  editor: Editor;
  /** 菜单挂进哪个元素，传浮出条自己。 */
  container: HTMLElement | null;
  /** 正文的滚动容器。 */
  scroller: HTMLElement | null;
  /** 现在开着的是哪一格，一次只开一个。 */
  openId: string | null;
  /** 要开或要关某一格。 */
  onOpenChange: (id: string, open: boolean) => void;
}

/**
 * 块类型那一格。
 *
 * 图标跟着当前块变（user 2026-08-26），菜单九项照 demo:560-588，其中七项带
 * 快捷键列。
 * @param props - 见 {@link SlotProps}。
 * @returns 这一格。
 */
export const BlockTypeSlot = React.memo(function BlockTypeSlot({
  editor,
  container,
  scroller,
  openId,
  onOpenChange,
}: SlotProps): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-block-type';
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? currentBlockTypeItem(e).id : 'paragraph'),
  });
  const CurrentIcon =
    BLOCK_TYPE_ITEMS.find((item) => item.id === current)?.Icon ??
    BLOCK_TYPE_ITEMS[0].Icon;

  return (
    <DocumentBubbleMenu
      id={id}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-label={t('spaces.document.commands.blockType')}
          data-testid={id}
          data-block-type={current}
          tabIndex={-1}
          className={SLOT}
        >
          <CurrentIcon className='h-4 w-4' />
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      {BLOCK_TYPE_ITEMS.map((item) => {
        const Icon = item.Icon;
        const runnable = item.run !== undefined;
        return (
          <DropdownMenuItem
            key={item.id}
            data-testid={`${id}-item-${item.id}`}
            aria-disabled={runnable ? undefined : 'true'}
            className={runnable ? undefined : UNAVAILABLE}
            onSelect={(event) => {
              if (!runnable) {
                event.preventDefault();
                return;
              }
              item.run?.(editor);
            }}
          >
            <Icon />
            {t(item.labelKey)}
            {item.shortcut ? (
              <DropdownMenuShortcut data-testid={`${id}-shortcut-${item.id}`}>
                {item.shortcut}
              </DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </DocumentBubbleMenu>
  );
});

/** 对齐菜单三项，照 demo:590-596。 */
const ALIGN_ITEMS = [
  { id: 'left', labelKey: 'spaces.document.commands.alignLeft' },
  { id: 'center', labelKey: 'spaces.document.commands.alignCenter' },
  { id: 'right', labelKey: 'spaces.document.commands.alignRight' },
];

/**
 * 对齐那一格。
 *
 * 这一格连同它的三项这一轮都不接命令 —— 对齐要新的 schema 属性，归 #905。
 * @param props - 见 {@link SlotProps}。
 * @returns 这一格。
 */
export const AlignSlot = React.memo(function AlignSlot({
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-align';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.align'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE}`}
        >
          <TextAlignStart className='h-4 w-4' />
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      {ALIGN_ITEMS.map((item) => (
        <DropdownMenuItem
          key={item.id}
          data-testid={`${id}-item-${item.id}`}
          aria-disabled='true'
          className={UNAVAILABLE}
          onSelect={(event) => {
            event.preventDefault();
          }}
        >
          {t(item.labelKey)}
        </DropdownMenuItem>
      ))}
    </DocumentBubbleMenu>
  );
});

/** 颜色面板的七色，照 demo 3.5 和 palette。 */
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];

/**
 * 颜色那一格。
 *
 * 触发按钮是一个字母 A 加箭头（demo:506-509）。面板两行各七色：字体颜色那行
 * 把 A 着色，背景颜色那行是色块（demo 3.5）。这一轮不接命令，归 #905。
 * @param props - 见 {@link SlotProps}。
 * @returns 这一格。
 */
export const ColorSlot = React.memo(function ColorSlot({
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-color';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.color'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE} font-semibold`}
        >
          A
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      <DropdownMenuLabel>
        {t('spaces.document.commands.textColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1 px-2 pb-1'>
        {PALETTE.map((hue) => (
          <span
            key={hue}
            data-testid={`${id}-text-${hue}`}
            className={`${UNAVAILABLE} flex size-6 items-center justify-center rounded-chrome font-semibold`}
            style={{ color: `var(--color-palette-${hue})` }}
          >
            A
          </span>
        ))}
      </div>
      <DropdownMenuLabel>
        {t('spaces.document.commands.fillColor')}
      </DropdownMenuLabel>
      <div className='flex gap-1 px-2 pb-1'>
        {PALETTE.map((hue) => (
          <span
            key={hue}
            data-testid={`${id}-fill-${hue}`}
            className={`${UNAVAILABLE} size-6 rounded-chrome`}
            style={{
              background: `color-mix(in srgb, var(--color-palette-${hue}) 14%, transparent)`,
            }}
          />
        ))}
      </div>
    </DocumentBubbleMenu>
  );
});

/** AI 菜单的三组八条，照菜单体系定稿 §3.2.1。 */
const AI_GROUPS = [
  {
    labelKey: 'spaces.document.commands.aiRewriteGroup',
    items: ['refine', 'expand', 'shorten', 'translate', 'tone'],
  },
  {
    labelKey: 'spaces.document.commands.aiProduceGroup',
    items: ['storyboard', 'illustrate'],
  },
  {
    labelKey: 'spaces.document.commands.aiOtherGroup',
    items: ['custom'],
  },
];

/**
 * AI 那一格。
 *
 * 形态是定稿 §3.2.1 定的：图标加「AI」加箭头，悬上去在下方展开一列命令。
 * 八条命令这一轮都不接，各自归它们自己的任务（定稿 §3.3 的分流）。
 * @param props - 见 {@link SlotProps}。
 * @returns 这一格。
 */
export const AiSlot = React.memo(function AiSlot({
  container,
  scroller,
  openId,
  onOpenChange,
}: Omit<SlotProps, 'editor'>): React.JSX.Element {
  const t = useTranslation();
  const id = 'doc-bubble-coming-ai';
  const label = t('spaces.document.commands.comingLabel', {
    name: t('spaces.document.commands.ai'),
  });

  return (
    <DocumentBubbleMenu
      id={id}
      container={container}
      scroller={scroller}
      open={openId === id}
      onOpenChange={(open) => {
        onOpenChange(id, open);
      }}
      trigger={
        <Button
          variant='ghost'
          size={null}
          aria-disabled='true'
          aria-label={label}
          data-testid={id}
          tabIndex={-1}
          className={`${SLOT} ${UNAVAILABLE}`}
        >
          <Sparkles className='h-4 w-4' />
          {t('spaces.document.commands.ai')}
          <ChevronDown className='h-[13px] w-[13px]' />
        </Button>
      }
    >
      {AI_GROUPS.map((group) => (
        <React.Fragment key={group.labelKey}>
          <DropdownMenuLabel>{t(group.labelKey)}</DropdownMenuLabel>
          {group.items.map((item) => (
            <DropdownMenuItem
              key={item}
              data-testid={`doc-bubble-ai-item-${item}`}
              aria-disabled='true'
              className={UNAVAILABLE}
              onSelect={(event) => {
                event.preventDefault();
              }}
            >
              {t(`spaces.document.commands.ai_${item}`)}
            </DropdownMenuItem>
          ))}
        </React.Fragment>
      ))}
    </DocumentBubbleMenu>
  );
});
