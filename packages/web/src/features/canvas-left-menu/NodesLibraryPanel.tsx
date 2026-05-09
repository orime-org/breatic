/**
 * NodesLibraryPanel — the floating panel that opens from the left
 * menu's 节点库 (📚) icon (spec/02 §4.3 + spec/06 §10.13.1 v13).
 *
 * Lists the four `outputType` choices for a generative node. Clicking
 * a row invokes `onCreateGenerative(outputType)` — the parent
 * (LeftFloatingMenu) routes this through to `useCanvasActions
 * .createGenerativeNode`, which performs the atomic three-body
 * create (generative + asset + primary edge) per spec §10.13.7.
 *
 * Visual reference: inner explorations
 * `2026-04-27-visual-language/mockups/05-canvas-native-tailwind.html`.
 */
import { Icon } from '@/ui/icon';
import { useOutsidePanelClose } from './use-outside-panel-close';

export type GenerativeOutputType = 'text' | 'image' | 'video' | 'audio';

interface NodesLibraryPanelProps {
  onClose: () => void;
  onCreateGenerative: (outputType: GenerativeOutputType) => void;
}

/**
 * One row in the panel. Mockup keeps the metadata terse (Chinese for
 * production, English-style helper sub-line). When the i18n pass
 * lands these go through `t()`.
 */
const OUTPUT_TYPE_ROWS: ReadonlyArray<{
  outputType: GenerativeOutputType;
  name: string;
  meta: string;
}> = [
  { outputType: 'text', name: '文本生成', meta: 'AI 生成文本' },
  { outputType: 'image', name: '图片生成', meta: 'AI 生成图片' },
  { outputType: 'video', name: '视频生成', meta: 'AI 生成视频' },
  { outputType: 'audio', name: '音频生成', meta: 'AI 生成音频' },
];

export function NodesLibraryPanel({
  onClose,
  onCreateGenerative,
}: NodesLibraryPanelProps) {
  const panelRef = useOutsidePanelClose('nodes', onClose);

  return (
    <div
      ref={panelRef}
      className='absolute top-1/2 -translate-y-1/2 left-[68px] w-[280px] max-h-[70vh] bg-background-default-base border border-border-default-secondary rounded-lg shadow-md flex flex-col z-30 overflow-hidden'
    >
      <div className='px-3 py-2.5 border-b border-border-default-secondary bg-background-default-secondary/50 flex-shrink-0'>
        <div className='text-[12px] font-semibold text-text-default-primary'>节点库</div>
        <div className='text-[10px] text-text-default-tertiary font-mono'>
          4 类生成节点 · 拖入或点击创建
        </div>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-1'>
        {OUTPUT_TYPE_ROWS.map((row) => (
          <button
            key={row.outputType}
            type='button'
            onClick={() => {
              onCreateGenerative(row.outputType);
              onClose();
            }}
            className='group flex items-center gap-2 px-2 py-2 w-full text-left rounded-sm hover:bg-background-default-secondary cursor-pointer'
          >
            <div className='w-8 h-8 rounded bg-brand-500/10 inline-flex items-center justify-center flex-shrink-0'>
              <Icon name='base-add' width={16} height={16} className='text-brand-700' />
            </div>
            <div className='flex-1 min-w-0'>
              <div className='text-[12px] font-medium text-text-default-primary truncate'>
                {row.name}
              </div>
              <div className='text-[10px] text-text-default-tertiary font-mono truncate'>
                {row.meta}
              </div>
            </div>
          </button>
        ))}
        <div className='text-[10px] text-text-default-tertiary font-mono px-2 leading-relaxed pt-3 border-t border-border-default-secondary mt-3'>
          spec §10.13 generative 节点 · 双按钮 ▶ / ↻
        </div>
      </div>
    </div>
  );
}
