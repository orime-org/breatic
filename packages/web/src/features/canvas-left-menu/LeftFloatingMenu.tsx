/**
 * LeftFloatingMenu — the vertical icon strip on the left edge of the
 * canvas editing area (spec/02 §4.3 v13).
 *
 * Six items in two groups. Top group is the active creator surface:
 *   ① 节点库 — toggles {@link NodesLibraryPanel} (creates generative nodes)
 *   ② 上传   — opens the system file picker (F5; this PR stubs to a toast)
 *   ③ 批注   — drops an AnnotationNode at the viewport center (F6; stub)
 *
 * Bottom group is placeholder / "coming soon":
 *   ④ Studio 资产 — V2
 *   ⑤ 帮助       — V2
 *   ⑥ 反馈/客服  — V2
 *
 * View users (read-only project members) don't see this menu at all
 * (spec §4.3 — left menu hidden because there's no creation power).
 * The visibility gate is the parent's responsibility; this component
 * always renders when mounted.
 */
import { useCallback, useState } from 'react';
import { Icon } from '@/ui/icon';
import { useReactFlow } from '@xyflow/react';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { flowCenterFromCanvasPane } from '@/spaces/canvas/types';
import {
  NodesLibraryPanel,
  type GenerativeOutputType,
} from './NodesLibraryPanel';

type ActivePanel = 'nodes' | null;

interface LeftFloatingMenuProps {
  /**
   * Click stub for the upload menu item (F5 wires the real flow).
   * Defaults to a console message + transparent no-op when omitted.
   */
  onUploadClick?: () => void;
  /**
   * Click stub for the annotate menu item (F6 wires the real flow).
   * Defaults to a console message + transparent no-op when omitted.
   */
  onAnnotateClick?: () => void;
}

/**
 * Per-{@link GenerativeOutputType} default `kind` matching the
 * GenerativeNode pill bar's first option. Set on creation so the
 * pill bar's `kind` dropdown lights up on a real value rather than
 * the empty-string fallback.
 */
const DEFAULT_KIND: Record<GenerativeOutputType, string> = {
  text: 'text',
  image: '文生图',
  video: 'video',
  audio: 'music',
};

const TOP_ITEMS = [
  { key: 'nodes' as const, icon: 'base-grid' as const, label: '节点库 — 4 类生成节点', panel: true },
  { key: 'upload' as const, icon: 'base-upload' as const, label: '上传素材(多文件混合)', action: 'upload' as const },
  { key: 'annotate' as const, icon: 'base-add-comment' as const, label: '在画布加批注', action: 'annotate' as const },
] as const;

const BOTTOM_ITEMS = [
  { key: 'studio', icon: 'base-folder' as const, label: 'Studio 资产(敬请期待)' },
  { key: 'help', icon: 'base-question-circle' as const, label: '帮助(敬请期待)' },
  { key: 'feedback', icon: 'base-message' as const, label: '反馈 / 客服(敬请期待)' },
] as const;

export function LeftFloatingMenu({
  onUploadClick,
  onAnnotateClick,
}: LeftFloatingMenuProps) {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const { screenToFlowPosition } = useReactFlow();
  const { createGenerativeNode } = useCanvasActions();

  /**
   * Atomic three-body create at the viewport center (spec §10.13.7
   * v13 — "新节点位置以当前 viewport 中心为锚点 (`screenToFlowPosition`),
   * 保证用户操作即可见").
   */
  const handleCreateGenerative = useCallback(
    (outputType: GenerativeOutputType) => {
      // Use the real visible canvas pane center when we can read it
      // (avoids landing the node off-screen when chat / right editor
      // panels eat half the viewport).
      const center = flowCenterFromCanvasPane(
        screenToFlowPosition,
        { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      );
      createGenerativeNode({
        outputType,
        kind: DEFAULT_KIND[outputType],
        position: { x: center.x, y: center.y },
      });
    },
    [screenToFlowPosition, createGenerativeNode],
  );

  const handleTopClick = useCallback(
    (item: (typeof TOP_ITEMS)[number]) => {
      if ('panel' in item && item.panel) {
        setActivePanel((cur) => (cur === item.key ? null : (item.key as ActivePanel)));
        return;
      }
      if ('action' in item) {
        if (item.action === 'upload') {
          if (onUploadClick) {
            onUploadClick();
          } else {
            // F5 will wire the real flow; until then a console hint
            // tells dev which task picks this up. No toast — no
            // user-visible affordance for a not-yet-built feature.
            console.info('[LeftFloatingMenu] upload click — F5 not yet wired');
          }
          return;
        }
        if (item.action === 'annotate') {
          if (onAnnotateClick) {
            onAnnotateClick();
          } else {
            console.info('[LeftFloatingMenu] annotate click — F6 not yet wired');
          }
          return;
        }
      }
    },
    [onUploadClick, onAnnotateClick],
  );

  const handlePlaceholderClick = useCallback((label: string) => {
    // Placeholder items: surface the "coming soon" state directly in
    // a tooltip on the icon (set via title=). No toast spam on click.
    console.info(`[LeftFloatingMenu] ${label} — placeholder, not yet implemented`);
  }, []);

  const btnBase =
    'w-10 h-10 inline-flex items-center justify-center rounded-lg transition-colors flex-shrink-0';

  return (
    <>
      <div className='absolute top-1/2 -translate-y-1/2 left-3 w-[52px] bg-background-default-base border border-border-default-secondary rounded-lg shadow-md flex flex-col items-center py-1.5 gap-0.5 z-30 pointer-events-auto'>
        {TOP_ITEMS.map((it) => {
          const isActive = 'panel' in it && it.panel && activePanel === it.key;
          return (
            <button
              key={it.key}
              type='button'
              onClick={() => handleTopClick(it)}
              data-panel-trigger={'panel' in it && it.panel ? it.key : undefined}
              title={it.label}
              className={
                btnBase +
                ' ' +
                (isActive
                  ? 'bg-brand-500 text-white hover:bg-brand-600 shadow-sm'
                  : 'text-text-default-secondary hover:bg-background-default-secondary hover:text-text-default-primary')
              }
            >
              <Icon name={it.icon} width={18} height={18} />
            </button>
          );
        })}

        <div className='w-7 h-px bg-border-default-secondary my-1.5' />

        {BOTTOM_ITEMS.map((it) => (
          <button
            key={it.key}
            type='button'
            onClick={() => handlePlaceholderClick(it.label)}
            title={it.label}
            className={
              btnBase +
              ' text-text-default-tertiary hover:bg-background-default-secondary hover:text-text-default-secondary'
            }
          >
            <Icon name={it.icon} width={18} height={18} />
          </button>
        ))}
      </div>

      {activePanel === 'nodes' && (
        <NodesLibraryPanel
          onClose={() => setActivePanel(null)}
          onCreateGenerative={handleCreateGenerative}
        />
      )}
    </>
  );
}
