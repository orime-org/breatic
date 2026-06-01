import type * as React from 'react';
import type { ReactNode } from 'react';

import { StudioNav, type StudioSection } from '@web/pages/studio/shell/StudioNav';

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
 * @param root0 - component props
 * @param root0.active - the active section, forwarded to the left nav
 * @param root0.onChangeSection - called when the nav requests a section change
 * @param root0.children - the section body rendered in the main scroll area
 * @returns the studio chrome: left nav plus a scrollable main region.
 */
export function StudioShell({
  active,
  onChangeSection,
  children,
}: StudioShellProps): React.JSX.Element {
  return (
    <div className='flex h-screen bg-background text-foreground'>
      <StudioNav active={active} onChange={onChangeSection} />
      <main className='flex-1 overflow-auto p-6'>{children}</main>
    </div>
  );
}
