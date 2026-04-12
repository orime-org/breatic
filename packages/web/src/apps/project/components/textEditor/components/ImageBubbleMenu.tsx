import { useCallback, useEffect, useMemo, useRef, type ChangeEvent, type ComponentProps } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { isTextSelection } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
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
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors',
    active
      ? 'bg-[var(--color-brand-base)] text-[var(--color-text-on-button-base)]'
      : 'text-icon-base hover:bg-background-default-base-hover',
  ].join(' ');

interface ImageBubbleMenuProps {
  editor: Editor;
}

const IMAGE_BUBBLE_MENU_PLUGIN_KEY = new PluginKey('breaticImageToolbar');

/** Re-run floating position after `placement` updates (TipTap `updateOptions` does not). Runs after sibling `BubbleMenu` effect. */
function ImageBubbleToolbarPositionSync({ editor, align }: { editor: Editor; align: string }) {
  useEffect(() => {
    if (editor.isDestroyed || !editor.view) return;
    if (!isImageNodeSelection(editor)) return;
    editor.view.dispatch(editor.state.tr.setMeta(IMAGE_BUBBLE_MENU_PLUGIN_KEY, 'updatePosition'));
  }, [align, editor]);
  return null;
}

/** Reference rect for BubbleMenu — typed via TipTap’s menu props, no direct @floating-ui import. */
type ImageBubbleVirtualRef = ReturnType<NonNullable<ComponentProps<typeof BubbleMenu>['getReferencedVirtualElement']>>;

function isImageNodeSelection(editor: Editor): boolean {
  const s = editor.state.selection;
  return s instanceof NodeSelection && s.node.type.name === 'image';
}

/** Bubble above the real media box; horizontal anchor follows `textAlign` via placement. */
function getImageBubbleReference(editor: Editor): ImageBubbleVirtualRef {
  const view = editor.view;
  const s = editor.state.selection;
  if (!(s instanceof NodeSelection) || s.node.type.name !== 'image') return null;
  const dom = view.nodeDOM(s.from) as HTMLElement | null;
  if (!dom) return null;
  const inner =
    dom.querySelector<HTMLElement>('.breatic-image-resize-wrapper') ??
    dom.querySelector<HTMLElement>('.bn-file-name-with-icon');
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
  const fileRef = useRef<HTMLInputElement>(null);

  /** Must be referentially stable: BubbleMenu's effect dispatches on `shouldShow` / `options` change. */
  const shouldShowImageToolbar = useCallback((props: { editor: Editor }) => isImageNodeSelection(props.editor), []);

  /**
   * Placement tracks image `textAlign`: left → top-start, center → top, right → top-end.
   * `options` may change when align changes; that triggers one plugin update, not a loop.
   */
  const imageToolbar = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const s = ed.state.selection;
      if (!(s instanceof NodeSelection) || s.node.type.name !== 'image') return null;
      return {
        showPreview: s.node.attrs.showPreview !== false,
        textAlign: ((s.node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right',
      };
    },
  });

  const align = imageToolbar?.textAlign ?? 'left';

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
    fileRef.current?.click();
  }, []);

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

  const togglePreview = useCallback(() => {
    const s = editor.state.selection;
    if (!(s instanceof NodeSelection) || s.node.type.name !== 'image') return;
    const cur = s.node.attrs.showPreview !== false;
    editor.chain().focus().updateAttributes('image', { showPreview: !cur }).run();
  }, [editor]);

  const deleteImage = useCallback(() => {
    editor.chain().focus().deleteSelection().run();
  }, [editor]);

  const downloadImage = useCallback(() => {
    const s = editor.state.selection;
    if (!(s instanceof NodeSelection) || s.node.type.name !== 'image') return;
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
      editor.chain().focus().updateAttributes('image', { textAlign }).run();
    },
    [editor],
  );

  const previewOn = imageToolbar?.showPreview ?? true;

  return (
    <>
      <input ref={fileRef} type='file' accept='image/*' className='hidden' onChange={onFileChange} />
      <BubbleMenu
        editor={editor}
        pluginKey={IMAGE_BUBBLE_MENU_PLUGIN_KEY}
        className='bubble-menu'
        updateDelay={0}
        shouldShow={shouldShowImageToolbar}
        getReferencedVirtualElement={getReferencedVirtualElement}
        options={imageBubbleOptions}
      >
        <Tooltip title='Replace image' placement='top' offset={4}>
          <button type='button' className={iconBtnClass(false)} onMouseDown={(e) => e.preventDefault()} onClick={replaceImage}>
            <RiImageEditFill size={18} />
          </button>
        </Tooltip>
        <Tooltip title='Toggle preview' placement='top' offset={4}>
          <button
            type='button'
            className={iconBtnClass(previewOn)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={togglePreview}
          >
            <RiImageAddFill size={18} className={previewOn ? '' : 'opacity-40'} />
          </button>
        </Tooltip>
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
      </BubbleMenu>
      <ImageBubbleToolbarPositionSync editor={editor} align={align} />
    </>
  );
}

/** Hide the text formatting bubble while an image (or pending placeholder) is selected. */
export function formatBubbleShouldShow(props: {
  editor: Editor;
  element: HTMLElement;
  view: EditorView;
  state: EditorState;
  from: number;
  to: number;
}): boolean {
  const { editor, view, state, from, to, element } = props;
  const sel = state.selection;
  if (sel instanceof NodeSelection && (sel.node.type.name === 'image' || sel.node.type.name === 'pendingImage')) {
    return false;
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
