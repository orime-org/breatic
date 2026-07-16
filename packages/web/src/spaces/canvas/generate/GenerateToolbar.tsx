// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Box, Focus, MapPin, Plus, X, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';

/** The two not-yet-built tool buttons rendered as disabled placeholders (slice-1 decision B). */
const PLACEHOLDER_TOOLS = [
  { key: 'mark', testId: 'generate-tool-mark', Icon: MapPin },
  { key: 'focus', testId: 'generate-tool-focus', Icon: Focus },
] as const;

// Shared layout / focus / disabled classes; color + hover applied per-state.
const TOOL_BASE =
  'flex flex-col items-center gap-1 rounded-overlay px-2 py-1.5 text-xs ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';
const TOOL_INACTIVE =
  ' text-muted-foreground enabled:hover:bg-accent enabled:hover:text-accent-foreground';
// Active toggle = the minimap's white fill (ViewportToolbar VtButton), a solid
// `bg-foreground text-background` with NO accent hover — every toggle in the
// panel must read identically (I4, user 2026-07-12).
const TOOL_ACTIVE = ' bg-foreground text-background';

interface ToggleToolProps {
  testId: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  active: boolean;
  disabled: boolean;
}

/**
 * A live toggle tool button (Reference): enters a canvas pick mode and
 * highlights (white fill) while its pick runs, so it reads as a toggle.
 * @param root0 - Component props.
 * @param root0.testId - Stable test id.
 * @param root0.label - Visible + a11y label.
 * @param root0.Icon - Lucide icon.
 * @param root0.onClick - Enter / exit the pick.
 * @param root0.active - Whether this tool's pick is running (highlighted).
 * @param root0.disabled - Whether the tool is unavailable in the current mode.
 * @returns The toggle tool button.
 */
function ToggleTool({
  testId,
  label,
  Icon,
  onClick,
  active,
  disabled,
}: ToggleToolProps): React.JSX.Element {
  return (
    <button
      type='button'
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={TOOL_BASE + (active ? TOOL_ACTIVE : TOOL_INACTIVE)}
    >
      <Icon className='h-4 w-4' aria-hidden='true' />
      {label}
    </button>
  );
}

interface StyleToolProps {
  /** Enter the style pick (empty slot), or re-enter to REPLACE (filled slot). */
  onStyle: () => void;
  /** Whether the style pick is running — highlights the button. */
  active: boolean;
  /** The picked style image URL (pick-time copy), or undefined when empty. */
  thumbnail?: string;
  /** Clear the picked style image (the ✕ badge). */
  onClear: () => void;
  /** Disable picking — the active model takes no style reference. */
  disabled: boolean;
  /** Localized ✕ aria-label. */
  clearLabel: string;
  /** Localized tool label ("Style"). */
  label: string;
}

/**
 * The Style tool slot (#1664): an icon + label button while empty (click
 * enters the style pick); once an image is picked the thumbnail COVERS the
 * button as an absolute overlay while the original icon + label keep laying
 * out invisibly underneath — so the button footprint is IDENTICAL in both
 * states, in every locale, and picking a style never shifts the toolbar
 * (user 2026-07-16). Clicking the filled slot re-enters the pick (the next
 * selection REPLACES the copy). A ✕ badge at the top-right clears it; the ✕
 * is a SIBLING button positioned over the corner — never nested inside the
 * main button (button-in-button reparents silently). The ✕ stays active even
 * when the model gates picking off, so a stale copy can always be removed.
 * The filled button keeps its accessible name via aria-label (the covered
 * label is hidden from the a11y tree), and a running pick shows as a
 * foreground ring (the white-fill active style would hide behind the image).
 * @param root0 - Component props.
 * @param root0.onStyle - Enter / exit the style pick.
 * @param root0.active - Whether the style pick is running.
 * @param root0.thumbnail - The picked style image URL, if any.
 * @param root0.onClear - Clear the picked style image.
 * @param root0.disabled - Whether picking is unavailable for the active model.
 * @param root0.clearLabel - Localized ✕ aria-label.
 * @param root0.label - Localized tool label.
 * @returns The style tool slot.
 */
