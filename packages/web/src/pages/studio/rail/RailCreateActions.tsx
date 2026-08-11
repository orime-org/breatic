// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { RailIcon } from '@web/pages/studio/rail/RailIcon';
import {
  RAIL_LIST,
  RAIL_ROW_DISABLED,
  RAIL_ROW_IDLE,
  RAIL_ROW_TOP,
} from '@web/pages/studio/rail/rail-row';

interface RailCreateActionsProps {
  /** Label for the create-project action (resolved i18n). */
  createProjectLabel: string;
  /** Label for the create-collection action (disabled — backend deferred). */
  createCollectionLabel: string;
  /** Tooltip on the disabled action (e.g. "coming soon"). */
  comingSoonLabel: string;
  /** Opens the create-project dialog (with its studio selector, slice §7). */
  onCreateProject: () => void;
}

/**
 * Rail create actions (spec §4.1 segment ①): create project (enabled, opens
 * the dialog) + create collection (a disabled placeholder — its backend does
 * not exist yet, so it is present-but-disabled rather than hidden, keeping the
 * rail's structure stable until that backend lands). The disabled action uses
 * the HTML `disabled` attribute + `cursor-not-allowed` (never
 * `pointer-events: none`, which would swallow the hover that explains why it
 * cannot be used).
 *
 * Create-studio used to sit here behind a rule of its own. It creates a
 * Studio rather than something inside the Studio you are already in, so it
 * moved to `RailFooter`, where that difference is what the layout says instead
 * of a rule mid-list leaving the reader to guess.
 * @param props the action labels, the coming-soon tooltip and the create handler.
 * @param props.createProjectLabel the create-project label.
 * @param props.createCollectionLabel the create-collection label (disabled).
 * @param props.comingSoonLabel the tooltip shown on the disabled action.
 * @param props.onCreateProject opens the create-project dialog.
 * @returns the rail's create-action segment.
 */
export function RailCreateActions({
  createProjectLabel,
  createCollectionLabel,
  comingSoonLabel,
  onCreateProject,
}: RailCreateActionsProps): React.JSX.Element {
  return (
    <div className={RAIL_LIST}>
      <Button
        type='button'
        variant={null}
        size={null}
        onClick={onCreateProject}
        className={`${RAIL_ROW_TOP} ${RAIL_ROW_IDLE}`}
      >
        <RailIcon icon={Plus} />
        {createProjectLabel}
      </Button>
      <Button
        type='button'
        disabled
        title={comingSoonLabel}
        variant={null}
        size={null}
        className={`${RAIL_ROW_TOP} ${RAIL_ROW_DISABLED}`}
      >
        <RailIcon icon={Plus} />
        {createCollectionLabel}
      </Button>
    </div>
  );
}
