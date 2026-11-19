// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ConnectionName } from '@breatic/shared';
import { agentAccessApi } from '@web/data/api/agent-access';

/**
 * The names of external-agent connections, anyone's and deleted ones
 * included, with what tells same-named ones of one owner apart.
 * @param ids - The connections; none asks nothing.
 * @returns Each name by id, empty until they arrive.
 */
export function useConnectionEntries(ids: readonly string[]): ReadonlyMap<string, ConnectionName> {
  const sorted = React.useMemo(() => [...new Set(ids)].sort(), [ids]);
  const names = useQuery({
    queryKey: ['agent-connection-names', ...sorted],
    queryFn: () => agentAccessApi.connectionNames(sorted),
    enabled: sorted.length > 0,
    staleTime: Infinity,
  });
  return React.useMemo(() => new Map((names.data ?? []).map((n) => [n.id, n])), [names.data]);
}

/**
 * The names of external-agent connections, anyone's and deleted ones
 * included, so what one wrote can say who.
 * @param ids - The connections; none asks nothing.
 * @returns Name by id, empty until they arrive.
 */
export function useConnectionNames(ids: readonly string[]): ReadonlyMap<string, string> {
  const entries = useConnectionEntries(ids);
  return React.useMemo(() => new Map([...entries].map(([id, entry]) => [id, entry.name])), [entries]);
}
