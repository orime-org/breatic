import type { ResizableNodeViewDirection } from '@tiptap/core';
import { mergeAttributes, ResizableNodeView } from '@tiptap/core';
import Image from '@tiptap/extension-image';

/** Creates left/right vertical resize handle elements for the image node view. */
function createImageResizeHandle(direction: ResizableNodeViewDirection): HTMLElement {
  const h = document.createElement('div');
  h.dataset.resizeHandle = direction;
  h.className = `bn-resize-handle bn-resize-handle--${direction}`;
  h.style.position = 'absolute';
  h.style.top = '50%';
  h.style.transform = 'translateY(-50%)';
  h.style.zIndex = '2';
  if (direction === 'left') {
    h.style.left = '4px';
  } else if (direction === 'right') {
    h.style.right = '4px';
  }
  return h;
}

function applyImageAlign(el: HTMLElement, align: string) {
  el.style.width = '100%';
  el.style.maxWidth = '100%';
  el.style.justifyContent =
    align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
}

const BN_FILE_LINE_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8L9.00319 2H19.9978C20.5513 2 21 2.45531 21 2.9918V21.0082C21 21.556 20.5551 22 20.0066 22H3.9934C3.44476 22 3 21.5501 3 20.9932V8ZM10 4V9H5V20H19V4H10Z"></path></svg>';

/** Resolves the displayed file name from title, alt, or URL basename. */
function imageNoPreviewLabel(attrs: {
  title?: string | null;
  alt?: string | null;
  src?: string | null;
}): string {
  const t = typeof attrs.title === 'string' ? attrs.title.trim() : '';
  if (t) return t;
  const a = typeof attrs.alt === 'string' ? attrs.alt.trim() : '';
  if (a) return a;
  const src = typeof attrs.src === 'string' ? attrs.src.trim() : '';
  if (!src || src.startsWith('data:')) return 'Image';
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'https://example.com/';
    const u = new URL(src, base);
    const seg = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (seg) return seg;
  } catch {
    /* ignore */
  }
  return src.length <= 80 ? src : 'Image';
}

/** Builds the file-name row DOM for link-mode (no preview) image blocks. */
function buildFileNameRow(label: string): {
  outer: HTMLDivElement;
  nameEl: HTMLParagraphElement;
} {
  const contentWrap = document.createElement('div');
  contentWrap.className = 'bn-file-block-content-wrapper';

  const row = document.createElement('div');
  row.className = 'bn-file-name-with-icon';
  row.setAttribute('contenteditable', 'false');
  row.draggable = false;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'bn-file-icon';
  iconWrap.innerHTML = BN_FILE_LINE_ICON_SVG;

  const nameEl = document.createElement('p');
  nameEl.className = 'bn-file-name';
  nameEl.textContent = label;

  row.appendChild(iconWrap);
  row.appendChild(nameEl);
  contentWrap.appendChild(row);

  return { outer: contentWrap, nameEl };
}

