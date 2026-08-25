// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { RailIcon } from '@web/pages/studio/rail/RailIcon';
import {
  RAIL_ROW_IDLE,
  RAIL_ROW_TOP,
  RAIL_SEGMENT,
} from '@web/pages/studio/rail/rail-row';

interface RailFooterProps {
  /** Opens the create-team-studio dialog. */
  onCreateStudio: () => void;
}

/**
 * The rail's foot: create-studio, above a rule, pinned below the scrolling
 * content. It creates a Studio rather than something inside the Studio you are
 * already in, which is why it sits apart from the other two create actions
 * rather than beside them.
 *
 * The rule, the padding and the label live here rather than in each host.
 * Both hosts render this same foot, and when they each wrote it out the two
 * copies were byte-identical — which is the state every drift in this rail so
 * far has started from. What genuinely belongs to a host is only where the
 * foot sits: a sibling of the ScrollArea rather than inside it, so a long
 * studio list cannot push it out of view.
 * @param props - The create handler.
 * @param props.onCreateStudio - Opens the create-team-studio dialog.
 * @returns The rail's pinned foot.
 */
export function RailFooter({
  onCreateStudio,
}: RailFooterProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className={`shrink-0 border-t border-border ${RAIL_SEGMENT}`}>
      <Button
        type='button'
        variant={null}
        size={null}
        onClick={onCreateStudio}
        className={`${RAIL_ROW_TOP} ${RAIL_ROW_IDLE}`}
      >
        <RailIcon icon={Plus} />
        {t('studio.rail.createStudio')}
      </Button>
    </div>
  );
}
