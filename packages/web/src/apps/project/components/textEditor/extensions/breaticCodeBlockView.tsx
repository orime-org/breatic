import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { all, createLowlight } from 'lowlight';
import Dropdown, { type MenuItemType } from '@/components/base/dropdown';

const CODE_LANGUAGES = [
  { value: 'plaintext', label: 'Plain text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Bash' },
  { value: 'sql', label: 'SQL' },
  { value: 'markdown', label: 'Markdown' },
] as const;

type CodeLanguage = (typeof CODE_LANGUAGES)[number]['value'];

const lowlight = createLowlight(all);

const normalizeLanguage = (value: unknown): CodeLanguage =>
  CODE_LANGUAGES.some((item) => item.value === value) ? (value as CodeLanguage) : 'javascript';

const languageItems: MenuItemType[] = CODE_LANGUAGES.map((item) => ({
  key: item.value,
  label: item.label,
}));

const getCodeBlockDropdownContainer = (editor: NodeViewProps['editor']): HTMLElement => {
  try {
    const dom = editor.view?.dom as HTMLElement | undefined;
    const scroll = dom?.closest('.breatic-editor-scroll');
    if (scroll instanceof HTMLElement) return scroll;
    const wrap = dom?.closest('.breatic-editor-wrapper');
    if (wrap instanceof HTMLElement) return wrap;
  } catch {
    // fall through to document.body
  }
  return document.body;
};

const BreaticCodeBlockView = ({ node, updateAttributes, editor }: NodeViewProps) => {
  const language = normalizeLanguage(node.attrs.language);
  const languageLabel = CODE_LANGUAGES.find((item) => item.value === language)?.label ?? 'Plain text';

  return (
    <NodeViewWrapper as='div' className='breatic-code-block-node' data-language={language}>
      <div className='breatic-code-block-language-wrap' contentEditable={false}>
        <Dropdown
          trigger='click'
          placement='bottom-start'
          strategy='absolute'
          getPopupContainer={() => getCodeBlockDropdownContainer(editor)}
          items={languageItems}
          selectedKeys={[language]}
          popupClassName='breatic-code-block-language-menu rounded-[8px]'
          onClick={(key) => {
            updateAttributes({ language: normalizeLanguage(key) });
            editor.commands.focus();
          }}
        >
          <button
            type='button'
            className='breatic-code-block-language-trigger'
            onMouseDown={(e) => e.preventDefault()}
            aria-label='Code language'
          >
            <span>{languageLabel}</span>
          </button>
        </Dropdown>
      </div>

      <pre className='hljs'>
        <NodeViewContent className={`hljs language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
};

export const BreaticCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: 'javascript',
        parseHTML: (element) => {
          const fromData = (element as HTMLElement).getAttribute('data-language');
          if (fromData) return normalizeLanguage(fromData);
          const fromClass = (element as HTMLElement)
            .getAttribute('class')
            ?.split(' ')
            .find((name) => name.startsWith('language-'))
            ?.replace('language-', '');
          return normalizeLanguage(fromClass);
        },
        renderHTML: (attributes) => {
          const language = normalizeLanguage(attributes.language);
          return {
            'data-language': language,
            class: `language-${language}`,
          };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(BreaticCodeBlockView);
  },
}).configure({
  lowlight,
});