export const BreaticImage = Image.extend({
  name: 'image',

  draggable: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      showPreview: {
        default: true,
        parseHTML: (element) => {
          const el = element as HTMLElement;
          return el.getAttribute('data-bn-show-preview') !== 'false';
        },
        renderHTML: (attributes) => {
          if (attributes.showPreview === false) {
            return { 'data-bn-show-preview': 'false' };
          }
          return {};
        },
      },
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
    const imgTag = this.options.allowBase64 ? 'img[src]' : 'img[src]:not([src^="data:"])';
    return [
      {
        tag: 'div[data-breatic-image]',
        getAttrs: (dom: HTMLElement) => {
          const img = dom.querySelector('img');
          const a = dom.querySelector('a.breatic-image-link');
          const nameEl = dom.querySelector('p.bn-file-name');
          const textAlign = dom.getAttribute('data-text-align') || 'left';
          const showPreview = dom.getAttribute('data-bn-show-preview') !== 'false';
          const accentBackground = dom.getAttribute('data-accent-bg');
          if (img) {
            const w = img.getAttribute('width');
            const h = img.getAttribute('height');
            return {
              src: img.getAttribute('src'),
              alt: img.getAttribute('alt'),
              title: img.getAttribute('title'),
              width: w ? parseInt(w, 10) : null,
              height: h ? parseInt(h, 10) : null,
              textAlign,
              showPreview,
              accentBackground,
            };
          }
          if (nameEl && dom.querySelector('.bn-file-name-with-icon')) {
            const src =
              dom.getAttribute('data-image-src') || dom.getAttribute('data-src') || a?.getAttribute('href') || null;
            return {
              src,
              alt: nameEl.textContent || null,
              title: null,
              showPreview: false,
              textAlign,
              accentBackground,
            };
          }
          if (a) {
            return {
              src: a.getAttribute('href'),
              alt: a.textContent || null,
              title: null,
              showPreview: false,
              textAlign,
              accentBackground,
            };
          }
          return false;
        },
      },
      { tag: imgTag },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const align = ((node.attrs.textAlign as string) || 'left') as 'left' | 'center' | 'right';
    const showPreview = node.attrs.showPreview !== false;
    const textAlignStyle =
      align === 'center' ? 'text-align:center' : align === 'right' ? 'text-align:right' : 'text-align:left';

    const accent = node.attrs.accentBackground as string | null | undefined;
    const wrapperAttrs: Record<string, unknown> = {
      'data-breatic-image': '',
      'data-text-align': align,
      style: textAlignStyle + (accent ? `;background-color:${accent}` : ''),
      class: 'breatic-image-export',
    };
    if (!showPreview) {
      wrapperAttrs['data-bn-show-preview'] = 'false';
    }
    if (accent) {
      wrapperAttrs['data-accent-bg'] = accent;
    }

    const baseImg = mergeAttributes(this.options.HTMLAttributes, {
      ...HTMLAttributes,
      width: node.attrs.width,
      height: node.attrs.height,
    });

    const fileIcon = [
      'div',
      { class: 'bn-file-icon' },
      [
        'svg',
        { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'currentColor' },
        [
          'path',
          {
            d: 'M3 8L9.00319 2H19.9978C20.5513 2 21 2.45531 21 2.9918V21.0082C21 21.556 20.5551 22 20.0066 22H3.9934C3.44476 22 3 21.5501 3 20.9932V8ZM10 4V9H5V20H19V4H10Z',
          },
        ],
      ],
    ] as const;

    if (!showPreview && node.attrs.src) {
      const label = imageNoPreviewLabel({
        title: node.attrs.title as string | null,
        alt: node.attrs.alt as string | null,
        src: node.attrs.src as string | null,
      });
      (wrapperAttrs as Record<string, string>)['data-image-src'] = String(node.attrs.src);
      return [
        'div',
        wrapperAttrs,
        [
          'div',
          { class: 'bn-file-block-content-wrapper' },
          [
            'div',
            { class: 'bn-file-name-with-icon', contenteditable: 'false', draggable: 'false' },
            fileIcon,
            ['p', { class: 'bn-file-name' }, label],
          ],
        ],
      ];
    }

    return ['div', wrapperAttrs, ['img', mergeAttributes(baseImg, { src: node.attrs.src })]];
  },

  addNodeView() {
    const resize = this.options.resize;
    if (!resize || typeof resize !== 'object' || !resize.enabled || typeof document === 'undefined') {
      return null;
    }

    const { directions, minWidth, minHeight, alwaysPreserveAspectRatio } = resize;
    const extName = this.name;

    return ({ node, getPos, HTMLAttributes, editor }) => {
      const previewOn = node.attrs.showPreview !== false;

      if (!previewOn) {
        const outer = document.createElement('div');
        outer.className = 'breatic-image-block breatic-image-link-mode';
        outer.dataset.node = 'image';
        outer.setAttribute('data-file-block', '');
        outer.style.display = 'flex';
        applyImageAlign(outer, (node.attrs.textAlign as string) || 'left');
        const ab = node.attrs.accentBackground as string | null | undefined;
        outer.style.backgroundColor = ab || '';

        const label = imageNoPreviewLabel({
          title: node.attrs.title as string | null,
          alt: node.attrs.alt as string | null,
          src: node.attrs.src as string | null,
        });
        const { outer: fileBlock, nameEl } = buildFileNameRow(label);
        if (node.attrs.src) {
          outer.setAttribute('data-image-src', String(node.attrs.src));
        }
        outer.appendChild(fileBlock);

        return {
          dom: outer,
          update: (u) => {
            if (u.type.name !== 'image') return false;
            if (u.attrs.showPreview !== false) return false;
            applyImageAlign(outer, (u.attrs.textAlign as string) || 'left');
            const nextAb = u.attrs.accentBackground as string | null | undefined;
            outer.style.backgroundColor = nextAb || '';
            const nextSrc = u.attrs.src as string | null | undefined;
            if (nextSrc) outer.setAttribute('data-image-src', String(nextSrc));
            else outer.removeAttribute('data-image-src');
            const nextLabel = imageNoPreviewLabel({
              title: u.attrs.title as string | null,
              alt: u.attrs.alt as string | null,
              src: u.attrs.src as string | null,
            });
            if (nameEl.textContent !== nextLabel) nameEl.textContent = nextLabel;
            return true;
          },
          destroy: () => {},
        };
      }

      const el = document.createElement('img');
      el.classList.add('bn-visual-media');
      el.draggable = false;

      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        if (value != null) {
          switch (key) {
            case 'width':
            case 'height':
              break;
            default:
              el.setAttribute(key, value);
              break;
          }
        }
      });

      el.src = HTMLAttributes.src;

      const lastShowPreview = node.attrs.showPreview !== false;
      const resizeTarget: { el: HTMLElement | null } = { el: null };

      const nodeView = new ResizableNodeView({
        element: el,
        editor,
        node,
        getPos,
        onResize: (width, height) => {
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;
        },
        onCommit: (width, height) => {
          const pos = getPos();
          if (pos === undefined) {
            return;
          }
          editor.chain().setNodeSelection(pos).updateAttributes(extName, { width, height }).run();
        },
        onUpdate: (updatedNode) => {
          if (updatedNode.type !== node.type) {
            return false;
          }
          const np = updatedNode.attrs.showPreview !== false;
          if (np !== lastShowPreview) {
            return false;
          }
          const src = updatedNode.attrs.src as string | null | undefined;
          if (src != null && el.getAttribute('src') !== src) {
            el.setAttribute('src', src);
          }
          const alt = updatedNode.attrs.alt;
          if (alt != null) el.setAttribute('alt', String(alt));
          else el.removeAttribute('alt');
          if (resizeTarget.el) {
            applyImageAlign(resizeTarget.el, (updatedNode.attrs.textAlign as string) || 'left');
            resizeTarget.el.style.backgroundColor = (updatedNode.attrs.accentBackground as string) || '';
          }
          return true;
        },
        options: {
          directions,
          min: {
            width: minWidth,
            height: minHeight,
          },
          preserveAspectRatio: alwaysPreserveAspectRatio === true,
          className: {
            container: 'breatic-image-block',
            wrapper: 'breatic-image-resize-wrapper bn-visual-media-wrapper',
          },
          createCustomHandle: createImageResizeHandle,
        },
      });

      resizeTarget.el = nodeView.dom as HTMLElement;
      applyImageAlign(resizeTarget.el, (node.attrs.textAlign as string) || 'left');

      const dom = nodeView.dom as HTMLElement;
      dom.style.backgroundColor = (node.attrs.accentBackground as string) || '';

      dom.style.visibility = 'hidden';
      dom.style.pointerEvents = 'none';
      const reveal = () => {
        dom.style.visibility = '';
        dom.style.pointerEvents = '';
      };
      el.addEventListener('load', reveal, { once: true });
      if (el.complete && el.naturalHeight > 0) {
        reveal();
      }

      return nodeView;
    };
  },
});
