/**
 * PlaceholderSpace — rendered when a Tab Bar tab points at a Space
 * kind that doesn't have a runtime implementation yet (document /
 * timeline in V1).
 *
 * The Space row still exists in `meta.spaces` so other collaborators
 * see the same tab; it just doesn't have a Yjs content doc backing
 * it. We surface that explicitly to the user instead of rendering an
 * empty pane.
 *
 * Once a Space kind ships a real implementation the corresponding
 * `spaces/<kind>/index.tsx` becomes the renderer and the
 * `SpaceShell` switch dispatches there.
 */

import { useTranslation } from 'react-i18next';
import type { SpaceType } from '@breatic/shared';
import { cn } from '@/utils/classnames';

export interface PlaceholderSpaceProps {
  kind: SpaceType;
  className?: string;
}

const PlaceholderSpace: React.FC<PlaceholderSpaceProps> = ({ kind, className }) => {
  const { t } = useTranslation();
  const kindLabel = t(`spaces.tab.kind_${kind}`, { defaultValue: kind });
  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center',
        'bg-[var(--color-background-default-secondary)]',
        className,
      )}
    >
      <div className="max-w-md text-center px-6">
        <div className="text-[15px] font-semibold text-[var(--color-text-default-base)] mb-2">
          {t('spaces.placeholder.title')}
        </div>
        <div className="text-[13px] text-[var(--color-text-default-secondary)] leading-relaxed">
          {t('spaces.placeholder.description', { kind: kindLabel })}
        </div>
      </div>
    </div>
  );
};

export default PlaceholderSpace;
