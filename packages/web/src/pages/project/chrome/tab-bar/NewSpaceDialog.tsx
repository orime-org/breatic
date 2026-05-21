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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SPACE_TYPE_LIST, type SpaceType } from '@/spaces';

interface NewSpaceDialogProps {
  trigger: React.ReactNode;
  /**
   * Returns a promise when the create call is async (calls
   * `spacesApi.create` + writes to Yjs). The dialog disables the form
   * while the promise is in flight and shows the error message inline
   * if the call rejects.
   */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
}

/**
 * New-space dialog — picks a space type + accepts a name, then
 * delegates the actual create call to the page (which combines
 * `spacesApi.create` REST + Yjs `appendSpace` in one mutation).
 */
export function NewSpaceDialog({ trigger, onCreate }: NewSpaceDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<SpaceType>('canvas');
  const [name, setName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
        // Block closing while a create is in flight.
        if (!next && submitting) return;
        if (!next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid='new-space-dialog'>
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            Pick a space type and give it a short name.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className='space-y-1'>
            <Label htmlFor='new-space-type'>Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as SpaceType)}
              disabled={submitting}
            >
              <SelectTrigger id='new-space-type'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPACE_TYPE_LIST.map((s) => (
                  <SelectItem key={s.type} value={s.type}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label htmlFor='new-space-name'>Name</Label>
            <Input
              id='new-space-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='untitled'
              data-testid='new-space-name'
              disabled={submitting}
              autoFocus
            />
          </div>
          {error ? (
            <div className='text-sm text-status-error-fg' data-testid='new-space-error'>
              {error}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant='ghost'
            onClick={() => {
              if (submitting) return;
              reset();
              setOpen(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={name.trim().length === 0 || submitting}
            data-testid='new-space-submit'
          >
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
