/**
 * Dev-only primitives gallery — token verify surface.
 *
 * Step 2 of visual alignment: render every shadcn primitive + canvas
 * node states using the consolidated tokens.css, so the user can compare
 * against the inner-design `shadcn-primitives-20260518/finalized.html`
 * mock side-by-side.
 *
 * Route: `/dev/primitives` (guarded by `import.meta.env.DEV` in routes.tsx).
 * Not part of the production user surface — included for visual QA only.
 */
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@web/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { ScrollArea } from '@web/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Separator } from '@web/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@web/components/ui/sheet';
import { Skeleton } from '@web/components/ui/skeleton';
import { Textarea } from '@web/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@web/components/ui/tooltip';

import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { ReferenceChip } from '@web/spaces/canvas/reference-chips/ReferenceChip';

import { usePreferencesStore } from '@web/stores';

export default function PrimitivesGallery() {
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <TooltipProvider>
      <div className='min-h-screen bg-background p-6 text-foreground'>
        <header className='mx-auto mb-6 flex max-w-5xl items-center justify-between'>
          <div>
            <h1 className='text-xl font-semibold'>
              Primitives gallery — token verify
            </h1>
            <p className='text-sm text-muted-foreground'>
              Compare against inner `chrome-baseline-20260518` /
              `shadcn-primitives-20260518` mock.
            </p>
          </div>
          <Button
            variant='outline'
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            Switch to {theme === 'light' ? 'dark' : 'light'}
          </Button>
        </header>

        <main className='mx-auto flex max-w-5xl flex-col gap-8'>
          <Section title='Button · variant × size'>
            <div className='flex flex-wrap items-end gap-2'>
              {(
                ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
              ).map((v) => (
                <Button key={v} variant={v}>
                  {v}
                </Button>
              ))}
            </div>
            <div className='mt-2 flex flex-wrap items-end gap-2'>
              {(['default', 'sm', 'lg', 'icon'] as const).map((s) => (
                <Button key={s} size={s}>
                  {s === 'icon' ? '⚡' : s}
                </Button>
              ))}
            </div>
          </Section>

          <Section title='Badge · variants'>
            <div className='flex flex-wrap gap-2'>
              <Badge>default</Badge>
              <Badge variant='secondary'>secondary</Badge>
              <Badge variant='outline'>outline</Badge>
              <Badge variant='destructive'>destructive</Badge>
            </div>
          </Section>

          <Section title='Input / Textarea / Label / Select'>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <div>
                <Label htmlFor='g-input'>Name</Label>
                <Input id='g-input' placeholder='Untitled' />
              </div>
              <div>
                <Label htmlFor='g-select'>Type</Label>
                <Select>
                  <SelectTrigger id='g-select'>
                    <SelectValue placeholder='Pick a type' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='a'>Option A</SelectItem>
                    <SelectItem value='b'>Option B</SelectItem>
                    <SelectItem value='c'>Option C</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className='mt-3'>
              <Label htmlFor='g-textarea'>Notes</Label>
              <Textarea id='g-textarea' rows={3} placeholder='Write something' />
            </div>
          </Section>

          <Section title='Avatar · 5 sizes'>
            <div className='flex items-end gap-3'>
              {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((sz) => (
                <div key={sz} className='flex flex-col items-center gap-1'>
                  <Avatar
                    style={{
                      height: `var(--avatar-${sz})`,
                      width: `var(--avatar-${sz})`,
                    }}
                  >
                    <AvatarFallback>U</AvatarFallback>
                  </Avatar>
                  <span className='text-[10px] text-muted-foreground'>{sz}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section title='Separator · h + v'>
            <div className='flex h-12 items-center gap-3'>
              <span>Left</span>
              <Separator orientation='vertical' />
              <span>Right</span>
            </div>
            <Separator className='mt-2' />
          </Section>

          <Section title='Skeleton · loading'>
            <div className='space-y-2'>
              <Skeleton className='h-4 w-1/2' />
              <Skeleton className='h-4 w-3/4' />
              <Skeleton className='h-4 w-2/3' />
            </div>
          </Section>

          <Section title='Tooltip · Popover · Dialog · AlertDialog · Sheet'>
            <div className='flex flex-wrap gap-2'>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant='outline'>Tooltip</Button>
                </TooltipTrigger>
                <TooltipContent>Hello tooltip</TooltipContent>
              </Tooltip>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant='outline'>Popover</Button>
                </PopoverTrigger>
                <PopoverContent>Popover body content.</PopoverContent>
              </Popover>

              <Dialog>
                <DialogTrigger asChild>
                  <Button variant='outline'>Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog title</DialogTitle>
                    <DialogDescription>
                      Dialog body content for visual check.
                    </DialogDescription>
                  </DialogHeader>
                </DialogContent>
              </Dialog>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant='destructive'>AlertDialog</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm action?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Destructive action, cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction>Confirm</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <Sheet>
                <SheetTrigger asChild>
                  <Button variant='outline'>Sheet</Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Sheet title</SheetTitle>
                    <SheetDescription>Right-side sheet body.</SheetDescription>
                  </SheetHeader>
                </SheetContent>
              </Sheet>
            </div>
          </Section>

          <Section title='ScrollArea'>
            <ScrollArea className='h-24 w-full rounded-md border border-border p-2'>
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} className='py-1 text-sm'>
                  Row {i + 1}
                </div>
              ))}
            </ScrollArea>
          </Section>

          <Section title='Status palette · 7 × 3-piece (bg / fg / border)'>
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3'>
              {(
                [
                  'selected',
                  'info',
                  'handling',
                  'locked',
                  'warning',
                  'error',
                  'success',
                ] as const
              ).map((name) => (
                <div
                  key={name}
                  className='rounded-content-md border p-3 text-sm'
                  style={{
                    background: `var(--status-${name}-bg)`,
                    color: `var(--status-${name}-fg)`,
                    borderColor: `var(--status-${name}-border)`,
                  }}
                >
                  status · {name}
                </div>
              ))}
            </div>
          </Section>

          <Section title='Canvas node states · NodeShell ring + content states'>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3'>
              {(['idle', 'handling', 'error'] as const).map((status) => (
                <NodeShell
                  key={status}
                  status={status}
                  className='w-full'
                  testId={`shell-${status}`}
                >
                  <NodeContent
                    status={status}
                    errorMessage='Demo error message'
                    hasContent={status === 'idle'}
                    placeholder={<NodePlaceholder modality='image' />}
                    content={
                      <div className='p-3 text-xs'>
                        idle content
                      </div>
                    }
                  />
                </NodeShell>
              ))}
              <NodeShell selected className='w-full' testId='shell-selected'>
                <div className='p-3 text-xs'>selected · primary ring</div>
              </NodeShell>
              <NodeShell locked className='w-full' testId='shell-locked'>
                <div className='p-3 text-xs'>locked · indicator top-right</div>
              </NodeShell>
            </div>
          </Section>

          <Section title='Reference chips · 4 modalities × remove'>
            <div className='flex flex-wrap gap-2'>
              <ReferenceChip modality='text' label='outline.txt' />
              <ReferenceChip modality='image' label='cover.jpg' onRemove={() => {}} />
              <ReferenceChip modality='audio' label='bgm.mp3' onRemove={() => {}} />
              <ReferenceChip modality='video' label='intro.mp4' />
            </div>
          </Section>

          <Section title='Radius scale · chrome (fixed) + content (Tweaks-linked)'>
            <div className='flex flex-wrap items-end gap-2'>
              {[
                ['radius-chrome', 'chrome'],
                ['radius-content-sm', 'sm'],
                ['radius-content-md', 'md'],
                ['radius-content-lg', 'lg'],
                ['radius-content-xl', 'xl'],
              ].map(([cssVar, label]) => (
                <div
                  key={cssVar}
                  className='flex h-16 w-20 items-center justify-center border border-border bg-card text-xs'
                  style={{ borderRadius: `var(--${cssVar})` }}
                >
                  {label}
                </div>
              ))}
            </div>
          </Section>

          <Section title='Brand · logo only'>
            <div
              className='flex h-12 w-12 items-center justify-center rounded-content-sm text-sm font-semibold text-white'
              style={{ background: 'var(--brand-logo-primary)' }}
            >
              B
            </div>
            <p className='mt-2 text-xs text-muted-foreground'>
              `--brand-logo-primary` (only allowed brand use; chrome stays
              neutral).
            </p>
          </Section>
        </main>
      </div>
    </TooltipProvider>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className='rounded-content-md border border-border bg-card p-4'>
      <h2 className='mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground'>
        {title}
      </h2>
      {children}
    </section>
  );
}
