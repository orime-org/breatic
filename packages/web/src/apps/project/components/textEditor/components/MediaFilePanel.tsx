import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { cn } from '@/utils/classnames';

export const MEDIA_FILE_PANEL_EVENT = 'breatic:open-media-file-panel';

type MediaType = 'video' | 'audio' | 'file';

export type MediaFilePanelOpenDetail = {
  editor: Editor;
  pos: number;
  mediaType: MediaType;
};

export function openMediaFilePanel(editor: Editor, pos: number, mediaType: MediaType): void {
  window.dispatchEvent(
    new CustomEvent<MediaFilePanelOpenDetail>(MEDIA_FILE_PANEL_EVENT, {
      detail: { editor, pos, mediaType },
    }),
  );
}

const PANEL_OFFSET_Y = 10;
const DEFAULT_MEDIA_WIDTH = 250;

function computePanelStyle(referenceEl: HTMLElement, host: HTMLElement): { top: number; left: number } {
  const r = referenceEl.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return {
    top: r.bottom - h.top + PANEL_OFFSET_Y,
    left: r.left - h.left,
  };
}

function getVideoAspectRatio(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.videoWidth) || !Number.isFinite(video.videoHeight) || video.videoHeight <= 0) {
        resolve(null);
      } else {
        resolve(video.videoWidth / video.videoHeight);
      }
      video.src = '';
    };
    video.onerror = () => {
      resolve(null);
      video.src = '';
    };
    video.src = src;
  });
}

const getLabel = (mediaType: MediaType) => {
  if (mediaType === 'video') {
    return {
      uploadPlaceholder: 'Upload video',
      embedPlaceholder: 'Enter video URL',
      embedButton: 'Embed video',
      uploadError: 'Error: Video upload failed',
      accept: 'video/*',
      pendingType: 'pendingVideo',
      outputType: 'video',
      isAccepted: (file: File) => file.type.startsWith('video/'),
    } as const;
  }
  if (mediaType === 'file') {
    return {
      uploadPlaceholder: 'Upload file',
      embedPlaceholder: 'Enter file URL',
      embedButton: 'Embed file',
      uploadError: 'Error: File upload failed',
      accept: '*/*',
      pendingType: 'pendingFile',
      outputType: 'image',
      isAccepted: (_file: File) => true,
    } as const;
  }
  return {
    uploadPlaceholder: 'Upload audio',
    embedPlaceholder: 'Enter audio URL',
    embedButton: 'Embed audio',
    uploadError: 'Error: Audio upload failed',
    accept: 'audio/*',
    pendingType: 'pendingAudio',
    outputType: 'audio',
    isAccepted: (file: File) => file.type.startsWith('audio/'),
  } as const;
};

type InnerProps = {
  editor: Editor;
  pos: number;
  mediaType: MediaType;
  onClose: () => void;
};

function replacePendingWithMedia(
  editor: Editor,
  pos: number,
  mediaType: MediaType,
  src: string,
  title?: string,
  extraAttrs?: Record<string, unknown>,
): boolean {
  const cfg = getLabel(mediaType);
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== cfg.pendingType) return false;
  const end = pos + node.nodeSize;
  const attrs =
    mediaType === 'file'
      ? { src, title: title ?? null, alt: title ?? null, showPreview: false }
      : { src, title: title ?? null, ...(extraAttrs ?? {}) };
  return editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: end })
    .insertContentAt(pos, {
      type: cfg.outputType,
      attrs,
    })
    .setNodeSelection(pos)
    .run();
}

const MediaFilePanelFloating = ({ editor, pos, mediaType, onClose }: InnerProps) => {
  const [openTab, setOpenTab] = useState<'upload' | 'embed'>('upload');
  const [embedUrl, setEmbedUrl] = useState('');
  const [uploadFailed, setUploadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const cfg = getLabel(mediaType);

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
    if (!node || node.type.name !== cfg.pendingType) {
      onClose();
      return;
    }
    const onSel = () => {
      const n = editor.state.doc.nodeAt(pos);
      if (!n || n.type.name !== cfg.pendingType) {
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
  }, [cfg.pendingType, editor, onClose, pos]);

  useEffect(() => {
    if (!uploadFailed) return;
    const t = window.setTimeout(() => setUploadFailed(false), 3000);
    return () => window.clearTimeout(t);
  }, [uploadFailed]);

  const finishWithSrc = (src: string, title?: string, extraAttrs?: Record<string, unknown>) => {
    if (replacePendingWithMedia(editor, pos, mediaType, src, title, extraAttrs)) onClose();
  };

  const onFile = (file: File | null) => {
    if (!file || !cfg.isAccepted(file)) return;
    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const r = ev.target?.result;
      if (typeof r === 'string') {
        if (mediaType === 'video') {
          const aspectRatio = await getVideoAspectRatio(r);
          setLoading(false);
          finishWithSrc(r, file.name, {
            width: DEFAULT_MEDIA_WIDTH,
            ...(aspectRatio && Number.isFinite(aspectRatio) ? { aspectRatio } : {}),
          });
          return;
        }
        setLoading(false);
        finishWithSrc(r, file.name);
        return;
      }
      setLoading(false);
      setUploadFailed(true);
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
        zIndex: 85,
      }}
      role='dialog'
      aria-label={cfg.uploadPlaceholder}
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
          Upload
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
          Embed
        </button>
      </div>

      {openTab === 'upload' ? (
        <div className='bn-tab-panel flex w-full max-w-full flex-col items-center gap-2 p-2'>
          <label className='bn-file-input w-full cursor-pointer'>
            <span className='flex w-full justify-center rounded border border-dashed border-neutral-300 bg-neutral-100 px-3 py-8 text-center text-[13px] text-neutral-500'>
              {cfg.uploadPlaceholder}
            </span>
            <input
              type='file'
              accept={cfg.accept}
              className='sr-only'
              onChange={(e) => {
                onFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </label>
          {uploadFailed && <div className='bn-error-text text-[12px] text-red-600'>{cfg.uploadError}</div>}
        </div>
      ) : (
        <div className='bn-tab-panel flex w-full max-w-full flex-col items-center gap-2 p-2'>
          <input
            type='url'
            className='bn-text-input w-full rounded border border-neutral-300 bg-white px-3 py-2 text-[13px] outline-none'
            placeholder={cfg.embedPlaceholder}
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
            {cfg.embedButton}
          </button>
        </div>
      )}
    </div>,
    hostEl,
  );
};

const MediaFilePanel = () => {
  const [ctx, setCtx] = useState<MediaFilePanelOpenDetail | null>(null);
  const close = useCallback(() => setCtx(null), []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const ce = e as CustomEvent<MediaFilePanelOpenDetail>;
      const d = ce.detail;
      if (!d?.editor || typeof d.pos !== 'number') return;
      setCtx(d);
    };
    window.addEventListener(MEDIA_FILE_PANEL_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(MEDIA_FILE_PANEL_EVENT, onOpen as EventListener);
  }, []);

  if (!ctx) return null;
  return (
    <MediaFilePanelFloating
      key={`${ctx.mediaType}-${ctx.pos}`}
      editor={ctx.editor}
      pos={ctx.pos}
      mediaType={ctx.mediaType}
      onClose={close}
    />
  );
};

export default MediaFilePanel;
