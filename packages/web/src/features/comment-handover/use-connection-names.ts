// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { agentAccessApi } from '@web/data/api/agent-access';

/**
 * The names of external-agent connections, anyone's and deleted ones
 * included, so what one wrote can say who.
 * @param ids - The connections; none asks nothing.
 * @returns Name by id, empty until they arrive.
 */
export function useConnectionNames(ids: readonly string[]): ReadonlyMap<string, string> {
  const sorted = React.useMemo(() => [...new Set(ids)].sort(), [ids]);
  const names = useQuery({
    queryKey: ['agent-connection-names', ...sorted],
    queryFn: () => agentAccessApi.connectionNames(sorted),
    enabled: sorted.length > 0,
    staleTime: Infinity,
  });
  return React.useMemo(() => new Map((names.data ?? []).map((n) => [n.id, n.name])), [names.data]);
}
