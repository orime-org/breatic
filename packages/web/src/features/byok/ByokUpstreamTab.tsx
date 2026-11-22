// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useIsMutating, useMutation, useMutationState, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { getLocale, modelLabel, type ModelEntry, type ModelModality } from '@breatic/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { FieldError } from '@web/components/FieldError';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { PasswordInput } from '@web/components/ui/password-input';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { byokApi, type ByokSavedKey, type ByokUpstream, type ByokUpstreamKind, type ByokView } from '@web/data/api/byok';
import { ApiException } from '@web/data/api/types';
import { rereadByok } from '@web/features/byok/byok-query';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';

/** The order modalities are listed in, everywhere in the dialog. */
export const BYOK_MODALITIES: readonly ModelModality[] = ['image', 'video', 'audio', 'tts', 'three_d'];

/** The not-added groups, in order. */
const GROUPS: readonly [ByokUpstreamKind, string][] = [
  ['llm', 'byok.groupLanguageModel'],
  ['official', 'byok.groupOfficial'],
  ['reseller', 'byok.groupReseller'],
];

/** Why provider's key check says a key did not connect, each with a sentence of its own; any other reads as the generic one. */
const KNOWN_FAILURES = new Set(['invalid', 'unavailable', 'rate_limited', 'refused']);

type Translate = ReturnType<typeof useTranslation>;

/**
 * The upstream keys tab: the list on the left, the selected upstream on the right.
 * @param props - The view and the catalog.
 * @param props.view - The account's BYOK view.
 * @param props.entries - Every model of the catalog.
 * @returns The tab's content.
 */
