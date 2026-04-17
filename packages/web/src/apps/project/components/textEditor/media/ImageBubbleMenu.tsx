import { useCallback, useEffect, useMemo, useRef, type ChangeEvent, type ComponentProps } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { isTextSelection } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { CellSelection } from '@tiptap/pm/tables';
import { isFormatBubbleSuppressed } from '../extensions/FormatBubbleSuppressExtension';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import {
  RiAlignCenter,
  RiAlignLeft,
  RiAlignRight,
  RiDeleteBinLine,
  RiDownloadLine,
  RiImageAddFill,
  RiImageEditFill,
} from 'react-icons/ri';

const iconBtnClass = (active: boolean) =>
  [
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors text-icon-base',
    active ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover',
  ].join(' ');

interface ImageBubbleMenuProps {
  editor: Editor;
}

const IMAGE_BUBBLE_MENU_PLUGIN_KEY = new PluginKey('breaticImageToolbar');
type ImageBubbleVirtualRef = ReturnType<NonNullable<ComponentProps<typeof BubbleMenu>['getReferencedVirtualElement']>>;

type MediaToolbarState =
  | { mode: 'image'; textAlign: 'left' | 'center' | 'right'; showPreview: true; pos: number }
  | { mode: 'video'; textAlign: 'left' | 'center' | 'right'; pos: number }
  | { mode: 'file'; pos: number };

