import * as React from 'react';

import { ProjectGrid } from '@/pages/studio/grid/ProjectGrid';
import { SettingsPanel } from '@/pages/studio/settings/SettingsPanel';
import { StudioShell } from '@/pages/studio/shell/StudioShell';
import type { StudioSection } from '@/pages/studio/shell/StudioNav';

/**
 * Studio page entry — wraps `StudioShell` (left nav) around the active
 * section body. V1 only Home (projects) and Settings are reachable; Assets
 * and Team are nav-only placeholders.
 *
 * Section state is local to the page. Persistence (last-active section per
 * user) lands in a later PR when preferences are wired to localStorage.
 */
export default function StudioPage() {
  const [section, setSection] = React.useState<StudioSection>('home');
  return (
    <StudioShell active={section} onChangeSection={setSection}>
      {section === 'settings' ? <SettingsPanel /> : <ProjectGrid />}
    </StudioShell>
  );
}