function StyleTool({
  onStyle,
  active,
  thumbnail,
  onClear,
  disabled,
  clearLabel,
  label,
}: StyleToolProps): React.JSX.Element {
  return (
    <div className='relative'>
      <button
        type='button'
        data-testid='generate-tool-style'
        aria-label={label}
        onClick={onStyle}
        disabled={disabled}
        aria-pressed={active}
        className={
          'relative overflow-hidden ' +
          TOOL_BASE +
          (active ? TOOL_ACTIVE : TOOL_INACTIVE) +
          (active && thumbnail ? ' ring-1 ring-foreground' : '')
        }
      >
        {/* The icon + label always lay out (invisible when covered) so the
            button's intrinsic size never changes between states. */}
        <Box
          className={'h-4 w-4' + (thumbnail ? ' invisible' : '')}
          aria-hidden='true'
        />
        <span className={thumbnail ? 'invisible' : undefined}>{label}</span>
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=''
            data-testid='generate-style-thumbnail'
            className='absolute inset-0 h-full w-full object-cover'
          />
        ) : null}
      </button>
      {thumbnail ? (
        <button
          type='button'
          data-testid='generate-style-clear'
          aria-label={clearLabel}
          onClick={onClear}
          className='absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        >
          <X className='h-2.5 w-2.5' aria-hidden='true' />
        </button>
      ) : null}
    </div>
  );
}

interface GenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /**
   * Whether the reference pick is running — renders the button in its active
   * (highlighted) state so it reads as a toggle (user 2026-07-12 G).
   */
  referenceActive?: boolean;
  /**
   * Disable the Reference button — set in text-to-image, which generates from
   * scratch and ignores source images (mode toggle 2026-07-09 §2.5).
   */
  referenceDisabled?: boolean;
  /** Toggle the "select a style reference from the canvas" mode (#1664). */
  onStyle: () => void;
  /** Whether the style pick is running — highlights the Style button. */
  styleActive?: boolean;
  /** The picked style image URL (pick-time copy) shown in the Style slot. */
  styleThumbnail?: string;
  /** Clear the picked style image (the Style slot's ✕ badge). */
  onClearStyle: () => void;
  /**
   * Disable style PICKING — the active model declares no `style_images`
   * capability. A stale thumbnail still renders and its ✕ stays active.
   */
  styleDisabled?: boolean;
}

/**
 * The Generate panel's top tool row: Style / Mark / Focus / Reference. Style
 * and Reference are live canvas picks; Mark / Focus render as disabled
 * placeholders until their slices ship (slice-1 decision B). Reference feeds
 * i2i source images (disabled in text-to-image); Style holds ONE picked style
 * image as a pick-time copy (#1664) — gated on the active MODEL's capability
 * (`style_images` on the wire), never on the mode.
 * @param root0 - Component props.
 * @param root0.onReference - Enter the reference-pick mode.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.referenceDisabled - Disable Reference (text-to-image).
 * @param root0.onStyle - Enter the style-pick mode.
 * @param root0.styleActive - Whether the style pick is running.
 * @param root0.styleThumbnail - The picked style image URL, if any.
 * @param root0.onClearStyle - Clear the picked style image.
 * @param root0.styleDisabled - Disable style picking (model capability gate).
 * @returns The tool row.
 */
export const GenerateToolbar = React.memo(function GenerateToolbar({
  onReference,
  referenceActive = false,
  referenceDisabled = false,
  onStyle,
  styleActive = false,
  styleThumbnail,
  onClearStyle,
  styleDisabled = false,
}: GenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1' role='group'>
      <StyleTool
        onStyle={onStyle}
        active={styleActive}
        thumbnail={styleThumbnail}
        onClear={onClearStyle}
        disabled={styleDisabled}
        clearLabel={t('canvas.generatePanel.removeStyle')}
        label={t('canvas.generatePanel.style')}
      />
      {PLACEHOLDER_TOOLS.map(({ key, testId, Icon }) => (
        <button
          key={key}
          type='button'
          data-testid={testId}
          disabled
          className={TOOL_BASE + TOOL_INACTIVE}
        >
          <Icon className='h-4 w-4' aria-hidden='true' />
          {t(`canvas.generatePanel.${key}`)}
        </button>
      ))}
      <ToggleTool
        testId='generate-tool-reference'
        label={t('canvas.generatePanel.reference')}
        Icon={Plus}
        onClick={onReference}
        active={referenceActive}
        disabled={referenceDisabled}
      />
    </div>
  );
});
