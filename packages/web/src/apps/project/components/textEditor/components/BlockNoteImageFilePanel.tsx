import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { cn } from '@/utils/classnames';

export const BN_IMAGE_FILE_PANEL_EVENT = 'breatic:open-bn-image-file-panel';

export type BnImageFilePanelDetail = {
  editor: Editor;
  /** Document position directly before the `pendingImage` node (NodeSelection.from). */
  pos: number;
};

export function openBlockNoteStyleImagePanel(editor: Editor, pos: number): void {
  window.dispatchEvent(
    new CustomEvent<BnImageFilePanelDetail>(BN_IMAGE_FILE_PANEL_EVENT, {
      detail: { editor, pos },
    }),
  );
}

const DICT = {
  uploadTab: 'Upload',
  embedTab: 'Embed',
  uploadPlaceholder: 'Upload image',
  embedPlaceholder: 'Enter URL',
  embedButton: 'Embed image',
  uploadError: 'Error: Upload failed',
} as const;

const PANEL_OFFSET_Y = 10;

function filenameFromURL(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || 'image';
    return decodeURIComponent(seg);
  } catch {
    return 'image';
  }
}

function getPendingAt(editor: Editor, pos: number) {
  return editor.state.doc.nodeAt(pos);
}

function replacePendingWithImage(editor: Editor, pos: number, src: string, alt?: string): boolean {
  const node = getPendingAt(editor, pos);
  if (!node || node.type.name !== 'pendingImage') return false;
  const end = pos + node.nodeSize;
  return editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: end })
    .insertContentAt(pos, {
      type: 'image',
      attrs: { src, alt: alt ?? null, title: null },
    })
    .setNodeSelection(pos)
    .run();
}

type InnerProps = {
  editor: Editor;
  pos: number;
  onClose: () => void;
};

function computePanelStyle(referenceEl: HTMLElement, host: HTMLElement): { top: number; left: number } {
  const r = referenceEl.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return {
    top: r.bottom - h.top + PANEL_OFFSET_Y,
    left: r.left - h.left,
  };
}

