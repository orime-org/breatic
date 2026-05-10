/**
 * ViewportToolbar — bottom-right floating toolbar with four button
 * groups (spec/02 §4.6 v13, mockup
 * `2026-04-27-visual-language/05-canvas-native-tailwind.html`):
 *
 *   ① 小地图 toggle  (showMiniMap)
 *   ② 适应视图       (fitView)
 *   ③ 网格吸附 toggle (snapToGrid)
 *   ④ 缩放 trio      (− / NN% / +)
 *
 * Replaces the v12-era `UndoRedoToolbar` (bottom-left). Undo / redo
 * UI affordances move to keyboard-only (`HotkeysHandler` already
 * binds Cmd+Z / Cmd+Y / Cmd+Shift+Z) — same as Figma. The 100 %
 * reset button is gone too; hold + or − to ladder back, or pick a
 * different zoom from the percent label (V2: clickable label).
 *
 * State ownership: `showMiniMap` + `snapEnabled` live in the parent
 * (ProjectCanvasContent) so the same toggles drive ReactFlow's
 * `snapToGrid` prop and `<CustomMiniMap />` mount/unmount. The
 * toolbar is purely the visible UI surface; it stores no state.
 */
import React, { memo } from 'react';
import { useReactFlow, useStore, useViewport } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import Tooltip from '@/ui/tooltip';

interface ViewportToolbarProps {
  showMiniMap: boolean;
  onToggleMiniMap: () => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
}

/** Magnet icon for the snap-to-grid toggle. Inlined because the project's icon dictionary doesn't have a magnet glyph today. Kept in the mockup style (`stroke="currentColor"` so the Tailwind text color cascades through). */
const MagnetIcon: React.FC = () => (
  <svg
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth={2}
    strokeLinecap='round'
    strokeLinejoin='round'
    className='w-4 h-4'
    aria-hidden
  >
    <path d='M5 3v8a7 7 0 0 0 14 0V3' />
    <path d='M5 11h4' />
    <path d='M15 11h4' />
  </svg>
);

const ViewportToolbar: React.FC<ViewportToolbarProps> = ({
  showMiniMap,
  onToggleMiniMap,
  snapEnabled,
  onToggleSnap,
}) => {
  const { t } = useTranslation();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();
  const minZoom = useStore((s) => s.minZoom);
  const maxZoom = useStore((s) => s.maxZoom);

  const btnBase =
    'w-8 h-8 inline-flex items-center justify-center rounded-md transition-colors flex-shrink-0';
  const btnIdle =
    'text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-primary';
  const btnActive =
    'bg-text-default-primary text-background-default-base hover:bg-text-default-base';
  const btnDisabled = 'opacity-50 cursor-not-allowed';

  // Hard caps from ReactFlow's store; without them the +/− buttons
  // can fire successfully past the practical zoom limit and the
  // percent label flips back when ReactFlow snaps it. Disabling at
  // the boundary feels saner than letting the click no-op.
  const atMaxZoom = zoom >= maxZoom - 1e-3;
  const atMinZoom = zoom <= minZoom + 1e-3;

  return (
    <div
      className='absolute bottom-3 right-3 z-30 inline-flex items-center gap-0.5 rounded-lg border border-border-default-secondary bg-background-default-base p-1 shadow-md select-none pointer-events-auto'
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ① 小地图 toggle */}
      <Tooltip
        title={
          showMiniMap
            ? t('canvas.toolbar.closeMinimap', { defaultValue: '关闭小地图' })
            : t('canvas.toolbar.openMinimap', { defaultValue: '画布小地图' })
        }
        placement='top'
      >
        <button
          type='button'
          aria-pressed={showMiniMap}
          aria-label={t('canvas.toolbar.minimap', { defaultValue: '小地图' })}
          onClick={onToggleMiniMap}
          className={`${btnBase} ${showMiniMap ? btnActive : btnIdle}`}
        >
          <Icon name='project-minimap-icon' width={18} height={18} />
        </button>
      </Tooltip>

      {/* ② 适应视图 */}
      <Tooltip
        title={t('canvas.toolbar.fitToView', { defaultValue: '适应视图' })}
        placement='top'
      >
        <button
          type='button'
          aria-label={t('canvas.toolbar.fitToView', { defaultValue: '适应视图' })}
          onClick={() => fitView({ padding: 0.15, duration: 200 })}
          className={`${btnBase} ${btnIdle}`}
        >
          <Icon name='project-layout-icon' width={16} height={16} />
        </button>
      </Tooltip>

      {/* ③ 网格吸附 toggle */}
      <Tooltip
        title={t('canvas.toolbar.snapToGrid', {
          defaultValue: '网格吸附(拖拽自动对齐 16px)',
        })}
        placement='top'
      >
        <button
          type='button'
          aria-pressed={snapEnabled}
          aria-label={t('canvas.toolbar.snap', { defaultValue: '网格吸附' })}
          onClick={onToggleSnap}
          className={`${btnBase} ${snapEnabled ? btnActive : btnIdle}`}
        >
          <MagnetIcon />
        </button>
      </Tooltip>

      <div className='mx-1 h-5 w-px bg-border-default-secondary' />

      {/* ④ 缩放 trio: − / NN% / + */}
      <Tooltip title={t('canvas.toolbar.zoomOut', { defaultValue: '缩小' })} placement='top'>
        <button
          type='button'
          aria-label={t('canvas.toolbar.zoomOut', { defaultValue: '缩小' })}
          disabled={atMinZoom}
          onClick={() => zoomOut({ duration: 150 })}
          className={`${btnBase} ${atMinZoom ? btnDisabled : btnIdle}`}
        >
          <Icon name='base-zoom-out-icon' width={14} height={14} />
        </button>
      </Tooltip>
      <span className='text-[12px] font-mono text-text-default-secondary min-w-[44px] text-center px-0.5'>
        {Math.round(zoom * 100)}%
      </span>
      <Tooltip title={t('canvas.toolbar.zoomIn', { defaultValue: '放大' })} placement='top'>
        <button
          type='button'
          aria-label={t('canvas.toolbar.zoomIn', { defaultValue: '放大' })}
          disabled={atMaxZoom}
          onClick={() => zoomIn({ duration: 150 })}
          className={`${btnBase} ${atMaxZoom ? btnDisabled : btnIdle}`}
        >
          <Icon name='base-zoom-in-icon' width={14} height={14} />
        </button>
      </Tooltip>
    </div>
  );
};

export default memo(ViewportToolbar);
