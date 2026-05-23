import { Clock, FileText, Palette } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SPACE_TYPE_LIST, type SpaceType } from '@/spaces';
import { useTranslation } from '@/i18n/use-translation';

interface NewSpaceDialogProps {
  trigger: React.ReactNode;
  /**
   * Returns a promise when the create call is async (the parent
   * routes through `sendSpaceRpc({ type: 'space:create' })`). The
   * dialog disables the form while the promise is in flight and
   * shows the error message inline if the call rejects.
   */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
}

interface TypeCardMeta {
  type: SpaceType;
  icon: typeof Palette;
  titleKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline';
  subtitleKey:
    | 'spaces.kind.canvasSub'
    | 'spaces.kind.documentSub'
    | 'spaces.kind.timelineSub';
  /**
   * V1 only ships `canvas`; document + timeline are visually present
   * but disabled with a "not available" label per decision D (2026-05-21).
   */
  available: boolean;
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    icon: Palette,
    titleKey: 'spaces.kind.canvas',
    subtitleKey: 'spaces.kind.canvasSub',
    available: true,
  },
  {
    type: 'document',
    icon: FileText,
    titleKey: 'spaces.kind.document',
    subtitleKey: 'spaces.kind.documentSub',
    available: false,
  },
  {
    type: 'timeline',
    icon: Clock,
    titleKey: 'spaces.kind.timeline',
    subtitleKey: 'spaces.kind.timelineSub',
    available: false,
  },
];

/**
 * New-space dialog — picks a Space type via a 3-card segmented control
 * (canvas / document / timeline), accepts a name, then delegates the
 * actual create call to the page (which sends `space:create` RPC over
 * the live meta-doc Hocuspocus connection + waits for the broadcast
 * back).
 *
 * Per decision D (2026-05-21): all three cards are visible so the
 * product roadmap is legible, but document + timeline are disabled
 * with "not available" until those Space types ship. Only canvas is
 * selectable.
 *
 * Mock alignment: mirrors `.type-segmented` (finalized.html lines
 * 1428-1432) — flex row of 3 cards, active card uses brand border on
 * the mock but per ADR 14 brand-guard we use `border-foreground +
 * bg-accent` instead (neutral CTA).
 *
 * The `SPACE_TYPE_LIST` registry is consulted to surface only types
 * the runtime actually knows about (forward-compat safety against the
 * registry pruning a type the dialog still lists).
 */
export function NewSpaceDialog({ trigger, onCreate }: NewSpaceDialogProps) {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<SpaceType>('canvas');
  const [name, setName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const registry = React.useMemo(
    () => new Set(SPACE_TYPE_LIST.map((s) => s.type)),
    [],
  );
  const cards = TYPE_CARDS.filter((c) => registry.has(c.type));

  const reset = () => {
    setName('');
    setType('canvas');
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(type, trimmed);
      reset();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create space');
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        if (!next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid='new-space-dialog'>
        <DialogHeader>
          <DialogTitle>{t('spaces.create.title')}</DialogTitle>
          <DialogDescription>{t('spaces.create.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-col gap-2'>
            <Label>{t('spaces.create.typeLabel')}</Label>
            <div
              className='flex gap-2'
              role='radiogroup'
              aria-label={t('spaces.create.typeAria')}
              data-testid='new-space-type-segmented'
            >
              {cards.map((card) => {
                const Icon = card.icon;
                const selected = type === card.type;
                return (
                  <button
                    key={card.type}
                    type='button'
                    role='radio'
                    aria-checked={selected}
                    aria-disabled={!card.available || submitting}
                    disabled={!card.available || submitting}
                    onClick={() => card.available && setType(card.type)}
                    data-testid={`new-space-type-${card.type}`}
                    className={cn(
                      'flex flex-1 flex-col items-center gap-2 rounded-chrome border px-3 py-3 text-center transition-colors',
                      selected
                        ? 'border-active-border bg-accent text-foreground'
                        : 'border-border bg-transparent text-foreground',
                      card.available
                        ? 'hover:bg-muted'
                        : 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-7 w-7',
                        selected ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    />
                    <span className='text-[13px] font-medium'>
                      {t(card.titleKey)}
                    </span>
                    <span className='text-[11px] text-muted-foreground'>
                      {t(card.subtitleKey)}
                    </span>
                    {!card.available ? (
                      <span className='rounded-[4px] bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground'>
                        {t('spaces.create.notAvailable')}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div className='flex flex-col gap-2'>
            <Label htmlFor='new-space-name'>{t('spaces.create.nameLabel')}</Label>
            <Input
              id='new-space-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('spaces.create.namePlaceholder')}
              data-testid='new-space-name'
              disabled={submitting}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog first input; users open the dialog expecting to type a name immediately
              autoFocus
            />
          </div>
          {error ? (
            <div
              className='text-sm text-status-error-foreground'
              data-testid='new-space-error'
            >
              {error}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              if (submitting) return;
              reset();
              setOpen(false);
            }}
            disabled={submitting}
          >
            {t('spaces.create.cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={name.trim().length === 0 || submitting}
            data-testid='new-space-submit'
          >
            {submitting
              ? t('spaces.create.submitting')
              : t('spaces.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
