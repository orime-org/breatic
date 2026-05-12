/**
 * AgentCanvasActionButton — render `propose_canvas_action` tool
 * calls (spec §10.18.4 v13).
 *
 * Shows the proposal: action verb tag, rationale text, list of
 * proposed nodes (icon + label per row), and a single Apply button.
 * Apply is one-shot — once `applied === true`, the button flips to
 * a disabled "Already added" affordance so re-clicking the same
 * proposal can't double-spawn nodes.
 *
 * The host (chat panel) typically tracks `applied` per message id
 * so the affirmative state survives scrolling away + back. The
 * actual `createDataNode` call lives in the host's `onApply`
 * callback so this component stays presentation-only.
 *
 * Visual mockup: `2026-04-27-visual-language/05-canvas-native-tailwind.html`
 * line 1690.
 */
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/ui/icon';
import { cn } from '@/utils/classnames';
import type { AgentToolArgsProposeCanvasAction } from './agent-tool-types';
import type { ChatChipKind } from './ChatComposer';

interface AgentCanvasActionButtonProps {
  args: AgentToolArgsProposeCanvasAction;
  /** True once the user has applied this proposal. Locked thereafter. */
  applied?: boolean;
  onApply?: () => void;
}

/** Modality icon. Mirrors `ChatComposer`'s map so the chat surface uses one icon vocabulary. */
const ICON_BY_KIND: Record<ChatChipKind, string> = {
  image: 'project-image-icon',
  video: 'project-video-icon',
  audio: 'project-audio-icon',
  text: 'project-text-icon',
  generative: 'base-add',
};

const AgentCanvasActionButton: React.FC<AgentCanvasActionButtonProps> = ({
  args,
  applied = false,
  onApply,
}) => {
  const { t } = useTranslation();
  const nodes = args.nodes ?? [];

  return (
    <div className='mt-2 rounded-md border border-brand-500/30 bg-brand-500/5 px-3 py-2.5'>
      <div className='mb-2 inline-flex items-center gap-1.5 text-[11px] font-mono text-text-default-tertiary'>
        <span className='rounded-sm bg-background-default-base px-1.5 py-px text-text-default-secondary'>
          propose_canvas_action
        </span>
        <span className='text-text-default-tertiary'>
          {args.action} ·{' '}
          {t('canvas.chat.proposalNodeCount', {
            count: nodes.length,
            defaultValue: '{{count}} 节点',
          })}
        </span>
      </div>
      <div className='mb-2 text-[12px] leading-relaxed text-text-default-secondary'>
        {args.rationale}
      </div>
      <div className='mb-2.5 space-y-1'>
        {nodes.map((n, idx) => (
          <div
            key={`${n.type}-${idx}`}
            className='flex items-center gap-2 text-[11px] text-text-default-secondary'
          >
            <Icon
              name={ICON_BY_KIND[n.type] ?? 'base-add'}
              width={12}
              height={12}
              className='shrink-0 text-text-default-tertiary'
            />
            <span>{n.label}</span>
          </div>
        ))}
      </div>
      <button
        type='button'
        disabled={applied}
        onClick={() => !applied && onApply?.()}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded px-3 text-[12px] font-medium transition-colors',
          applied
            ? 'cursor-not-allowed bg-background-neutral-secondary text-text-default-tertiary'
            : 'bg-brand-base text-white hover:bg-brand-600',
        )}
      >
        {applied ? (
          <>
            <Icon name='base-add' width={12} height={12} />
            <span>
              {t('canvas.chat.proposalApplied', { defaultValue: '已加到画布' })}
            </span>
          </>
        ) : (
          <>
            <Icon name='base-add' width={12} height={12} color='var(--color-text-on-button-base)' />
            <span>
              {t('canvas.chat.proposalApply', {
                count: nodes.length,
                defaultValue: '加到画布({{count}} 节点)',
              })}
            </span>
          </>
        )}
      </button>
    </div>
  );
};

export default memo(AgentCanvasActionButton);
