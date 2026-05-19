import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
}

interface ConversationHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ReadonlyArray<ConversationSummary>;
  activeId?: string;
  onPick: (id: string) => void;
}

/**
 * Side sheet that lists the project's previous conversations. PR 9
 * renders the layout + selection wiring; the full list / search / delete
 * flow lands when the conversations API is wired in.
 */
export function ConversationHistorySheet({
  open,
  onOpenChange,
  conversations,
  activeId,
  onPick,
}: ConversationHistorySheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='left'
        className='w-80'
        data-testid='conversation-history-sheet'
      >
        <SheetHeader>
          <SheetTitle>Conversations</SheetTitle>
          <SheetDescription>
            Pick a past conversation to resume.
          </SheetDescription>
        </SheetHeader>
        <div className='mt-3 flex flex-col gap-1'>
          {conversations.map((c) => (
            <button
              key={c.id}
              type='button'
              onClick={() => onPick(c.id)}
              className={`flex flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-muted ${
                c.id === activeId ? 'bg-muted' : ''
              }`}
              data-testid={`conversation-${c.id}`}
            >
              <span className='truncate'>{c.name}</span>
              <span className='text-[10px] text-muted-foreground'>
                {c.messageCount} messages
              </span>
            </button>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
