// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelCatalog, ModelEntry } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import type { ByokView } from '@web/data/api/byok';
import { modelCatalogQuery } from '@web/data/model-catalog-query';
import { ByokModelsTab } from '@web/features/byok/ByokModelsTab';
import { ByokUpstreamTab, forgetFinishedSaves } from '@web/features/byok/ByokUpstreamTab';
import { useByokView } from '@web/features/byok/byok-query';
import { useTranslation } from '@web/i18n/use-translation';

/** The two tabs, by value. */
type ByokTab = 'keys' | 'models';

/** A segmented tab sized to its words, as the demo draws it. */
const TAB_TRIGGER = 'flex-none px-3';

/**
 * Every model of the catalog in one list.
 * @param catalog - The catalog, or undefined until it loads.
 * @returns The entries, empty until the catalog loads.
 */
function entriesOf(catalog: ModelCatalog | undefined): ModelEntry[] {
  if (catalog === undefined) return [];
  return [...catalog.image, ...catalog.video, ...catalog.audio, ...catalog.tts, ...catalog.three_d];
}

/**
 * The "BYOK settings" dialog the account menu opens (inner#1953): the account's own upstream keys, and which keyed
 * upstream each non-language model runs on. It reads and writes the signed-in account's settings whichever Studio it
 * is opened in.
 * @param props - Open state.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Called when it opens or closes.
 * @returns The dialog.
 */
export function ByokDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const t = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Its length follows the data (one WaveSpeed key opens about seventy models), so it pins its own height and
        scrolls inside. */}
      <DialogContent className='h-[min(40rem,85vh)] max-w-[880px]' aria-describedby={undefined} data-testid='byok-dialog'>
        <DialogHeader className='shrink-0'>
          <DialogTitle>{t('byok.heading')}</DialogTitle>
        </DialogHeader>
        <ByokBody />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's body, by what the view read came to. Mounted only while the dialog is open, so each opening starts on
 * the upstream keys tab. The tabs show while the view is on its way; a deployment without BYOK replaces them with one
 * sentence.
 * @returns The body.
 */
function ByokBody(): React.JSX.Element {
  const t = useTranslation();
  const view = useByokView(true);
  const client = useQueryClient();
  // Closing the settings ends every form in them, so an opening afterwards shows no earlier refusal.
  React.useEffect(() => () => forgetFinishedSaves(client), [client]);
  const { refetch } = view;
  const retry = React.useCallback((): void => {
    void refetch();
  }, [refetch]);

  if (view.data?.enabled === false) return <p className='px-4 pb-4 text-sm text-muted-foreground'>{t('byok.disabled')}</p>;
  if (view.data === undefined && view.isError) return <LoadFailed onRetry={retry} />;
  return <ByokTabs view={view.data} />;
}

/**
 * What the dialog says when a read it needs failed, with a way to read it again.
 * @param props - The retry.
 * @param props.onRetry - Read again.
 * @returns The line.
 */
function LoadFailed({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='mx-4 mb-4 flex items-center justify-between rounded-content-sm border border-border px-4 py-3 text-sm'>
      <span className='text-status-error'>{t('byok.loadFailed')}</span>
      <Button type='button' variant='outline' size='sm' onClick={onRetry}>{t('byok.retry')}</Button>
    </div>
  );
}

/** What a tab shows while the view is on its way. */
const LOADING = <Skeleton className='m-4 h-16 flex-1 rounded-content-sm' />;

/**
 * The two tabs.
 * @param props - The view.
 * @param props.view - The account's BYOK view, or undefined while it loads.
 * @returns The tabs.
 */
function ByokTabs({ view }: { view: ByokView | undefined }): React.JSX.Element {
  const t = useTranslation();
  const [tab, setTab] = React.useState<ByokTab>('keys');
  const catalog = useQuery(modelCatalogQuery());
  const entries = React.useMemo(() => entriesOf(catalog.data), [catalog.data]);
  const changeTab = React.useCallback((next: string): void => setTab(next === 'models' ? 'models' : 'keys'), []);
  const goKeys = React.useCallback((): void => setTab('keys'), []);
  const { refetch } = catalog;
  const retry = React.useCallback((): void => {
    void refetch();
  }, [refetch]);
  // Both tabs list models from the catalog: until it is here neither shows, and a failed read says so.
  if (catalog.data === undefined && catalog.isError) return <LoadFailed onRetry={retry} />;
  const ready = view !== undefined && catalog.data !== undefined;

  return (
    <Tabs value={tab} onValueChange={changeTab} className='flex min-h-0 flex-1 flex-col'>
      <div className='shrink-0 px-4 pb-3'>
        <TabsList className='w-fit'>
          <TabsTrigger value='keys' className={TAB_TRIGGER}>{t('byok.tabKeys')}</TabsTrigger>
          <TabsTrigger value='models' className={TAB_TRIGGER}>{t('byok.tabModels')}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value='keys' className='hidden flex-1 border-t border-border data-[state=active]:flex'>
        {ready ? <ByokUpstreamTab view={view} entries={entries} /> : LOADING}
      </TabsContent>
      <TabsContent value='models' className='hidden flex-1 flex-col data-[state=active]:flex'>
        {ready ? <ByokModelsTab view={view} entries={entries} onAddKey={goKeys} /> : LOADING}
      </TabsContent>
    </Tabs>
  );
}
