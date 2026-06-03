// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { ProjectGrid } from '@web/pages/studio/grid/ProjectGrid';
import { SettingsPanel } from '@web/pages/studio/settings/SettingsPanel';
import { StudioShell } from '@web/pages/studio/shell/StudioShell';
import type { StudioSection } from '@web/pages/studio/shell/StudioNav';

/**
 * Studio page entry — wraps `StudioShell` (left nav) around the active
 * section body. V1 only Home (projects) and Settings are reachable; Assets
 * and Team are nav-only placeholders.
 *
 * Section state is local to the page. Persistence (last-active section per
 * user) lands in a later PR when preferences are wired to localStorage.
 * @returns the studio shell wrapping the active section body (projects or settings).
 */
export default function StudioPage(): React.JSX.Element {
  const [section, setSection] = React.useState<StudioSection>('home');
  return (
    <StudioShell active={section} onChangeSection={setSection}>
      {section === 'settings' ? <SettingsPanel /> : <ProjectGrid />}
    </StudioShell>
  );
}
