import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
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
  onCreate: (type: SpaceType, name: string) => void;
}

/**
 * New-space dialog — picks a space type (canvas / document / timeline)
 * and accepts a name, then delegates creation to the project page so the
 * dialog stays UI-only (Yjs mutation lives outside).
 */
export function NewSpaceDialog({ trigger, onCreate }: NewSpaceDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<SpaceType>('canvas');
  const [name, setName] = React.useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onCreate(type, trimmed);
    setName('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid='new-space-dialog'>
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            Pick a space type and give it a short name.
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-3'>
          <div className='space-y-1'>
            <Label htmlFor='new-space-type'>Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as SpaceType)}
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
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={name.trim().length === 0}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
