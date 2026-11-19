// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import type { ConnectionName } from '@breatic/shared';
import type { ProjectAgent } from '@web/data/yjs/project-meta';
import { useConnectionEntries } from '@web/features/comment-handover/use-connection-names';
import { useTranslation } from '@web/i18n/use-translation';
import { formatLocalDay } from '@web/lib/format-day';

type Translate = ReturnType<typeof useTranslation>;

/**
 * One agent's name as members read it: its connection's name, what tells it
 * apart from a same-named connection of its owner, and its owner.
 * @param t - The translator.
 * @param entry - The connection's name, or undefined before it arrives.
 * @param owner - The owner's name, or undefined when not on the roster.
 * @returns The label.
 */
function agentLabel(t: Translate, entry: ConnectionName | undefined, owner: string | undefined): string {
  let agent = entry?.name ?? t('agentPresence.unknown');
  const told = entry?.tellApart ?? null;
  if (told !== null) {
    const detail = told.kind === 'token' ? t('commentHandover.token', { prefix: told.prefix }) : t('commentHandover.since', { date: formatLocalDay(told.at) });
    agent = t('agentPresence.named', { name: agent, detail });
  }
  return owner === undefined ? agent : t('agentPresence.label', { agent, owner });
}

/**
 * Name each external agent "connection · owner" (#1488 design 19.2), for the
 * member list, the highlights and following.
 * @param agents - The agents present in the project.
 * @param ownerNames - Member names by user id.
 * @returns Label by connection id.
 */
export function useAgentLabels(agents: ReadonlyArray<ProjectAgent>, ownerNames: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const t = useTranslation();
  const ids = React.useMemo(() => agents.map((a) => a.connectionId), [agents]);
  const entries = useConnectionEntries(ids);
  const unknown = t('agentPresence.unknown');
  return React.useMemo(
    () => new Map(agents.map((a) => [a.connectionId, agentLabel(t, entries.get(a.connectionId), ownerNames.get(a.ownerId))])),
    // `unknown` stands for the locale: `t` keeps its identity across a switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, entries, ownerNames, unknown],
  );
}
