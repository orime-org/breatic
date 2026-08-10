// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import {
  RAIL_ICON,
  RAIL_ROW_IDLE,
  RAIL_ROW_TOP,
} from '@web/pages/studio/rail/rail-row';

interface RailCreateStudioActionProps {
  /** Label for the create-studio action (resolved i18n). */
  label: string;
  /** Opens the create-team-studio dialog. */
  onCreateStudio: () => void;
}

/**
 * Create-studio, at the foot of the rail. It creates a Studio rather than
 * something inside the Studio you are already in, which is why it sits apart
 * from the other two create actions rather than beside them behind a rule.
 *
 * Its host pins it outside the scrolling area, so it stays reachable however
 * many studios the viewer belongs to.
 * @param props the label and the create handler.
 * @param props.label the create-studio label.
 * @param props.onCreateStudio opens the create-team-studio dialog.
 * @returns the rail's footer create-studio action.
 */
export function RailCreateStudioAction({
  label,
  onCreateStudio,
}: RailCreateStudioActionProps): React.JSX.Element {
  return (
    <Button
      type='button'
      variant={null}
      size={null}
      onClick={onCreateStudio}
      className={`${RAIL_ROW_TOP} ${RAIL_ROW_IDLE}`}
    >
      <Plus className={RAIL_ICON} />
      {label}
    </Button>
  );
}
