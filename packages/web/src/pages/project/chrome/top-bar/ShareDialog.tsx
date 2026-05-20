import { Share2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ShareDialogProps {
  projectId: string;
}

/**
 * Share dialog — opens a modal with the project's invite link + role
 * selection. PR 4 renders the dialog structure with a placeholder invite
 * URL; real invite token generation arrives with the project-members API
 * wiring in a later PR.
 */
export function ShareDialog({ projectId }: ShareDialogProps) {
  const inviteUrl = `https://breatic.ai/invite/${projectId}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant='chrome-ghost' size='chrome' aria-label='Share'>
          <Share2 className='h-[18px] w-[18px]' />
        </Button>
      </DialogTrigger>
      <DialogContent data-testid='share-dialog'>
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>
            Anyone with the link can join — pick a default role first.
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-2'>
          <Label htmlFor='invite-url'>Invite URL</Label>
          <Input
            id='invite-url'
            readOnly
            value={inviteUrl}
            data-testid='invite-url'
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
