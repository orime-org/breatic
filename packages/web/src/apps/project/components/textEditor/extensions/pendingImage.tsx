import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { RiImage2Fill } from 'react-icons/ri';
import { openBlockNoteStyleImagePanel } from '../components/BlockNoteImageFilePanel';

/**
 * Empty image block — mirrors BlockNote image with `url: ""` + Add-file UI.
 * Slash `/image` inserts this node, then {@link FilePanelController} opens anchored here.
 */
const PendingImageView = ({ editor, getPos }: NodeViewProps) => {
  const openPanel = () => {
    const p = getPos();
    if (typeof p === 'number') openBlockNoteStyleImagePanel(editor, p);
  };

  return (
    <NodeViewWrapper
      as='div'
      className='bn-block-content'
      data-content-type='image'
      data-file-block=''
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
            <RiImage2Fill size={24} />
          </div>
          <div className='bn-add-file-button-text'>Add image</div>
        </div>
      </div>
    </NodeViewWrapper>
  );
};

export const PendingImage = Node.create({
  name: 'pendingImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div[data-bn-pending-image]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-bn-pending-image': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(PendingImageView);
  },
});
