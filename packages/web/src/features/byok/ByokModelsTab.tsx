// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { modelLabel, type ModelEntry, type ModelModality } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { byokApi, type ByokView } from '@web/data/api/byok';
import { rereadByok } from '@web/features/byok/byok-query';
import { BYOK_MODALITIES } from '@web/features/byok/ByokUpstreamTab';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

/** The select value standing for the platform key; never an upstream id. */
const PLATFORM = '__platform__';

/** A model the account can point at a keyed upstream, with those upstreams. */
interface ModelChoice {
  entry: ModelEntry;
  /** Its name on screen, as the generation panel names it among the models of its modality listed here. */
  label: string;
  options: string[];
}

/**
 * The models tab: every model an upstream the account added a key for can run, under modality tabs, each with the
 * upstream it runs on.
 * @param props - The view, the catalog and the way back.
 * @param props.view - The account's BYOK view.
 * @param props.entries - Every model of the catalog.
 * @param props.loading - Whether the catalog is still on its way.
 * @param props.onAddKey - Switch to the upstream keys tab.
 * @returns The tab's content.
 */
export function ByokModelsTab({
  view,
  entries,
  loading,
  onAddKey,
}: {
  view: ByokView;
  entries: ModelEntry[];
  loading: boolean;
  onAddKey: () => void;
}): React.JSX.Element {
  const t = useTranslation();
  const [modality, setModality] = React.useState<ModelModality>('image');
  const [query, setQuery] = React.useState('');
  const names = React.useMemo(() => new Map(view.upstreams.map((u) => [u.upstream, u.name])), [view.upstreams]);
  const current = React.useMemo(() => new Map(view.models.map((m) => [m.model, m.upstream])), [view.models]);
  const choices = view.choices;
  const usable = React.useMemo<ModelChoice[]>(() => {
    const listed = entries.filter((entry) => (choices?.[entry.name] ?? []).length > 0);
    // Peers are the models listed together under the same modality tab.
    return listed.map((entry) => ({
      entry,
      label: modelLabel(entry, listed.filter((peer) => peer.modality === entry.modality)),
      options: choices?.[entry.name] ?? [],
    }));
  }, [entries, choices]);
  const changeModality = React.useCallback((next: string): void => {
    const found = BYOK_MODALITIES.find((m) => m === next);
    if (found !== undefined) setModality(found);
  }, []);

  const hasMediaKey = view.keys.some((key) => view.upstreams.find((u) => u.upstream === key.upstream)?.kind !== 'llm');
  if (!hasMediaKey) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center'>
        <p className='text-sm text-muted-foreground'>{t('byok.modelsEmpty')}</p>
        <Button type='button' variant='outline' onClick={onAddKey}>{t('byok.goAddKey')}</Button>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const hits = usable.filter((m) => m.label.toLowerCase().includes(needle));
  const rows = hits.filter((m) => m.entry.modality === modality);

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='flex shrink-0 flex-col gap-3 px-4 pb-3'>
        <p className='text-xs text-muted-foreground'>{t('byok.modelsIntro')}</p>
        <div className='flex items-center gap-3'>
          <Tabs value={modality} onValueChange={changeModality}>
            <TabsList className='w-fit'>
              {BYOK_MODALITIES.map((m) => (
                <TabsTrigger key={m} value={m} className='flex-none px-3'>
                  {t(`byok.modality.${m}`)}
                  <span className='tabular-nums text-muted-foreground'>{hits.filter((hit) => hit.entry.modality === m).length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Input
            className='ml-auto h-8 w-56'
            autoComplete='off'
            value={query}
            placeholder={t('byok.searchModels')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <ScrollArea className='min-h-0 flex-1 border-t border-border'>
        <div className='flex flex-col divide-y divide-border px-4'>
          {loading ? <Skeleton className='my-3 h-8' /> : null}
          {!loading && rows.length === 0 ? (
            <p className='py-6 text-center text-xs text-muted-foreground'>
              {needle !== '' ? t('byok.noModelMatch') : t('byok.noModelsInModality')}
            </p>
          ) : null}
          {rows.map((m) => (
            <ModelRow key={m.entry.name} choice={m} upstream={current.get(m.entry.name)} names={names} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * One model, with the upstream it runs on.
 * @param props - The model and its choice.
 * @param props.choice - The model and the keyed upstreams that run it.
 * @param props.upstream - The upstream it is set to, when any.
 * @param props.names - Each upstream's name.
 * @returns The row.
 */
const ModelRow = React.memo(function ModelRow({
  choice,
  upstream,
  names,
}: {
  choice: ModelChoice;
  upstream: string | undefined;
  names: Map<string, string>;
}): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const { entry, label, options } = choice;
  const set = useMutation({
    mutationFn: async (next: string | null): Promise<void> => {
      await byokApi.setModel(entry.name, next);
      await rereadByok(client);
    },
    onSuccess: (_, next) => {
      const name = next === null ? t('byok.platformKey') : names.get(next) ?? next;
      toast.success(t('byok.modelSaved', { model: label, upstream: name }));
    },
    onError: () => toast.error(t('byok.modelSaveFailed')),
  });
  // A choice the account no longer has a key for reads as the platform key, the way the server runs it.
  const saved = upstream !== undefined && options.includes(upstream) ? upstream : PLATFORM;
  // While the write is out, the select shows what was picked.
  const shown = set.isPending ? set.variables ?? PLATFORM : saved;

  return (
    <div className='flex items-center gap-3 py-2' data-testid={`byok-model-${entry.name}`}>
      <span className='min-w-0 truncate text-sm'>{label}</span>
      <div className='ml-auto w-60 shrink-0'>
        <Select
          value={shown}
          onValueChange={(next) => set.mutate(next === PLATFORM ? null : next)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PLATFORM}>{t('byok.platformKey')}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option} value={option}>{names.get(option) ?? option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
});
