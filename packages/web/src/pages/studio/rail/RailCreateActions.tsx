// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

interface RailCreateActionsProps {
  /** Label for the create-project action (resolved i18n). */
  createProjectLabel: string;
  /** Label for the create-collection action (disabled — backend deferred). */
  createCollectionLabel: string;
  /** Label for the create-studio action. */
  createStudioLabel: string;
  /** Tooltip on the disabled actions (e.g. "coming soon"). */
  comingSoonLabel: string;
  /** Opens the create-project dialog (with its studio selector, slice §7). */
  onCreateProject: () => void;
  /** Opens the create-team-studio dialog (rail segment ③). */
  onCreateStudio: () => void;
}

const ACTION =
  'flex h-8 items-center gap-2.5 rounded-chrome px-2 text-sm font-medium leading-none transition-colors';

/**
 * Rail create actions (spec §4.1 segments ① + ②): create project (enabled,
 * opens the dialog) + create collection / create studio (disabled placeholders
 * — their backends don't exist yet, so they are present-but-disabled, not
 * hidden, keeping the rail structure stable until those backends land). The
 * disabled actions use the HTML `disabled` attribute + `cursor-not-allowed`
 * (never `pointer-events: none`).
 * @param props the action labels, the coming-soon tooltip and the create handler.
 * @param props.createProjectLabel the create-project label.
 * @param props.createCollectionLabel the create-collection label (disabled).
 * @param props.createStudioLabel the create-studio label.
 * @param props.comingSoonLabel the tooltip shown on the disabled actions.
 * @param props.onCreateProject opens the create-project dialog.
 * @param props.onCreateStudio opens the create-team-studio dialog.
 * @returns the rail's create-action segments.
 */
export function RailCreateActions({
  createProjectLabel,
  createCollectionLabel,
  createStudioLabel,
  comingSoonLabel,
  onCreateProject,
  onCreateStudio,
}: RailCreateActionsProps): React.JSX.Element {
  return (
    <div className='flex flex-col gap-0.5'>
      <button
        type='button'
        onClick={onCreateProject}
        className={`${ACTION} text-foreground hover:bg-muted`}
      >
        <Plus className='h-4 w-4 text-foreground' />
        {createProjectLabel}
      </button>
      <button
        type='button'
        disabled
        title={comingSoonLabel}
        className={`${ACTION} cursor-not-allowed text-muted-foreground opacity-65`}
      >
        <Plus className='h-4 w-4' />
        {createCollectionLabel}
      </button>

      <hr className='mx-1.5 my-1.5 border-border' />

      <button
        type='button'
        onClick={onCreateStudio}
        className={`${ACTION} text-foreground hover:bg-muted`}
      >
        <Plus className='h-4 w-4 text-foreground' />
        {createStudioLabel}
      </button>
    </div>
  );
}
