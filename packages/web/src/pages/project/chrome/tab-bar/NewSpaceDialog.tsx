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

interface NewSpaceDialogProps {
  trigger: React.ReactNode;
  /**
   * Returns a promise when the create call is async (calls
   * `spacesApi.create` HTTP + the server-driven event flow). The
   * dialog disables the form while the promise is in flight and
   * shows the error message inline if the call rejects.
   */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
}

interface TypeCardMeta {
  type: SpaceType;
  icon: typeof Palette;
  title: string;
  subtitle: string;
  /**
   * V1 only ships `canvas`; document + timeline are visually present
   * but disabled with a "未实现" label per decision D (2026-05-21).
   */
  available: boolean;
}

const TYPE_CARDS: ReadonlyArray<TypeCardMeta> = [
  {
    type: 'canvas',
    icon: Palette,
    title: '画布',
    subtitle: '无限画布 + 节点',
    available: true,
  },
  {
    type: 'document',
    icon: FileText,
    title: '文档',
    subtitle: '富文本 + 协作',
    available: false,
  },
  {
    type: 'timeline',
    icon: Clock,
    title: '时间线',
    subtitle: '视频 / 音频剪辑',
    available: false,
  },
];

/**
 * New-space dialog — picks a Space type via a 3-card segmented control
 * (画布 / 文档 / 时间线), accepts a name, then delegates the actual
 * create call to the page (which calls `spacesApi.create` + waits for
 * the collab-driven Y.Doc broadcast to add the tab, per K.1).
 *
 * Per decision D (2026-05-21): all three cards are visible so the
 * product roadmap is legible, but document + timeline are disabled
 * with "未实现" until those Space types ship. Only canvas is selectable.
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
          <DialogTitle>新建 Space</DialogTitle>
          <DialogDescription>选 Space 类型 + 命名</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className='flex flex-col gap-2'>
            <Label>类型</Label>
            <div
              className='flex gap-2'
              role='radiogroup'
              aria-label='Space 类型'
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
                        ? 'border-foreground bg-accent text-foreground'
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
                      {card.title}
                    </span>
                    <span className='text-[11px] text-muted-foreground'>
                      {card.subtitle}
                    </span>
                    {!card.available ? (
                      <span className='rounded-[4px] bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground'>
                        未实现
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div className='flex flex-col gap-2'>
            <Label htmlFor='new-space-name'>名称</Label>
            <Input
              id='new-space-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='例:Cyberpunk Concept'
              data-testid='new-space-name'
              disabled={submitting}
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
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={name.trim().length === 0 || submitting}
            data-testid='new-space-submit'
          >
            {submitting ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