export function ByokUpstreamTab({ view, entries }: { view: ByokView; entries: ModelEntry[] }): React.JSX.Element {
  const keyOf = React.useMemo(() => new Map(view.keys.map((key) => [key.upstream, key])), [view.keys]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  const shown = React.useMemo(
    () => view.upstreams.filter((u) => u.name.toLowerCase().includes(needle)),
    [view.upstreams, needle],
  );
  const firstAdded = shown.find((u) => keyOf.has(u.upstream))?.upstream ?? shown[0]?.upstream ?? null;
  // Opens on the first added upstream; a pick the list no longer shows, deleted or searched away, falls back to the
  // first one it does show, and nothing when the search leaves none.
  const current = selected !== null && shown.some((u) => u.upstream === selected) ? selected : firstAdded;
  const upstream = shown.find((u) => u.upstream === current);

  return (
    <>
      <UpstreamList
        shown={shown}
        searching={needle !== ''}
        query={query}
        onQuery={setQuery}
        keyOf={keyOf}
        selected={current}
        onSelect={setSelected}
      />
      <ScrollArea className='min-h-0 flex-1'>
        {upstream === undefined ? null : (
          <UpstreamDetail
            key={upstream.upstream}
            upstream={upstream}
            saved={keyOf.get(upstream.upstream)}
            entries={entries}
            models={view.models}
          />
        )}
      </ScrollArea>
    </>
  );
}

/**
 * The left column: a search box, the added upstreams, then the rest by group.
 * @param props - The list's data.
 * @param props.shown - The deployment's upstreams the search leaves.
 * @param props.searching - Whether the search box holds anything.
 * @param props.query - What the search box holds.
 * @param props.onQuery - Called as the user types in the search box.
 * @param props.keyOf - The saved key of each added upstream.
 * @param props.selected - The upstream on the right.
 * @param props.onSelect - Select an upstream.
 * @returns The column.
 */
const UpstreamList = React.memo(function UpstreamList({
  shown,
  searching,
  query,
  onQuery,
  keyOf,
  selected,
  onSelect,
}: {
  shown: ByokUpstream[];
  searching: boolean;
  query: string;
  onQuery: (query: string) => void;
  keyOf: Map<string, ByokSavedKey>;
  selected: string | null;
  onSelect: (upstream: string) => void;
}): React.JSX.Element {
  const t = useTranslation();
  const added = shown.filter((u) => keyOf.has(u.upstream));
  const groups = GROUPS.map(([kind, label]) => [label, shown.filter((u) => u.kind === kind && !keyOf.has(u.upstream))] as const);
  // The added group shows while it has rows, and always outside a search, where it says none are added yet.
  const addedShown = added.length > 0 || !searching;

  /**
   * One upstream's row.
   * @param u - The upstream.
   * @returns The row.
   */
  const row = (u: ByokUpstream): React.JSX.Element => {
    const saved = keyOf.get(u.upstream);
    return (
      <Button
        key={u.upstream}
        type='button'
        variant={null}
        size={null}
        data-testid={`byok-upstream-${u.upstream}`}
        aria-current={selected === u.upstream ? 'true' : undefined}
        onClick={() => onSelect(u.upstream)}
        className={cn(
          'flex w-full items-center gap-2 rounded-chrome px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          selected === u.upstream ? 'bg-accent-strong font-medium' : 'hover-enabled:bg-accent',
        )}
      >
        <span className='min-w-0 flex-1 truncate'>{u.name}</span>
        {saved === undefined ? null : (
          <span
            data-testid='byok-status-dot'
            data-state={saved.lastConnected ? 'connected' : 'failed'}
            className={cn('h-2 w-2 shrink-0 rounded-full', saved.lastConnected ? 'bg-status-success' : 'bg-status-error')}
          />
        )}
      </Button>
    );
  };
  /**
   * A group's heading.
   * @param text - The heading.
   * @returns The heading.
   */
  const head = (text: string): React.JSX.Element => (
    <span className='px-2 pt-2 text-2xs font-medium text-muted-foreground'>{text}</span>
  );

  return (
    <div className='flex min-h-0 w-60 shrink-0 flex-col border-r border-border'>
      <div className='shrink-0 p-3 pb-2'>
        <Input
          className='h-8'
          autoComplete='off'
          value={query}
          placeholder={t('byok.searchUpstreams')}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <ScrollArea className='min-h-0 flex-1'>
        <div className='flex flex-col gap-0.5 px-2 pb-3'>
          {shown.length === 0 ? <p className='px-2 py-2 text-xs text-muted-foreground'>{t('byok.noUpstreamMatch')}</p> : null}
          {addedShown ? head(t('byok.added')) : null}
          {added.length > 0 ? added.map(row) : searching ? null : (
            <p className='px-2 py-1 text-xs text-muted-foreground'>{t('byok.noneAdded')}</p>
          )}
          {addedShown && groups.some(([, list]) => list.length > 0) ? (
            <div data-testid='byok-list-separator' className='mx-2 my-1.5 h-px bg-border' />
          ) : null}
          {groups.map(([label, list]) => list.length === 0 ? null : (
            <React.Fragment key={label}>
              {head(t('byok.notAddedGroup', { group: t(label) }))}
              {list.map(row)}
            </React.Fragment>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
});

/**
 * What the last check said about a connected key's balance.
 * @param saved - The saved key.
 * @param kind - The upstream's group; an OpenRouter key's figure is what is left of its own limit.
 * @param t - The translator.
 * @returns The sentence, or null when there is nothing to say.
 */
function balanceText(saved: ByokSavedKey, kind: ByokUpstreamKind, t: Translate): string | null {
  switch (saved.lastBalanceState) {
    case 'known':
      if (saved.lastBalanceAmount === null) return null;
      return t(kind === 'llm' ? 'byok.balanceKeyLimit' : 'byok.balance', { amount: money(saved.lastBalanceAmount, saved.lastBalanceCurrency) });
    case 'forbidden':
      return t('byok.balanceForbidden');
    case 'no_cap':
      return t('byok.balanceNoCap');
    case 'unsupported':
      return t('byok.balanceUnsupported');
    default:
      return null;
  }
}

/**
 * An amount of money in the user's locale, in the currency the upstream reported.
 * @param amount - The amount, as the server sends it.
 * @param currency - Its ISO 4217 code; US dollars when the upstream named none.
 * @returns The formatted amount, or the bare amount and code when the code is not one the browser knows.
 */
function money(amount: string, currency: string | null): string {
  const code = currency ?? 'USD';
  try {
    return new Intl.NumberFormat(getLocale(), { style: 'currency', currency: code }).format(Number(amount));
  } catch {
    return `${amount} ${code}`;
  }
}

/**
 * Why a key did not connect, in the user's language.
 * @param failure - The reason the last check recorded.
 * @param t - The translator.
 * @returns The sentence.
 */
function failureText(failure: string | null, t: Translate): string {
  return t(`byok.failure.${failure !== null && KNOWN_FAILURES.has(failure) ? failure : 'other'}`);
}

/** The mutation key every upstream's save sits under. */
const SAVE_ROOT = ['byok', 'save'] as const;

/**
 * The mutation key of saving one upstream's key from one form, so each form shows only its own refusal and a prefix
 * of just the upstream finds both forms' saves.
 * @param upstream - The upstream id.
 * @param form - The add form or the replace dialog; both when left out.
 * @returns The key.
 */
function saveKeyOf(upstream: string, form?: 'add' | 'replace'): readonly string[] {
  return form === undefined ? [...SAVE_ROOT, upstream] : [...SAVE_ROOT, upstream, form];
}

/**
 * Forget finished saves, so a form started afresh (the settings opened again, the replace dialog opened, the add form
 * after a delete) shows no earlier refusal; a save still waiting stays. Switching to another upstream and back keeps them.
 * @param client - The query client.
 * @param upstream - The upstream whose saves to forget; every upstream's when left out.
 */
export function forgetFinishedSaves(client: QueryClient, upstream?: string): void {
  const cache = client.getMutationCache();
  for (const save of cache.findAll({ mutationKey: upstream === undefined ? SAVE_ROOT : saveKeyOf(upstream) })) {
    if (save.state.status !== 'pending') cache.remove(save);
  }
}

/**
 * Why a save was refused, in the user's language: the check's reason when it has a sentence of its own.
 * @param err - What the save threw.
 * @param t - The translator.
 * @returns The sentence.
 */
function refusalText(err: unknown, t: Translate): string {
  if (!(err instanceof ApiException) || !err.fromServer) return t('byok.saveFailed');
  return err.reason !== undefined && KNOWN_FAILURES.has(err.reason) ? failureText(err.reason, t) : err.message;
}

/**
 * Saving a key: the check runs on the server first. The wait and the refusal are read from the mutation cache by
 * upstream, so both survive switching to another upstream and back.
 * @param upstream - The upstream.
 * @param form - The add form or the replace dialog, whose refusals stay apart.
 * @param onSaved - Called once the saved key is on screen.
 * @returns The save, its wait, its refusal and a way to clear the refusal.
 */
function useSaveKey(upstream: ByokUpstream, form: 'add' | 'replace', onSaved?: () => void): {
  save: (key: string) => void;
  saving: boolean;
  error: string | null;
  clearError: () => void;
} {
  const t = useTranslation();
  const client = useQueryClient();
  const mutationKey = saveKeyOf(upstream.upstream, form);
  const [typedError, setTypedError] = React.useState<string | null>(null);
  // The submit time of the last refusal the user has moved past by typing.
  const [clearedAt, setClearedAt] = React.useState(0);
  const { mutate } = useMutation({
    mutationKey,
    // Read again either way, and before the result shows: a refusal can follow a change made in another tab.
    mutationFn: (key: string): Promise<ByokSavedKey> => byokApi.saveKey(upstream.upstream, key).finally(() => rereadByok(client)),
    onSuccess: () => {
      toast.success(t('byok.saved', { upstream: upstream.name }));
      onSaved?.();
    },
  });
  const saving = useIsMutating({ mutationKey }) > 0;
  const last = useMutationState({ filters: { mutationKey }, select: (m) => m.state }).at(-1);
  const refused = last?.status === 'error' && last.submittedAt > clearedAt ? last.error : undefined;
  const refusal = refused === undefined ? null : refusalText(refused, t);
  const lastSubmittedAt = last?.submittedAt ?? 0;
  const save = React.useCallback(
    (key: string): void => {
      if (key.trim() === '') {
        setTypedError(t('byok.keyEmpty'));
        return;
      }
      setTypedError(null);
      mutate(key);
    },
    [mutate, t],
  );
  const clearError = React.useCallback((): void => {
    setTypedError(null);
    setClearedAt(lastSubmittedAt);
  }, [lastSubmittedAt]);
  return { save, saving, error: typedError ?? refusal, clearError };
}

/**
 * The key field both the add form and the replace dialog use.
 * @param props - The field's state.
 * @param props.value - What the field shows.
 * @param props.onChange - Called as the user types.
 * @param props.error - The refusal to show under it.
 * @param props.saving - Whether a save is out.
 * @param props.children - What sits beside the input (the add form's Save).
 * @returns The field.
 */
function KeyField({
  value,
  onChange,
  error,
  saving,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  saving: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const errorId = React.useId();
  return (
    <div className='flex flex-col gap-1.5'>
      <Label htmlFor={id}>{t('byok.keyLabel')}</Label>
      <div className='flex items-start gap-2'>
        <div className='flex-1'>
          <PasswordInput
            id={id}
            autoComplete='off'
            placeholder={t('byok.keyPlaceholder')}
            showLabel={t('byok.showKey')}
            hideLabel={t('byok.hideKey')}
            value={value}
            readOnly={saving}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
        {children}
      </div>
      {error !== null ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * The right column: one upstream, with its key or the form to add one, and the models it runs.
 * @param props - The upstream and what it needs.
 * @param props.upstream - The upstream.
 * @param props.saved - Its saved key, when the account has one.
 * @param props.entries - Every model of the catalog.
 * @param props.models - The account's model choices.
 * @returns The detail.
 */
function UpstreamDetail({
  upstream,
  saved,
  entries,
  models,
}: {
  upstream: ByokUpstream;
  saved: ByokSavedKey | undefined;
  entries: ModelEntry[];
  models: ByokView['models'];
}): React.JSX.Element {
  const t = useTranslation();
  const id = upstream.upstream;
  const runs = React.useMemo(
    () => entries.filter((entry) => entry.availability.upstreams.some((u) => u.upstream === id)),
    [entries, id],
  );
  const runsByModality = BYOK_MODALITIES.map((modality) => [modality, runs.filter((m) => m.modality === modality)] as const)
    .filter(([, list]) => list.length > 0);
  const tag = upstream.kind === 'llm'
    ? t('byok.groupLanguageModel')
    : runsByModality.map(([modality]) => t(`byok.modality.${modality}`)).join(' · ');

  const link = upstream.keyUrl === null ? null : (
    <a
      href={upstream.keyUrl}
      target='_blank'
      rel='noreferrer'
      className='inline-flex w-fit items-center gap-0.5 text-xs underline underline-offset-2'
    >
      {t('byok.getKey', { upstream: upstream.name })}<ExternalLink className='h-3 w-3' aria-hidden='true' />
    </a>
  );

  return (
    <div className='flex flex-col gap-5 p-4' data-testid={`byok-detail-${id}`}>
      <div className='flex flex-col gap-3'>
        <div className='flex items-center gap-2'>
          <span className='text-md font-semibold'>{upstream.name}</span>
          {tag === '' ? null : <span className='rounded-chrome-sm bg-chip px-1.5 py-px text-2xs text-muted-foreground'>{tag}</span>}
          {saved === undefined ? null : <SavedKeyActions upstream={upstream} models={models} entries={entries} />}
        </div>
        {saved === undefined ? <AddKeyForm upstream={upstream} /> : <SavedKeyState saved={saved} kind={upstream.kind} />}
        {link}
      </div>
      <div className='flex flex-col gap-2 border-t border-border pt-4'>
        <span className='text-sm font-medium leading-none'>{t('byok.runsModels')}</span>
        {upstream.kind === 'llm' ? (
          <p className='text-xs text-muted-foreground'>{t('byok.openrouterNote')}</p>
        ) : runsByModality.length === 0 ? (
          <p className='text-xs text-muted-foreground'>{t('byok.runsNone')}</p>
        ) : (
          runsByModality.map(([modality, list]) => (
            <div key={modality} className='flex flex-col gap-1.5'>
              <span className='flex gap-1 text-xs text-muted-foreground'>
                {t(`byok.modality.${modality}`)}
                <span className='tabular-nums'>{list.length}</span>
              </span>
              <div className='flex flex-wrap gap-1'>
                {list.map((m) => (
                  <span key={m.name} className='rounded-chrome-sm bg-chip px-1.5 py-0.5 text-xs'>{modelLabel(m, list)}</span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * A saved key: its hint, whether it connected, when it was checked, its balance or why it failed, and whether it can
 * read the actual costs of its calls.
 * @param props - The key.
 * @param props.saved - The saved key.
 * @param props.kind - The upstream's group.
 * @returns The lines.
 */
function SavedKeyState({ saved, kind }: { saved: ByokSavedKey; kind: ByokUpstreamKind }): React.JSX.Element {
  const t = useTranslation();
  const checked = checkedText(saved.lastCheckedAt, t);
  const costsUnreadable = saved.costsReadable === false;
  // A key that reads neither says so once, with what to do.
  const bothUnreadable = saved.lastConnected && saved.lastBalanceState === 'forbidden' && costsUnreadable;
  const balance = !saved.lastConnected ? null : bothUnreadable ? t('byok.balanceAndCostsUnreadable') : balanceText(saved, kind, t);
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <code className='font-mono text-foreground-secondary'>{saved.displayHint}</code>
        <Badge
          variant={saved.lastConnected ? 'outline' : 'destructive'}
          className={cn(
            'rounded-chrome-sm px-1.5 py-px font-medium',
            saved.lastConnected && 'border-status-success-border bg-status-success-bg text-foreground',
          )}
        >
          {saved.lastConnected ? t('byok.connected') : t('byok.notConnected')}
        </Badge>
        <span className='text-muted-foreground'>{checked}</span>
      </div>
      {balance === null ? null : <p className='text-xs text-muted-foreground'>{balance}</p>}
      {costsUnreadable && !bothUnreadable ? <p className='text-xs text-muted-foreground'>{t('byok.costsUnreadable')}</p> : null}
      {saved.lastConnected ? null : <p className='text-xs text-status-error-foreground'>{failureText(saved.lastFailure, t)}</p>}
    </div>
  );
}

/**
 * When a key was last checked, in the user's locale: the time alone for a check made today, the date with no year
 * for another day this year, and the year as well for an earlier year.
 * @param at - The check's instant, ISO.
 * @param t - The translator.
 * @returns The sentence.
 */
function checkedText(at: string, t: Translate): string {
  const when = new Date(at);
  const locale = getLocale();
  const now = new Date();
  if (when.toDateString() === now.toDateString()) {
    return t('byok.lastCheckedToday', { time: when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) });
  }
  const year = when.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return t('byok.lastChecked', { time: when.toLocaleString(locale, { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
}

/**
 * The form for an upstream without a key: saved only once it connects.
 * @param props - The upstream.
 * @param props.upstream - The upstream.
 * @returns The form.
 */
function AddKeyForm({ upstream }: { upstream: ByokUpstream }): React.JSX.Element {
  const t = useTranslation();
  const [value, setValue] = React.useState('');
  const { save, saving, error, clearError } = useSaveKey(upstream, 'add');
  const change = React.useCallback((next: string): void => {
    setValue(next);
    clearError();
  }, [clearError]);
  return (
    <form
      className='flex flex-col gap-1.5'
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <KeyField value={value} onChange={change} error={error} saving={saving}>
        <Button type='submit' size='form' loading={saving}>{t('byok.save')}</Button>
      </KeyField>
      <p className='text-xs text-muted-foreground'>{t('byok.saveHint')}</p>
    </form>
  );
}

/**
 * Refresh, Replace and Delete for a saved key, with the replace and delete dialogs they open.
 * @param props - The upstream and what the delete warning lists.
 * @param props.upstream - The upstream.
 * @param props.models - The account's model choices.
 * @param props.entries - Every model of the catalog, for display names.
 * @returns The buttons and their dialogs.
 */
function SavedKeyActions({
  upstream,
  models,
  entries,
}: {
  upstream: ByokUpstream;
  models: ByokView['models'];
  entries: ModelEntry[];
}): React.JSX.Element {
  const t = useTranslation();
  const client = useQueryClient();
  const id = upstream.upstream;
  const [replacing, setReplacing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // Keyed by upstream, so the wait survives switching to another upstream and back.
  const checkKey = ['byok', 'check', id] as const;
  const check = useMutation({
    mutationKey: checkKey,
    // Read again either way, and before the result shows: a key deleted in another tab fails the check and leaves the list.
    mutationFn: () => byokApi.checkKey(id).finally(() => rereadByok(client)),
    // A key deleted meanwhile (404) is gone from the list once read again, which is all there is to say.
    onError: (err) => {
      if (!(err instanceof ApiException && err.status === 404)) toast.error(t('byok.checkFailed'));
    },
  });
  const refreshing = useIsMutating({ mutationKey: checkKey }) > 0;

  const remove = useMutation({
    // A key already gone (deleted in another tab) is what the delete was for, so a 404 reads as deleted.
    mutationFn: () =>
      byokApi.deleteKey(id)
        .catch((err: unknown) => {
          if (!(err instanceof ApiException && err.status === 404)) throw err;
        })
        .finally(() => rereadByok(client)),
    onSuccess: () => {
      forgetFinishedSaves(client, id);
      setDeleting(false);
      toast.success(t('byok.deleted', { upstream: upstream.name }));
    },
    onError: () => toast.error(t('byok.deleteFailed')),
  });

  const set = models.filter((m) => m.upstream === id).map((m) => m.model);
  const known = entries.filter((entry) => set.includes(entry.name));
  // Each named the way the generation panel names it among the others listed; a model the catalog lost keeps its id.
  const affected = set.map((model) => {
    const entry = known.find((e) => e.name === model);
    return entry === undefined ? model : modelLabel(entry, known);
  });

  return (
    <div className='ml-auto flex items-center gap-1.5'>
      <Button type='button' variant='outline' size='sm' loading={refreshing} onClick={() => check.mutate()}>
        {t('byok.refresh')}
      </Button>
      <Button type='button' variant='outline' size='sm' disabled={refreshing} onClick={() => {
        forgetFinishedSaves(client, id);
        setReplacing(true);
      }}>
        {t('byok.replace')}
      </Button>
      <Button type='button' variant='outline' size='sm' disabled={refreshing} onClick={() => setDeleting(true)}>
        {t('byok.delete')}
      </Button>
      <ReplaceKeyDialog upstream={upstream} open={replacing} onOpenChange={setReplacing} />
      <AlertDialog open={deleting} onOpenChange={(next) => { if (!remove.isPending) setDeleting(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('byok.deleteTitle', { upstream: upstream.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {upstream.kind === 'llm' ? t('byok.deleteBodyLanguage', { upstream: upstream.name }) : t('byok.deleteBody', { upstream: upstream.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {affected.length > 0 ? (
            <ul className='list-disc pl-5 text-xs text-muted-foreground'>
              {affected.map((name) => <li key={name}>{name}</li>)}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              loading={remove.isPending}
              onClick={(event) => {
                // Stays open while the request is out; success closes it.
                event.preventDefault();
                remove.mutate();
              }}
            >
              {t('byok.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Replacing a saved key: the new one is checked first, and a refusal keeps the old key and the dialog.
 * @param props - The upstream and open state.
 * @param props.upstream - The upstream.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Called when it opens or closes.
 * @returns The dialog.
 */
function ReplaceKeyDialog({
  upstream,
  open,
  onOpenChange,
}: {
  upstream: ByokUpstream;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const saving = useIsMutating({ mutationKey: saveKeyOf(upstream.upstream) }) > 0;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent>
        {/* Mounted only while open, so every opening starts on an empty field. */}
        <ReplaceKeyForm upstream={upstream} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The replace dialog's form.
 * @param props - The upstream and how to close.
 * @param props.upstream - The upstream.
 * @param props.onOpenChange - Closes the dialog.
 * @returns The form.
 */
function ReplaceKeyForm({
  upstream,
  onOpenChange,
}: {
  upstream: ByokUpstream;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const t = useTranslation();
  const [value, setValue] = React.useState('');
  const close = React.useCallback((): void => onOpenChange(false), [onOpenChange]);
  const { save, saving, error, clearError } = useSaveKey(upstream, 'replace', close);
  const change = React.useCallback((next: string): void => {
    setValue(next);
    clearError();
  }, [clearError]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(value);
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('byok.replaceTitle', { upstream: upstream.name })}</DialogTitle>
        <DialogDescription>{t('byok.replaceBody', { upstream: upstream.name })}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <KeyField value={value} onChange={change} error={error} saving={saving} />
      </DialogBody>
      <DialogFooter>
        <Button type='button' variant='outline' disabled={saving} onClick={close}>{t('common.cancel')}</Button>
        <Button type='submit' loading={saving}>{t('byok.save')}</Button>
      </DialogFooter>
    </form>
  );
}
