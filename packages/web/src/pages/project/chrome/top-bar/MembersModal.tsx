import { Send } from 'lucide-react';
import * as React from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useUIStore } from '@/stores';

import type { Member, MemberRole } from '@/pages/project/chrome/top-bar/MembersStack';

interface MembersModalProps {
  members?: ReadonlyArray<Member>;
}

const STUB_MEMBERS: ReadonlyArray<Member> = [
  { id: 'me', name: 'Songxiu Lei', initials: 'SX', role: 'owner', isMe: true },
  { id: 'yj', name: 'Yuki Jia', initials: 'YJ', role: 'editor' },
  { id: 'dm', name: 'Diana Marquez', initials: 'DM', role: 'editor' },
  { id: 'rt', name: 'Ryo Tanaka', initials: 'RT', role: 'viewer' },
  { id: 'pl', name: 'Priya Lokesh', initials: 'PL', role: 'viewer' },
];

const ROLE_OPTIONS: ReadonlyArray<{ value: MemberRole; label: string }> = [
  { value: 'editor', label: '编辑' },
  { value: 'viewer', label: '只读' },
];

/**
 * Members management modal — opened by the "查看完整管理" button inside
 * `<MembersStack>`'s popover, controlled by `useUIStore.membersModalOpen`.
 *
 * Layout (mock `.modal-dialog#members-modal-title`):
 *   header: 协作者管理 + desc
 *   section: 邀请新协作者 (input + 邀请 button)
 *   ───────
 *   section: 成员 (count) + note "所有者永久绑定项目创建者"
 *   list rows: avatar + name + handle + role select (owner row no select) + 移除
 *
 * Stub data + stub role select; real backend wiring lands in the
 * project-members API PR.
 */
export function MembersModal({ members = STUB_MEMBERS }: MembersModalProps) {
  const open = useUIStore((s) => s.membersModalOpen);
  const setOpen = useUIStore((s) => s.setMembersModalOpen);
  const [invite, setInvite] = React.useState('');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid='members-modal'>
        <DialogHeader>
          <DialogTitle>协作者管理</DialogTitle>
          <DialogDescription>管理项目成员及其权限</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className='flex flex-col gap-2'>
            <div className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              邀请新协作者
            </div>
            <div className='flex items-center gap-2'>
              <Input
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                placeholder='邮箱或用户 ID'
                className='h-9 flex-1 text-[13px]'
                data-testid='members-modal-invite-input'
              />
              <Button
                size='sm'
                disabled={invite.trim().length === 0}
                data-testid='members-modal-invite-send'
              >
                <Send className='h-4 w-4' />
                邀请
              </Button>
            </div>
          </div>
        </DialogBody>

        <Separator />

        <DialogBody>
          <div className='flex items-center justify-between'>
            <span className='text-[11px] font-medium uppercase tracking-wide text-muted-foreground'>
              成员 ({members.length})
            </span>
            <span className='text-[11px] text-muted-foreground'>
              所有者永久绑定项目创建者
            </span>
          </div>
          <ul className='flex flex-col divide-y divide-border'>
            {members.map((m) => (
              <li key={m.id} data-testid={`members-modal-row-${m.id}`}>
                <ModalMemberRow member={m} />
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function ModalMemberRow({ member }: { member: Member }) {
  return (
    <div className='flex items-center gap-3 py-2'>
      <Avatar className='h-9 w-9 shrink-0'>
        <AvatarFallback className='text-[12px] font-semibold'>
          {member.initials}
        </AvatarFallback>
      </Avatar>
      <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-[13px] font-medium text-foreground'>
          {member.name}
          {member.isMe ? (
            <span className='ml-1 text-[12px] text-muted-foreground'>(你)</span>
          ) : null}
        </span>
        <span className='text-[12px] text-muted-foreground'>
          {member.initials.toLowerCase()}
        </span>
      </div>
      {member.role === 'owner' ? (
        <span className='shrink-0 text-[13px] font-medium text-foreground'>
          所有者
        </span>
      ) : (
        <Select defaultValue={member.role}>
          <SelectTrigger
            className='h-8 w-24 text-[13px]'
            data-testid={`members-modal-role-${member.id}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {member.role !== 'owner' ? (
        <Button
          variant='outline'
          size='sm'
          className='h-8 px-3 text-[12px]'
          data-testid={`members-modal-remove-${member.id}`}
        >
          移除
        </Button>
      ) : null}
    </div>
  );
}
