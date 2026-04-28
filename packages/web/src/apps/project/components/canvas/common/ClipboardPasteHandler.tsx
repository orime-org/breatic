import React, { useEffect } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasActions } from '@/hooks/useCanvasActions';
import { nanoid } from 'nanoid';
import type { CanvasWorkflowNodeData } from '@/apps/project/components/canvas/types';

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

/** Builds a text node for pasted plain text.
 * TODO PR-6+: `textContent` is currently unused in the new schema because
 * text lives in the Yjs `prompt` Y.XmlFragment. After paste, the caller should
 * open the node editor and insert text into the TipTap document.
 */
const createTextNode = (
  _textContent: string,
  position: { x: number; y: number },
  nodeId: string
): Node => {
  return {
    id: nodeId,
    type: '1001',
    position,
    selected: true,
    style: { width: 300 },
    // addNode() in useCanvasActions only reads `name`; history/attachments/prompt
    // are initialised as empty Yjs structures. UI-only `handles` config is kept here.
    data: {
      name: 'text',
      history: [],
      attachments: [],
      prompt: null,
      handles: {
        target: [{ handleType: 'Text', number: 1 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
};

/** Builds an image node for upload. */
const createImageNodeForUpload = (
  position: { x: number; y: number },
  nodeId: string,
  _file?: File
): Node => {
  return {
    id: nodeId,
    type: '1002',
    position,
    selected: true,
    data: {
      name: 'image',
      history: [],
      attachments: [],
      prompt: null,
      handles: {
        target: [{ handleType: 'Image', number: 1 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
};

/** Builds a video node for upload. */
const createVideoNodeForUpload = (
  position: { x: number; y: number },
  nodeId: string,
  _file?: File
): Node => {
  return {
    id: nodeId,
    type: '1003',
    position,
    selected: true,
    data: {
      name: 'video',
      history: [],
      attachments: [],
      prompt: null,
      handles: {
        target: [{ handleType: 'Video', number: 1 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
};

/** Builds an audio node for upload. */
const createAudioNodeForUpload = (
  position: { x: number; y: number },
  nodeId: string,
  _file?: File
): Node => {
  return {
    id: nodeId,
    type: '1004',
    position,
    selected: true,
    data: {
      name: 'audio',
      history: [],
      attachments: [],
      prompt: null,
      handles: {
        target: [{ handleType: 'Audio', number: 1 }],
      },
    } satisfies CanvasWorkflowNodeData,
  };
};

/** Creates a text node from clipboard text at the given flow position. */
const handleTextPaste = (
  text: string,
  position: { x: number; y: number },
  nodeId: string,
  addNode: (node: Node) => void,
  zIndex?: number
) => {
  const newNode = createTextNode(text, position, nodeId);
  const nodeWithZ = zIndex !== undefined ? ({ ...newNode, zIndex } as Node & { zIndex?: number }) : newNode;
  addNode(nodeWithZ);
};

/** Wraps a Blob as a File with filename and MIME type. */
const blobToFile = (blob: Blob, fileName: string, mimeType: string): File =>
  new File([blob], fileName, { type: mimeType });

/** Adds an image node from a clipboard image blob. */
const handleImageFileUpload = (
  blob: Blob,
  position: { x: number; y: number },
  nodeId: string,
  addNode: (node: Node) => void,
  zIndex?: number
) => {
  const file = blobToFile(blob, 'image.png', blob.type || 'image/png');
  const newNode = createImageNodeForUpload(position, nodeId, file);
  const nodeWithZ = zIndex !== undefined ? ({ ...newNode, zIndex } as Node & { zIndex?: number }) : newNode;
  addNode(nodeWithZ);
};

/** Adds a video node from a clipboard video blob. */
const handleVideoFileUpload = (
  blob: Blob,
  position: { x: number; y: number },
  nodeId: string,
  addNode: (node: Node) => void,
  zIndex?: number
) => {
  const file = blobToFile(blob, 'video.mp4', blob.type || 'video/mp4');
  const newNode = createVideoNodeForUpload(position, nodeId, file);
  const nodeWithZ = zIndex !== undefined ? ({ ...newNode, zIndex } as Node & { zIndex?: number }) : newNode;
  addNode(nodeWithZ);
};

/** Adds an audio node from a clipboard audio blob. */
const handleAudioFileUpload = (
  blob: Blob,
  position: { x: number; y: number },
  nodeId: string,
  addNode: (node: Node) => void,
  zIndex?: number
) => {
  const file = blobToFile(blob, 'audio.mp3', blob.type || 'audio/mpeg');
  const newNode = createAudioNodeForUpload(position, nodeId, file);
  const nodeWithZ = zIndex !== undefined ? ({ ...newNode, zIndex } as Node & { zIndex?: number }) : newNode;
  addNode(nodeWithZ);
};

/** Listens for global paste and creates canvas nodes from clipboard files or text. */
const ClipboardPasteHandler: React.FC = () => {
  const { screenToFlowPosition } = useReactFlow();
  const { nodes } = useCanvasData();
  const { addNode } = useCanvasActions();

  const handlePaste = async (e: ClipboardEvent) => {
    // Skip when focus/selection is inside editor inputs or ProseMirror.
    if (isEditablePasteContext(e)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (!e.clipboardData) {
      return;
    }

    let clipboardData = null;
    // Prefer first matching media item from clipboardData.items
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemType = item.type.toLowerCase();
      if (itemType.startsWith('image/')) {
        const blob = item.getAsFile();
        if (blob) {
          clipboardData = {
            type: 'image' as const,
            data: blob,
          };
          break;
        }
      }
      if (itemType.startsWith('audio/')) {
        const blob = item.getAsFile();
        if (blob) {
          clipboardData = {
            type: 'audio' as const,
            data: blob,
          };
          break;
        }
      }
      if (itemType.startsWith('video/')) {
        const blob = item.getAsFile();
        if (blob) {
          clipboardData = {
            type: 'video' as const,
            data: blob,
          };
          break;
        }
      }
    }
    if (!clipboardData && e.clipboardData.getData('text')) {
      const text = e.clipboardData.getData('text');
      clipboardData = {
        type: 'text' as const,
        data: text,
      };
    }

    if (!clipboardData) {
      return;
    }

    const viewport = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const position = screenToFlowPosition(viewport);

    const maxZIndex = nodes.reduce((max, node) => {
      const z = (node as Node & { zIndex?: number }).zIndex ?? 0;
      return Math.max(max, z);
    }, 0);
    const nextZIndex = maxZIndex + 1;

    const timestamp = Date.now();
    const randomString = nanoid(5);
    let nodeType: string;
    if (clipboardData.type === 'text') {
      nodeType = '1001';
    } else if (clipboardData.type === 'image') {
      nodeType = '1002';
    } else if (clipboardData.type === 'video') {
      nodeType = '1003';
    } else {
      nodeType = '1004';
    }
    const nodeId = `${nodeType}-${timestamp}-${randomString}`;

    switch (clipboardData.type) {
      case 'text': {
        handleTextPaste(clipboardData.data as string, position, nodeId, addNode, nextZIndex);
        break;
      }
      case 'image': {
        if (clipboardData.data instanceof Blob) {
          handleImageFileUpload(clipboardData.data, position, nodeId, addNode, nextZIndex);
        }
        break;
      }
      case 'video': {
        if (clipboardData.data instanceof Blob) {
          handleVideoFileUpload(clipboardData.data, position, nodeId, addNode, nextZIndex);
        }
        break;
      }
      case 'audio': {
        if (clipboardData.data instanceof Blob) {
          handleAudioFileUpload(clipboardData.data, position, nodeId, addNode, nextZIndex);
        }
        break;
      }
      default:
        return;
    }
  };

  useEffect(() => {
    const pasteHandler = (e: Event) => {
      handlePaste(e as ClipboardEvent);
    };
    window.addEventListener('paste', pasteHandler);
    return () => {
      window.removeEventListener('paste', pasteHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
};

export default ClipboardPasteHandler;
