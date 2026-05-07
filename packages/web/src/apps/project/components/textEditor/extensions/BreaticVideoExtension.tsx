import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { createElement, useEffect, useRef, useState } from 'react';
import Video from '@/spaces/canvas/common/Video';

const MIN_VIDEO_WIDTH = 240;

const BreaticVideoView = ({ node, updateAttributes }: NodeViewProps) => {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
  const textAlign = ((node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right';
  const accentBg = typeof node.attrs.accentBackground === 'string' ? node.attrs.accentBackground : undefined;
  const widthAttr = typeof node.attrs.width === 'number' ? node.attrs.width : null;
  const aspectRatioAttr = typeof node.attrs.aspectRatio === 'number' ? node.attrs.aspectRatio : null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    startX: number;
    startWidth: number;
    direction: 'left' | 'right';
    maxWidth: number;
  } | null>(null);
  const [widthPx, setWidthPx] = useState<number | null>(widthAttr);
  const widthRef = useRef<number | null>(widthAttr);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    setWidthPx(widthAttr);
    widthRef.current = widthAttr;
  }, [widthAttr]);

  useEffect(() => {
    if (!isResizing) return;

    const onMouseMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;
      const delta = event.clientX - resizeState.startX;
      const signedDelta = resizeState.direction === 'right' ? delta : -delta;
      const nextWidth = Math.round(
        Math.min(resizeState.maxWidth, Math.max(MIN_VIDEO_WIDTH, resizeState.startWidth + signedDelta)),
      );
      widthRef.current = nextWidth;
      setWidthPx(nextWidth);
    };

    const onMouseUp = () => {
      if (resizeStateRef.current && typeof widthRef.current === 'number') {
        updateAttributes({ width: widthRef.current });
      }
      resizeStateRef.current = null;
      setIsResizing(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isResizing, updateAttributes]);

  const startResize = (direction: 'left' | 'right', event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const currentEl = containerRef.current;
    if (!currentEl) return;
    const parentWidth = currentEl.parentElement?.clientWidth ?? currentEl.clientWidth;
    const startWidth = currentEl.getBoundingClientRect().width;
    resizeStateRef.current = {
      direction,
      startX: event.clientX,
      startWidth,
      maxWidth: Math.max(MIN_VIDEO_WIDTH, parentWidth),
    };
    setIsResizing(true);
  };

  return createElement(
    NodeViewWrapper,
    {
      as: 'div',
      className: 'breatic-video-block',
      'data-breatic-video': '',
      'data-resize-state': isResizing ? 'true' : 'false',
      'data-text-align': textAlign,
      style: {
        width: '100%',
        maxWidth: '100%',
        display: 'flex',
        justifyContent: textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start',
        ...(accentBg ? { backgroundColor: accentBg } : {}),
      },
    },
    createElement(
      'div',
      {
        ref: containerRef,
        className: 'breatic-video-resize-wrapper overflow-hidden rounded-lg border border-border-default-base bg-black',
        style: widthPx ? { width: `${widthPx}px`, maxWidth: '100%' } : { width: '100%', maxWidth: '100%' },
      },
      createElement('div', {
        className: 'bn-resize-handle bn-resize-handle--left',
        onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => startResize('left', event),
      }),
      createElement('div', {
        className: 'bn-resize-handle bn-resize-handle--right',
        onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => startResize('right', event),
      }),
      createElement(
        'div',
        { className: 'w-full min-h-0', style: { aspectRatio: aspectRatioAttr && aspectRatioAttr > 0 ? String(aspectRatioAttr) : '16 / 9' } },
        createElement(Video, { src, showControlBar: true, className: '!rounded-none h-full w-full' }),
      ),
    ),
  );
};

export const BreaticVideo = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      width: { default: null },
      aspectRatio: { default: null },
      textAlign: { default: 'left' },
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
        tag: 'div[data-breatic-video]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const srcFromAttr = el.getAttribute('data-src');
          const titleFromAttr = el.getAttribute('data-title');
          const widthFromAttr = el.getAttribute('data-width');
          const aspectRatioFromAttr = el.getAttribute('data-aspect-ratio');
          const textAlign = el.getAttribute('data-text-align') || 'left';
          const accentBackground = el.getAttribute('data-accent-bg');
          if (srcFromAttr) {
            return {
              src: srcFromAttr,
              title: titleFromAttr || null,
              width: widthFromAttr ? Number.parseInt(widthFromAttr, 10) : null,
              aspectRatio: aspectRatioFromAttr ? Number.parseFloat(aspectRatioFromAttr) : null,
              textAlign,
              accentBackground,
            };
          }

          const video = el.querySelector('video');
          if (!video) return false;
          return {
            src: video.getAttribute('src'),
            title: video.getAttribute('title') || video.getAttribute('data-name') || null,
            width: video.getAttribute('width') ? Number.parseInt(video.getAttribute('width') as string, 10) : null,
            aspectRatio:
              video.getAttribute('data-aspect-ratio') != null
                ? Number.parseFloat(video.getAttribute('data-aspect-ratio') as string)
                : null,
            textAlign,
            accentBackground,
          };
        },
      },
      {
        tag: 'video[src]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { src, title, width, aspectRatio, textAlign, accentBackground, ...restAttrs } = HTMLAttributes;
    const attrs = mergeAttributes(restAttrs, {
      'data-breatic-video': '',
      'data-src': src || '',
      'data-title': title || '',
      'data-width': width || '',
      'data-aspect-ratio': aspectRatio || '',
      'data-text-align': textAlign || 'left',
      class: 'breatic-video-export',
      ...(accentBackground ? { 'data-accent-bg': accentBackground } : {}),
    });
    if (width) {
      attrs.style = `width:${width}px;max-width:100%;`;
    }
    return ['div', attrs];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BreaticVideoView);
  },
});
