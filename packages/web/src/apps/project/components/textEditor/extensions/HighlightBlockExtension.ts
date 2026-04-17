import { mergeAttributes, Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    highlightBlock: {
      setHighlightBlock: () => ReturnType;
      toggleHighlightBlock: () => ReturnType;
      unsetHighlightBlock: () => ReturnType;
    };
  }
}

export const HighlightBlock = Node.create({
  name: 'highlightBlock',
  group: 'block',
  content: 'inline*',
  defining: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      aiPlaceholder: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const raw = element.getAttribute('data-ai-placeholder');
          if (raw == null) return null;
          return raw === 'true';
        },
        renderHTML: (attributes: { aiPlaceholder?: boolean | null }) => {
          if (!attributes.aiPlaceholder) return {};
          return { 'data-ai-placeholder': 'true' };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-highlight-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-highlight-block': '',
        class: 'breatic-highlight-block',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setHighlightBlock:
        () =>
        ({ commands }) =>
          commands.setNode(this.name),
      toggleHighlightBlock:
        () =>
        ({ commands }) =>
          commands.toggleNode(this.name, 'paragraph'),
      unsetHighlightBlock:
        () =>
        ({ commands }) =>
          commands.setParagraph(),
    };
  },
});
