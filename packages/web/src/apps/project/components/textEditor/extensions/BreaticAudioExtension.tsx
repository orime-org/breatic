import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { createElement, type MouseEvent as ReactMouseEvent } from 'react';
import AudioWaveformPlayer from '@/apps/project/components/canvas/common/AudioWaveformPlayer';

const BreaticAudioView = ({ node, editor, getPos }: NodeViewProps) => {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
  const title = typeof node.attrs.title === 'string' ? node.attrs.title : undefined;
  const textAlign = ((node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right';
  const accentBg = typeof node.attrs.accentBackground === 'string' ? node.attrs.accentBackground : undefined;

  const handleSelectAudioNode = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const isInteractive =
      target?.closest(
        'button,input,select,textarea,audio,[role="slider"],[data-ignore-node-selection="true"]',
      ) != null;
    if (isInteractive) return;

    const pos = getPos();
    if (typeof pos !== 'number') return;

    event.preventDefault();
    editor.chain().focus().setNodeSelection(pos).run();
  };

  return createElement(
    NodeViewWrapper,
    {
      as: 'div',
      className: 'breatic-audio-block',
      'data-breatic-audio': '',
      'data-text-align': textAlign,
      style: {
        width: '100%',
        maxWidth: '100%',
        display: 'flex',
        justifyContent: textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start',
        ...(accentBg ? { backgroundColor: accentBg } : {}),
      },
      onMouseDownCapture: handleSelectAudioNode,
    },
    createElement(
      'div',
      { className: 'w-full rounded-lg border border-border-default-base px-2 py-2', contentEditable: false },
      createElement(AudioWaveformPlayer, { src, label: title, showControls: true }),
    ),
  );
};

export const BreaticAudio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
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
        tag: 'div[data-breatic-audio]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const srcFromAttr = el.getAttribute('data-src');
          const titleFromAttr = el.getAttribute('data-title');
          const textAlign = el.getAttribute('data-text-align') || 'left';
          const accentBackground = el.getAttribute('data-accent-bg');
          if (srcFromAttr) {
            return {
              src: srcFromAttr,
              title: titleFromAttr || null,
              textAlign,
              accentBackground,
            };
          }

          const audio = el.querySelector('audio');
          if (!audio) return false;
          return {
            src: audio.getAttribute('src'),
            title: audio.getAttribute('title') || audio.getAttribute('data-name') || null,
            textAlign,
            accentBackground,
          };
        },
      },
      {
        tag: 'audio[src]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { src, title, textAlign, accentBackground, ...restAttrs } = HTMLAttributes;
    const attrs = mergeAttributes(restAttrs, {
      'data-breatic-audio': '',
      'data-src': src || '',
      'data-title': title || '',
      'data-text-align': textAlign || 'left',
      class: 'breatic-audio-export',
      ...(accentBackground ? { 'data-accent-bg': accentBackground } : {}),
    });
    return ['div', attrs];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BreaticAudioView);
  },
});
