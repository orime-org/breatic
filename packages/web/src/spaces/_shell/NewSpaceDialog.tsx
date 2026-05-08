/**
 * NewSpaceDialog — modal for creating a new Space inside a project.
 *
 * V1 only canvas Spaces are creatable end-to-end; document and
 * timeline kinds are listed in the kind picker but flagged as
 * "coming soon" — picking them disables the Create button. The
 * UX surfaces the limitation rather than hiding the kinds entirely
 * so users can see the v10 spec direction.
 *
 * Server flow:
 *   1. Caller invokes `projectSpacesApi.create({ type, name })`
 *   2. Server validates permission + writes nothing to PG (Spaces
 *      have no PG table) — generates spaceId, publishes Redis
 *      `space:created` event.
 *   3. Collab `members-sync` consumer applies
 *      `meta.spaces[spaceId] = {...}` to the project's meta doc.
 *   4. Frontend's `useProjectMeta` observer surfaces the new tab
 *      ~50-200ms later via Yjs sync.
 *
 * The dialog only awaits step 1 (the API 201) — the new tab arrives
 * via Yjs, not via our awaited promise, so we close immediately
 * after the API resolves and let the Tab Bar show the tab when it's
 * ready.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpaceType } from '@breatic/shared';
import Dialog from '@/ui/dialog';
import * as projectSpacesApi from '@/data/api/project-spaces';
import { cn } from '@/utils/classnames';

const TXT_BASE = 'text-[var(--color-text-default-base)]';
const TXT_SECONDARY = 'text-[var(--color-text-default-secondary)]';
const TXT_TERTIARY = 'text-[var(--color-text-default-tertiary)]';
const TXT_ERROR = 'text-[var(--color-text-status-error)]';
const BG_BASE = 'bg-[var(--color-background-default-base)]';
const BORDER_BASE = 'border-[var(--color-border-default-base)]';

export interface NewSpaceDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  /** Initial kind preselected when the dialog opens. */
  defaultKind?: SpaceType;
  /**
   * Optional callback invoked after the API 201 resolves with the
   * new spaceId. Useful when the caller wants to update local
   * `useTabState` immediately (open the new tab) before the Yjs
   * sync arrives.
   */
  onCreated?: (spaceId: string, kind: SpaceType) => void;
}

const KIND_OPTIONS: { kind: SpaceType; supported: boolean }[] = [
  { kind: 'canvas', supported: true },
  { kind: 'document', supported: false },
  { kind: 'timeline', supported: false },
];

const NewSpaceDialog: React.FC<NewSpaceDialogProps> = ({
  open,
  onClose,
  projectId,
  defaultKind = 'canvas',
  onCreated,
}) => {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SpaceType>(defaultKind);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKind(defaultKind);
      setName('');
      setError(null);
      setPending(false);
    }
  }, [open, defaultKind]);

  const selectedSupported = KIND_OPTIONS.find((o) => o.kind === kind)?.supported ?? false;
  const canCreate = !!projectId && selectedSupported && name.trim().length > 0 && !pending;

  const handleCreate = async () => {
    if (!projectId || !canCreate) return;
    setPending(true);
    setError(null);
    try {
      const res = await projectSpacesApi.create(projectId, {
        type: kind,
        name: name.trim(),
      });
      const spaceId = (res as unknown as { data?: { id?: string } })?.data?.id;
      if (spaceId) {
        onCreated?.(spaceId, kind);
      }
      onClose();
    } catch (e) {
      setError((e as Error)?.message || 'Create failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      show={open}
      onClose={onClose}
      title={t('spaces.new_dialog.title')}
      width={520}
    >
      <p className={cn('text-[13px] mb-4', TXT_SECONDARY)}>
        {t('spaces.new_dialog.subtitle')}
      </p>

      <div className="grid grid-cols-3 gap-2 mb-5">
        {KIND_OPTIONS.map(({ kind: k, supported }) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              'relative border rounded-md p-3 text-left transition-colors',
              kind === k
                ? 'border-brand-base bg-brand-50'
                : cn(BORDER_BASE, BG_BASE, 'hover:border-brand-300'),
              !supported && 'opacity-70',
            )}
          >
            <div className={cn('text-[13px] font-semibold mb-0.5', TXT_BASE)}>
              {t(`spaces.tab.kind_${k}`)}
            </div>
            <div className={cn('text-[10px] font-mono uppercase', TXT_TERTIARY)}>
              {supported ? k : 'coming soon'}
            </div>
          </button>
        ))}
      </div>

      <div className="mb-5">
        <label className={cn('block text-[11px] uppercase tracking-wider mb-1.5', TXT_SECONDARY)}>
          {t('spaces.new_dialog.name_label')}
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) handleCreate();
          }}
          placeholder={t('spaces.new_dialog.name_placeholder')}
          disabled={pending}
          autoFocus
          className={cn(
            'w-full h-9 px-3 border rounded-md text-[13px] outline-none transition',
            BG_BASE,
            BORDER_BASE,
            TXT_BASE,
            'placeholder:text-[var(--color-text-default-tertiary)]',
            'focus:border-brand-base focus:ring-2 focus:ring-brand-base/15',
          )}
        />
      </div>

      {!selectedSupported && (
        <div className={cn('mb-3 text-[12px]', TXT_TERTIARY)}>
          {t('spaces.new_dialog.placeholder_kind_unsupported', {
            kind: t(`spaces.tab.kind_${kind}`),
          })}
        </div>
      )}

      {error && <div className={cn('mb-3 text-[12px]', TXT_ERROR)}>{error}</div>}

      <div className={cn('flex items-center justify-end gap-2 pt-2 border-t', BORDER_BASE)}>
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          className={cn(
            'h-8 px-4 border rounded-md text-[13px]',
            BG_BASE,
            BORDER_BASE,
            TXT_BASE,
            'hover:bg-[var(--color-background-default-secondary)] transition-colors',
            pending && 'opacity-50',
          )}
        >
          {t('spaces.new_dialog.cancel')}
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={!canCreate}
          className="h-8 px-4 bg-brand-base text-text-on-button-base rounded-md text-[13px] font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('spaces.new_dialog.create')}
        </button>
      </div>
    </Dialog>
  );
};

export default NewSpaceDialog;
