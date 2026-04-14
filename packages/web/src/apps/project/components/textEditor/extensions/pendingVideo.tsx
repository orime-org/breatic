import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { RiFilmLine } from 'react-icons/ri';
import { openMediaFilePanel } from '../components/MediaFilePanel';

const PendingVideoView = ({ editor, getPos, node }: NodeViewProps) => {
  const openPanel = () => {
    const p = getPos();
    if (typeof p === 'number') {
      openMediaFilePanel(editor, p, 'video');
    }
  };

  const textAlign = ((node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right';
  const accentBg = typeof node.attrs.accentBackground === 'string' ? node.attrs.accentBackground : undefined;

  return (
    <NodeViewWrapper
      as='div'
      className='bn-block-content'
      data-content-type='video'
      data-file-block=''
      data-text-align={textAlign}
      style={{
        display: 'flex',
        justifyContent: textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start',
        ...(accentBg ? { backgroundColor: accentBg } : {}),
      }}
    >
      <div className='bn-file-block-content-wrapper'>
        <div
          className='bn-add-file-button'
          role='button'
          tabIndex={0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openPanel}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPanel();
            }
          }}
        >
          <div className='bn-add-file-button-icon'>
            <RiFilmLine size={24} />
          </div>
          <div className='bn-add-file-button-text'>Add video</div>
        </div>
      </div>
    </NodeViewWrapper>
  );
};

export const PendingVideo = Node.create({
  name: 'pendingVideo',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      textAlign: {
        default: 'left',
        parseHTML: (element) => (element as HTMLElement).getAttribute('data-text-align') || 'left',
        renderHTML: (attributes) => ({
          'data-text-align': (attributes.textAlign as string) || 'left',
        }),
      },
      accentBackground: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).getAttribute('data-accent-bg'),
        renderHTML: (attributes) => {
          const v = attributes.accentBackground as string | null | undefined;
          return v ? { 'data-accent-bg': v } : {};
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-bn-pending-video]',
        getAttrs: (dom) => ({
          textAlign: (dom as HTMLElement).getAttribute('data-text-align') || 'left',
          accentBackground: (dom as HTMLElement).getAttribute('data-accent-bg'),
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-bn-pending-video': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PendingVideoView);
  },
});