function getMediaToolbarState(editor: Editor): MediaToolbarState | null {
  const s = editor.state.selection;
  if (!(s instanceof NodeSelection)) return null;

  if (s.node.type.name === 'image') {
    if (s.node.attrs.showPreview === false) {
      return { mode: 'file', pos: s.from };
    }
    return {
      mode: 'image',
      pos: s.from,
      showPreview: true,
      textAlign: ((s.node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right',
    };
  }

  if (s.node.type.name === 'video') {
    return {
      mode: 'video',
      pos: s.from,
      textAlign: ((s.node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right',
    };
  }

  return null;
}

/** Re-runs floating position when alignment changes; menu options alone do not reposition. */
function ImageBubbleToolbarPositionSync({ editor, align }: { editor: Editor; align: string }) {
  useEffect(() => {
    if (editor.isDestroyed || !editor.view) return;
    const toolbarState = getMediaToolbarState(editor);
    if (!toolbarState || toolbarState.mode === 'file') return;
    editor.view.dispatch(editor.state.tr.setMeta(IMAGE_BUBBLE_MENU_PLUGIN_KEY, 'updatePosition'));
  }, [align, editor]);
  return null;
}

/** Bubble above the real media box; horizontal anchor follows `textAlign` via placement. */
function getImageBubbleReference(editor: Editor): ImageBubbleVirtualRef {
  const view = editor.view;
  const toolbarState = getMediaToolbarState(editor);
  if (!toolbarState) return null;
  const s = editor.state.selection;
  if (!(s instanceof NodeSelection)) return null;
  const dom = view.nodeDOM(s.from) as HTMLElement | null;
  if (!dom) return null;
  const inner = (() => {
    if (toolbarState.mode === 'image') {
      return dom.querySelector<HTMLElement>('.breatic-image-resize-wrapper');
    }
    if (toolbarState.mode === 'video') {
      return dom.querySelector<HTMLElement>('.breatic-video-resize-wrapper');
    }
    return dom.querySelector<HTMLElement>('.bn-file-name-with-icon');
  })();
  const target = inner ?? dom;
  return {
    getBoundingClientRect: () => target.getBoundingClientRect(),
    getClientRects: () => {
      const r = target.getBoundingClientRect();
      return r.width === 0 && r.height === 0 ? [] : [r];
    },
  };
}

export default function ImageBubbleMenu({ editor }: ImageBubbleMenuProps) {
  const imageFileRef = useRef<HTMLInputElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const genericFileRef = useRef<HTMLInputElement>(null);

  /** Must stay referentially stable so the menu effect does not loop on unchanged logic. */
  const shouldShowImageToolbar = useCallback(
    (props: { editor: Editor }) => getMediaToolbarState(props.editor) !== null,
    [],
  );

  /**
   * Placement tracks image `textAlign`: left → top-start, center → top, right → top-end.
   * `options` may change when align changes; that triggers one plugin update, not a loop.
   */
  const imageToolbar = useEditorState({
    editor,
    selector: ({ editor: ed }) => getMediaToolbarState(ed),
  });

  const align = imageToolbar && 'textAlign' in imageToolbar ? imageToolbar.textAlign : 'left';

  const imageBubbleOptions = useMemo(() => {
    const placement =
      align === 'center' ? ('top' as const) : align === 'right' ? ('top-end' as const) : ('top-start' as const);
    return {
      placement,
      offset: 8,
    } satisfies NonNullable<ComponentProps<typeof BubbleMenu>['options']>;
  }, [align]);

  const getReferencedVirtualElement = useCallback((): ImageBubbleVirtualRef => getImageBubbleReference(editor), [editor]);

  const replaceImage = useCallback(() => {
    if (!imageToolbar) return;
    if (imageToolbar.mode === 'image') {
      imageFileRef.current?.click();
      return;
    }
    if (imageToolbar.mode === 'video') {
      videoFileRef.current?.click();
      return;
    }
    genericFileRef.current?.click();
  }, [imageToolbar]);

  const onFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !file.type.startsWith('image/')) return;

      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) return;
        editor.chain().focus().updateAttributes('image', { src }).run();
      };
      reader.readAsDataURL(file);
    },
    [editor],
  );

  const onVideoFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !file.type.startsWith('video/')) return;

      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) return;
        editor.chain().focus().updateAttributes('video', { src, title: file.name }).run();
      };
      reader.readAsDataURL(file);
    },
    [editor],
  );

  const onGenericFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) return;
        editor
          .chain()
          .focus()
          .updateAttributes('image', {
            src,
            alt: file.name,
            title: file.name,
            showPreview: false,
          })
          .run();
      };
      reader.readAsDataURL(file);
    },
    [editor],
  );

  const togglePreview = useCallback(() => {
    if (!imageToolbar || imageToolbar.mode !== 'image') return;
    const s = editor.state.selection;
    if (!(s instanceof NodeSelection) || s.node.type.name !== 'image') return;
    const cur = s.node.attrs.showPreview !== false;
    editor.chain().focus().updateAttributes('image', { showPreview: !cur }).run();
  }, [editor, imageToolbar]);

  const deleteImage = useCallback(() => {
    editor.chain().focus().deleteSelection().run();
  }, [editor]);

  const downloadImage = useCallback(() => {
    const s = editor.state.selection;
    if (!(s instanceof NodeSelection) || (s.node.type.name !== 'image' && s.node.type.name !== 'video')) return;
    const src = s.node.attrs.src as string | undefined;
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = '';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }, [editor]);

  const setImageAlign = useCallback(
    (textAlign: 'left' | 'center' | 'right') => {
      if (!imageToolbar || imageToolbar.mode === 'file') return;
      editor.chain().focus().updateAttributes(imageToolbar.mode, { textAlign }).run();
    },
    [editor, imageToolbar],
  );

  const replaceTitle =
    imageToolbar?.mode === 'video' ? 'Replace video' : imageToolbar?.mode === 'file' ? 'Replace file' : 'Replace image';

  return (
    <>
      <input ref={imageFileRef} type='file' accept='image/*' className='hidden' onChange={onFileChange} />
      <input ref={videoFileRef} type='file' accept='video/*' className='hidden' onChange={onVideoFileChange} />
      <input ref={genericFileRef} type='file' accept='*/*' className='hidden' onChange={onGenericFileChange} />
      <BubbleMenu
        editor={editor}
        pluginKey={IMAGE_BUBBLE_MENU_PLUGIN_KEY}
        className='bubble-menu'
        updateDelay={0}
        shouldShow={shouldShowImageToolbar}
        getReferencedVirtualElement={getReferencedVirtualElement}
        options={imageBubbleOptions}
      >
        <Tooltip title={replaceTitle} placement='top' offset={4}>
          <button type='button' className={iconBtnClass(false)} onMouseDown={(e) => e.preventDefault()} onClick={replaceImage}>
            <RiImageEditFill size={18} />
          </button>
        </Tooltip>
        {imageToolbar?.mode === 'image' && (
          <Tooltip title='Toggle preview' placement='top' offset={4}>
            <button type='button' className={iconBtnClass(false)} onMouseDown={(e) => e.preventDefault()} onClick={togglePreview}>
              <RiImageAddFill size={18} />
            </button>
          </Tooltip>
        )}
        <Tooltip title='Delete' placement='top' offset={4}>
          <button type='button' className={iconBtnClass(false)} onMouseDown={(e) => e.preventDefault()} onClick={deleteImage}>
            <RiDeleteBinLine size={18} />
          </button>
        </Tooltip>
        <Tooltip title='Download' placement='top' offset={4}>
          <button type='button' className={iconBtnClass(false)} onMouseDown={(e) => e.preventDefault()} onClick={downloadImage}>
            <RiDownloadLine size={18} />
          </button>
        </Tooltip>

        {imageToolbar?.mode !== 'file' && (
          <>
            <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />

            <Tooltip title='Align left' placement='top' offset={4}>
              <button
                type='button'
                className={iconBtnClass(align === 'left')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setImageAlign('left')}
              >
                <RiAlignLeft size={16} />
              </button>
            </Tooltip>
            <Tooltip title='Align center' placement='top' offset={4}>
              <button
                type='button'
                className={iconBtnClass(align === 'center')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setImageAlign('center')}
              >
                <RiAlignCenter size={16} />
              </button>
            </Tooltip>
            <Tooltip title='Align right' placement='top' offset={4}>
              <button
                type='button'
                className={iconBtnClass(align === 'right')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setImageAlign('right')}
              >
                <RiAlignRight size={16} />
              </button>
            </Tooltip>
          </>
        )}
      </BubbleMenu>
      <ImageBubbleToolbarPositionSync editor={editor} align={align} />
    </>
  );
}

