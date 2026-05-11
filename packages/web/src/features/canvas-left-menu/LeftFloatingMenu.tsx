/**
 * LeftFloatingMenu — the vertical icon strip on the left edge of the
 * canvas editing area (spec/02 §4.3 v13).
 *
 * Six items in two groups. Top group is the active creator surface:
 *   ① 节点库 — toggles {@link NodesLibraryPanel} (creates generative nodes)
 *   ② 上传   — opens the system file picker (F5)
 *   ③ 批注   — drops an AnnotationNode composer at viewport center (F6)
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
import { useCallback, useRef, useState } from 'react';
import { Icon } from '@/ui/icon';
import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { getProjectCanvasViewportApi } from '@/spaces/canvas/types';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { message } from '@/ui/message';
import { useUploadFiles, NODE_TYPE_BY_KIND } from '@/features/upload';
import { useAnnotationActions } from '@/features/annotation';
import {
  NodesLibraryPanel,
  type GenerativeOutputType,
} from './NodesLibraryPanel';

type ActivePanel = 'nodes' | null;

/**
 * LeftFloatingMenu currently takes no props — every action wires
 * itself directly through hooks (file picker via `useUploadFiles`,
 * annotate via `useAnnotationActions`). Previous prop-drilling stubs
 * (`onAnnotateClick`) were dropped in F6 to avoid dead code paths.
 */

/**
 * MIME-pattern accept string for the hidden file input behind the
 * upload button. Mirrors the kinds the server's `presign` route can
 * classify into a viable asset node type — image / video / audio.
 * Documents and arbitrary `file/*` are filtered at the dialog level
 * so the user can't pick something we'd reject after upload.
 */
const UPLOAD_ACCEPT = 'image/*,video/*,audio/*';

/**
 * Per-batch fan-out offset so multiple files dropped together don't
 * stack on top of each other at viewport center. 64 px diagonal gives
 * the user an obvious cascade without pushing later files off-screen.
 */
const BATCH_OFFSET_STEP = 64;

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

export function LeftFloatingMenu() {
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const { createGenerativeNode, createDataNode } = useCanvasActions();
  const activeMgr = useActiveCanvasSpace();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useUploadFiles();
  const { dropAnnotation, pendingAnnotation } = useAnnotationActions();

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
      const center = getProjectCanvasViewportApi()?.getViewportCenterFlow();
      if (!center) return;
      createGenerativeNode({
        outputType,
        kind: DEFAULT_KIND[outputType],
        position: { x: center.x, y: center.y },
      });
    },
    [createGenerativeNode],
  );

  /**
   * Run uploads through the canonical hook, then drop one
   * `createDataNode` per result at viewport center (cascaded by
   * `BATCH_OFFSET_STEP` so a 5-file drop doesn't stack invisibly).
   * Server-classified `kind` decides the node type — anything the
   * frontend can't host (document / file) skips with a per-file
   * warning, so a mixed batch still lands the supported items.
   */
  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      if (!activeMgr) return;
      if (files.length === 0) return;
      try {
        const results = await upload(files, { projectId: activeMgr.projectId });
        const center = getProjectCanvasViewportApi()?.getViewportCenterFlow();
        if (!center) {
          message.warning('画布未就绪,无法放置节点');
          return;
        }
        results.forEach((r, idx) => {
          const nodeType = NODE_TYPE_BY_KIND[r.kind];
          if (!nodeType) {
            message.warning(`暂不支持的文件类型: ${r.file.name}`);
            return;
          }
          createDataNode({
            type: nodeType,
            position: {
              x: center.x + idx * BATCH_OFFSET_STEP,
              y: center.y + idx * BATCH_OFFSET_STEP,
            },
            data: {
              name: r.file.name,
              content: r.fileUrl,
              ...(r.width !== undefined ? { width: r.width } : {}),
              ...(r.height !== undefined ? { height: r.height } : {}),
              ...(r.duration !== undefined ? { duration: r.duration } : {}),
            },
          });
        });
      } catch (err) {
        console.error('[LeftFloatingMenu] upload failed', err);
        message.error('上传失败,请重试');
      }
    },
    [activeMgr, upload, createDataNode],
  );

  const handleUploadInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      e.target.value = '';
      if (!list) return;
      handleUploadFiles(Array.from(list));
    },
    [handleUploadFiles],
  );

  const handleTopClick = useCallback(
    (item: (typeof TOP_ITEMS)[number]) => {
      if ('panel' in item && item.panel) {
        setActivePanel((cur) => (cur === item.key ? null : (item.key as ActivePanel)));
        return;
      }
      if ('action' in item) {
        if (item.action === 'upload') {
          if (uploading) return;
          uploadInputRef.current?.click();
          return;
        }
        if (item.action === 'annotate') {
          // The hook itself enforces the lock (returns null when one
          // is already pending); the disabled state on the button is
          // visual only.
          dropAnnotation();
          return;
        }
      }
    },
    [uploading, dropAnnotation],
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
      <input
        ref={uploadInputRef}
        type='file'
        multiple
        accept={UPLOAD_ACCEPT}
        className='hidden'
        onChange={handleUploadInputChange}
      />
      <div className='absolute top-1/2 -translate-y-1/2 left-3 w-[52px] bg-background-default-base border border-border-default-secondary rounded-lg shadow-md flex flex-col items-center py-1.5 gap-0.5 z-30 pointer-events-auto'>
        {TOP_ITEMS.map((it) => {
          const isActive = 'panel' in it && it.panel && activePanel === it.key;
          // Per-item disabled gate. Today: the upload button locks
          // while a previous batch is still in flight; the annotate
          // button locks while a composer is open. Both are
          // additionally enforced inside the click handler / hook —
          // this is just the visual mirror.
          const isDisabled =
            ('action' in it && it.action === 'upload' && uploading) ||
            ('action' in it && it.action === 'annotate' && pendingAnnotation !== null);
          return (
            <button
              key={it.key}
              type='button'
              disabled={isDisabled}
              onClick={() => handleTopClick(it)}
              data-panel-trigger={'panel' in it && it.panel ? it.key : undefined}
              title={it.label}
              className={
                btnBase +
                ' ' +
                (isDisabled
                  ? 'cursor-not-allowed opacity-50 text-text-default-tertiary'
                  : isActive
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