/** Anchored under `pendingImage` inside `.breatic-editor-body` so it scrolls with editor content (no viewport-fixed portal). */
const BnImageFilePanelFloating = ({ editor, pos, onClose }: InnerProps) => {
  const [openTab, setOpenTab] = useState<'upload' | 'embed'>('upload');
  const [embedUrl, setEmbedUrl] = useState('');
  const [uploadFailed, setUploadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const referenceEl = editor.view.nodeDOM(pos) as HTMLElement | null;
  const hostEl = referenceEl?.closest('.breatic-editor-body') as HTMLElement | null;

  const syncPosition = useCallback(() => {
    if (!referenceEl || !hostEl) return;
    setPanelPos(computePanelStyle(referenceEl, hostEl));
  }, [referenceEl, hostEl]);

  useLayoutEffect(() => {
    syncPosition();
  }, [syncPosition]);

  useEffect(() => {
    if (!hostEl) return;
    const scrollRoot = hostEl.closest('.breatic-editor-wrapper');
    scrollRoot?.addEventListener('scroll', syncPosition, { passive: true });
    window.addEventListener('resize', syncPosition);
    return () => {
      scrollRoot?.removeEventListener('scroll', syncPosition);
      window.removeEventListener('resize', syncPosition);
    };
  }, [hostEl, syncPosition]);

  useEffect(() => {
    const stop = () => {
      onClose();
      queueMicrotask(() => editor.commands.focus());
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
    };

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || referenceEl?.contains(t)) return;
      stop();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [editor, onClose, referenceEl]);

  useEffect(() => {
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'pendingImage') {
      onClose();
      return;
    }
    const onSel = () => {
      const n = editor.state.doc.nodeAt(pos);
      if (!n || n.type.name !== 'pendingImage') {
        onClose();
        return;
      }
      const sel = editor.state.selection;
      if (sel instanceof NodeSelection && sel.from === pos) return;
      onClose();
    };
    editor.on('selectionUpdate', onSel);
    editor.on('update', onSel);
    return () => {
      editor.off('selectionUpdate', onSel);
      editor.off('update', onSel);
    };
  }, [editor, pos, onClose]);

  useEffect(() => {
    if (!uploadFailed) return;
    const t = window.setTimeout(() => setUploadFailed(false), 3000);
    return () => window.clearTimeout(t);
  }, [uploadFailed]);

  const finishWithSrc = (src: string) => {
    const alt = filenameFromURL(src);
    if (replacePendingWithImage(editor, pos, src, alt)) onClose();
  };

  const onFile = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    setLoading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setLoading(false);
      const r = ev.target?.result;
      if (typeof r === 'string') finishWithSrc(r);
      else setUploadFailed(true);
    };
    reader.onerror = () => {
      setLoading(false);
      setUploadFailed(true);
    };
    reader.readAsDataURL(file);
  };

  const onEmbed = () => {
    const t = embedUrl.trim();
    if (t) finishWithSrc(t);
  };

  if (!referenceEl || !hostEl) return null;

  return createPortal(
    <div
      ref={panelRef}
      className='bn-panel bn-mantine-panel pointer-events-auto min-w-[260px] max-w-[min(100%,400px)] rounded-md border border-neutral-200 bg-background-default-base shadow-lg'
      style={{
        position: 'absolute',
        top: panelPos.top,
        left: panelPos.left,
        zIndex: 10020,
      }}
      role='dialog'
      aria-label={DICT.uploadPlaceholder}
    >
      {loading && (
        <div className='pointer-events-none absolute inset-0 z-[1] flex items-center justify-center rounded-md bg-background-default-base/60' />
      )}

      <div className='flex border-b border-neutral-200'>
        <button
          type='button'
          className={cn(
            'flex-1 px-3 py-2 text-[13px] font-medium transition-colors',
            openTab === 'upload' ? 'border-b-2 border-blue-500 text-neutral-800' : 'text-neutral-500',
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenTab('upload')}
        >
          {DICT.uploadTab}
        </button>
        <button
          type='button'
          className={cn(
            'flex-1 px-3 py-2 text-[13px] font-medium transition-colors',
            openTab === 'embed' ? 'border-b-2 border-blue-500 text-neutral-800' : 'text-neutral-500',
          )}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenTab('embed')}
        >
          {DICT.embedTab}
        </button>
      </div>

      {openTab === 'upload' ? (
        <div className='bn-tab-panel flex w-full max-w-full flex-col items-center gap-2 p-2'>
          <label className='bn-file-input w-full cursor-pointer'>
            <span className='flex w-full justify-center rounded border border-dashed border-neutral-300 bg-neutral-100 px-3 py-8 text-center text-[13px] text-neutral-500'>
              {DICT.uploadPlaceholder}
            </span>
            <input
              type='file'
              accept='image/*'
              className='sr-only'
              onChange={(e) => {
                onFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </label>
          {uploadFailed && <div className='bn-error-text text-[12px] text-red-600'>{DICT.uploadError}</div>}
        </div>
      ) : (
        <div className='bn-tab-panel flex w-full max-w-full flex-col items-center gap-2 p-2'>
          <input
            type='url'
            className='bn-text-input w-full rounded border border-neutral-300 bg-white px-3 py-2 text-[13px] outline-none'
            placeholder={DICT.embedPlaceholder}
            value={embedUrl}
            onChange={(e) => setEmbedUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onEmbed();
              }
            }}
          />
          <button
            type='button'
            className='bn-button h-8 w-[60%] min-w-[120px] rounded border border-neutral-300 bg-white text-[13px] hover:bg-neutral-50'
            onMouseDown={(e) => e.preventDefault()}
            onClick={onEmbed}
          >
            {DICT.embedButton}
          </button>
        </div>
      )}
    </div>,
    hostEl,
  );
};

const BlockNoteImageFilePanel = () => {
  const [ctx, setCtx] = useState<BnImageFilePanelDetail | null>(null);

  const close = useCallback(() => setCtx(null), []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<BnImageFilePanelDetail>;
      const d = ce.detail;
      if (!d?.editor || typeof d.pos !== 'number') return;
      setCtx(d);
    };
    window.addEventListener(BN_IMAGE_FILE_PANEL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(BN_IMAGE_FILE_PANEL_EVENT, onOpen as EventListener);
  }, []);

  if (!ctx) return null;

  return <BnImageFilePanelFloating key={ctx.pos} editor={ctx.editor} pos={ctx.pos} onClose={close} />;
};

export default BlockNoteImageFilePanel;
