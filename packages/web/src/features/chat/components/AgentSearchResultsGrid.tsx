/**
 * AgentSearchResultsGrid — render `show_search_results` tool calls
 * (spec §10.18.4 v13).
 *
 * 2-column thumbnail grid; each tile shows the image, a gradient
 * overlay with title + source, and a hover-revealed "Add to Space"
 * button that fires `onAddToSpace(hit)` for the host to spawn an
 * image node from the URL.
 *
 * Image fallback: `url === ''` or `url === '#'` (the mockup's
 * placeholder convention) renders a neutral block instead of a
 * broken image. Real backend `show_search_results` always sends a
 * real URL; the placeholder only shows up in tests / mocks.
 *
 * Visual mockup: `2026-04-27-visual-language/05-canvas-native-tailwind.html`
 * line 1661.
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import type {
  AgentSearchHit,
  AgentToolArgsShowSearchResults,
} from './agent-tool-types';

interface AgentSearchResultsGridProps {
  args: AgentToolArgsShowSearchResults;
  /** Add this hit to the current canvas Space as an image node. */
  onAddToSpace?: (hit: AgentSearchHit) => void;
}

function isPlaceholder(url: string): boolean {
  return url === '' || url === '#';
}

const AgentSearchResultsGrid: React.FC<AgentSearchResultsGridProps> = ({
  args,
  onAddToSpace,
}) => {
  const { t } = useTranslation();
  const items = args.images ?? [];

  return (
    <div className='mt-2 rounded-md border border-border-default-secondary bg-background-default-secondary px-3 py-2.5'>
      <div className='mb-2 inline-flex items-center gap-1.5 text-[11px] font-mono text-text-default-tertiary'>
        <span className='rounded-sm bg-background-default-base px-1.5 py-px text-text-default-secondary'>
          show_search_results
        </span>
        <span className='text-text-default-tertiary'>
          {t('canvas.chat.searchHitsCount', {
            count: items.length,
            defaultValue: '{{count}} 张参考图',
          })}
        </span>
      </div>
      <div className='grid grid-cols-2 gap-1.5'>
        {items.map((hit, idx) => (
          <div
            key={`${hit.url}-${idx}`}
            className='group relative aspect-square overflow-hidden rounded border border-border-default-secondary'
          >
            {isPlaceholder(hit.url) ? (
              <div className='h-full w-full bg-background-neutral-secondary' />
            ) : (
              <img
                src={hit.url}
                alt={hit.title}
                className='h-full w-full object-cover'
                loading='lazy'
              />
            )}
            <div className='absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5'>
              <div className='truncate text-[9px] font-medium text-white/95'>
                {hit.title}
              </div>
              <div className='truncate font-mono text-[8px] text-white/60'>
                {hit.source}
              </div>
            </div>
            {onAddToSpace && (
              <button
                type='button'
                onClick={() => onAddToSpace(hit)}
                title={t('canvas.chat.addToSpace', {
                  defaultValue: '添加到 Space',
                })}
                aria-label={t('canvas.chat.addToSpace', {
                  defaultValue: '添加到 Space',
                })}
                className='absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded bg-neutral-900 text-white opacity-0 transition-all hover:bg-neutral-700 group-hover:opacity-100'
              >
                <Icon name='base-add' width={12} height={12} color='var(--color-text-on-button-base)' />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default memo(AgentSearchResultsGrid);
