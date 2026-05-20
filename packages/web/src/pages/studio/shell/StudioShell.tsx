import type { ReactNode } from 'react';

import { StudioNav, type StudioSection } from '@/pages/studio/shell/StudioNav';

interface StudioShellProps {
  active: StudioSection;
  onChangeSection: (section: StudioSection) => void;
  children: ReactNode;
}

/**
 * Studio page shell — left navigation + main scroll area.
 *
 * The page chooses what to render in `children` based on `active`; this
 * shell only owns the chrome (nav + main wrapper). Keeps layout decisions
 * out of the Page component.
 */
export function StudioShell({
  active,
  onChangeSection,
  children,
}: StudioShellProps) {
  return (
    <div className='flex h-screen bg-background text-foreground'>
      <StudioNav active={active} onChange={onChangeSection} />
      <main className='flex-1 overflow-auto p-6'>{children}</main>
    </div>
  );
}
