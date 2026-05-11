import React, { useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import type { Node } from '@xyflow/react';

import { useCanvasActions } from '@/spaces/canvas/hooks/useCanvasActions';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import { getProjectCanvasViewportApi } from '@/spaces/canvas/types';
import { useUploadFiles, NODE_TYPE_BY_KIND } from '@/features/upload';
import { message as uiMessage } from '@/ui/message';

/** True when paste should stay inside text-editor/contenteditable context. */
const isEditablePasteContext = (e: ClipboardEvent): boolean => {
  const target = e.target;
  if (target instanceof HTMLElement) {
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
    if (target.closest('.ProseMirror, .breatic-editor-wrapper')) return true;
  }

  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) return true;
    if (active.closest('.ProseMirror, .breatic-editor-wrapper')) return true;
  }

  const sel = window.getSelection();
  const anchorEl =
    sel?.anchorNode instanceof Element
      ? sel.anchorNode
      : sel?.anchorNode instanceof Node
        ? sel.anchorNode.parentElement
        : null;
  if (anchorEl?.closest('.ProseMirror, .breatic-editor-wrapper')) return true;

  return false;
};

/** Filename builder for clipboard blobs — blobs lack `name`, so synthesise one. */
const blobFilename = (kind: 'image' | 'video' | 'audio', blob: Blob): string => {
  const extByKind = { image: 'png', video: 'mp4', audio: 'mp3' } as const;
  const fromMime = blob.type.split('/')[1]?.split(';')[0];
  const ext = fromMime || extByKind[kind];
  return `clipboard-${kind}-${Date.now()}.${ext}`;
};

/**
 * Picks the first media item from clipboard, preferring file types over text.
 * Returns `null` when there's nothing the canvas can host.
 */
function pickClipboardPayload(
  data: DataTransfer,
):
  | { kind: 'image' | 'video' | 'audio'; blob: Blob }
  | { kind: 'text'; text: string }
  | null {
  const items = data.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mime = item.type.toLowerCase();
    if (mime.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) return { kind: 'image', blob };
    } else if (mime.startsWith('video/')) {
      const blob = item.getAsFile();
      if (blob) return { kind: 'video', blob };
    } else if (mime.startsWith('audio/')) {
      const blob = item.getAsFile();
      if (blob) return { kind: 'audio', blob };
    }
  }
  const text = data.getData('text');
  if (text) return { kind: 'text', text };
  return null;
}

/**
 * Listens for global paste and drops the result onto the canvas:
 *   - image / video / audio blob → upload to permanent storage,
 *     then `createDataNode` with the returned URL on `data.content`.
 *   - plain text → empty text node at viewport center (F-series TODO:
 *     wire the pasted text into the node's Yjs `prompt` Y.XmlFragment
 *     once the canvas-native text editor lands).
 *
 * Paste inside an existing input / contenteditable / ProseMirror surface
 * is ignored — those host their own paste behavior.
 */
const ClipboardPasteHandler: React.FC = () => {
  const { addNode, createDataNode } = useCanvasActions();
  const activeMgr = useActiveCanvasSpace();
  const { upload } = useUploadFiles();
  // Refs let the window-listener effect keep a `[]` dep array — the
  // listener reads the latest manager / upload / node-action identities
  // without re-binding the global event handler every render.
  const activeMgrRef = useRef(activeMgr);
  activeMgrRef.current = activeMgr;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const addNodeRef = useRef(addNode);
  addNodeRef.current = addNode;
  const createDataNodeRef = useRef(createDataNode);
  createDataNodeRef.current = createDataNode;

  useEffect(() => {
    const handlePaste = async (rawEvent: Event) => {
      const e = rawEvent as ClipboardEvent;
      if (isEditablePasteContext(e)) return;
      if (!e.clipboardData) return;

      const payload = pickClipboardPayload(e.clipboardData);
      if (!payload) return;

      e.preventDefault();
      e.stopPropagation();

      const center = getProjectCanvasViewportApi()?.getViewportCenterFlow();
      if (!center) {
        uiMessage.warning('画布未就绪,无法粘贴');
        return;
      }
      const position = { x: center.x, y: center.y };

      if (payload.kind === 'text') {
        // Text path stays on the v12 addNode shape — the canvas-native
        // text node holds its content in a Yjs `prompt` Y.XmlFragment
        // that's wired through TipTap, not through `data.content`. F5-
        // followup is scoped to upload-driven media; text-paste content
        // wiring is its own TODO.
        const nodeId = `1001-${Date.now()}-${nanoid(5)}`;
        // addNode stamps audit fields (`createdAt` / `createdBy`) inside
        // its Yjs transact, so the call-site data only needs `name` /
        // `state` / `attachments`. Cast through `unknown` since react-
        // flow's `Node['data']` is `unknown` by design.
        const textNode: Node = {
          id: nodeId,
          type: '1001',
          position,
          selected: true,
          style: { width: 300 },
          data: { name: 'text', state: 'idle', attachments: [] } as unknown as Node['data'],
        };
        addNodeRef.current(textNode);
        return;
      }

      // Media path: upload to permanent storage first so the URL the
      // node persists to Yjs is durable, not a blob: URL that dies with
      // the tab. Mirrors the LeftFloatingMenu upload flow exactly.
      const mgr = activeMgrRef.current;
      if (!mgr) {
        uiMessage.warning('画布未就绪,无法粘贴');
        return;
      }
      try {
        const file = new File(
          [payload.blob],
          blobFilename(payload.kind, payload.blob),
          { type: payload.blob.type || `${payload.kind}/*` },
        );
        const [result] = await uploadRef.current([file], { projectId: mgr.projectId });
        const nodeType = NODE_TYPE_BY_KIND[result.kind];
        if (!nodeType) {
          uiMessage.warning(`暂不支持的剪贴板文件类型: ${result.kind}`);
          return;
        }
        createDataNodeRef.current({
          type: nodeType,
          position,
          data: {
            name: result.file.name,
            content: result.fileUrl,
            ...(result.width !== undefined ? { width: result.width } : {}),
            ...(result.height !== undefined ? { height: result.height } : {}),
            ...(result.duration !== undefined ? { duration: result.duration } : {}),
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClipboardPasteHandler] upload failed', err);
        uiMessage.error('粘贴上传失败,请重试');
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, []);

  return null;
};

export default ClipboardPasteHandler;