/** Hide the text formatting bubble for media node selection, table cell selection, or inside a `highlightBlock`. */
export function formatBubbleShouldShow(props: {
  editor: Editor;
  element: HTMLElement;
  view: EditorView;
  state: EditorState;
  from: number;
  to: number;
}): boolean {
  const { editor, view, state, from, to, element } = props;
  if (isFormatBubbleSuppressed(state)) return false;
  const sel = state.selection;
  if (sel instanceof CellSelection) {
    return false;
  }
  if (sel instanceof NodeSelection) {
    const mediaNodeTypes = new Set([
      'image',
      'video',
      'audio',
      'pendingImage',
      'pendingVideo',
      'pendingAudio',
      'pendingFile',
    ]);
    if (mediaNodeTypes.has(sel.node.type.name)) {
      return false;
    }
    if (sel.node.type.name === 'highlightBlock') {
      return false;
    }
  }

  const isInsideHighlightBlock = (pos: number): boolean => {
    const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
    for (let d = $pos.depth; d >= 0; d -= 1) {
      if ($pos.node(d).type.name === 'highlightBlock') return true;
    }
    return false;
  };
  if (sel instanceof TextSelection) {
    if (isInsideHighlightBlock(sel.from) || isInsideHighlightBlock(sel.to)) {
      return false;
    }
  }

  const { doc, selection } = state;
  const { empty } = selection;
  const isEmptyTextBlock = !doc.textBetween(from, to).length && isTextSelection(selection);
  const isChildOfMenu = element.contains(document.activeElement);
  const hasEditorFocus = view.hasFocus() || isChildOfMenu;

  if (!hasEditorFocus || empty || isEmptyTextBlock || !editor.isEditable) {
    return false;
  }
  return true;
}
