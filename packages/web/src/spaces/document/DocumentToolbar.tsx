import type { Editor } from '@tiptap/react';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface DocumentToolbarProps {
  editor: Editor;
}

interface ToolDef {
  id: string;
  label: string;
  Icon: typeof Bold;
  isActive: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const MARK_TOOLS: ToolDef[] = [
  {
    id: 'bold',
    label: 'Bold',
    Icon: Bold,
    isActive: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    id: 'italic',
    label: 'Italic',
    Icon: Italic,
    isActive: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    Icon: Strikethrough,
    isActive: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
];

const BLOCK_TOOLS: ToolDef[] = [
  {
    id: 'bullet-list',
    label: 'Bullet list',
    Icon: List,
    isActive: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'ordered-list',
    label: 'Ordered list',
    Icon: ListOrdered,
    isActive: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'quote',
    label: 'Quote',
    Icon: Quote,
    isActive: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

/**
 * Document toolbar — mark + block toggles. Active state mirrors the
 * editor's selection so the UI reflects what's at the cursor. The
 * heavier feature set (font / color / table / image / link) layers in
 * with the M2 polish PR.
 */
export function DocumentToolbar({ editor }: DocumentToolbarProps) {
  return (
    <div
      data-testid='document-toolbar'
      className='flex h-10 items-center gap-1 border-b border-border bg-background px-2'
    >
      {MARK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} editor={editor} />
      ))}
      <Separator orientation='vertical' className='mx-1 h-6' />
      {BLOCK_TOOLS.map((t) => (
        <ToolButton key={t.id} tool={t} editor={editor} />
      ))}
    </div>
  );
}

function ToolButton({ tool, editor }: { tool: ToolDef; editor: Editor }) {
  const active = tool.isActive(editor);
  const Icon = tool.Icon;
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size='icon'
      aria-label={tool.label}
      aria-pressed={active}
      onClick={() => tool.run(editor)}
      data-testid={`doc-tool-${tool.id}`}
      className={cn('h-7 w-7')}
    >
      <Icon className='h-4 w-4' />
    </Button>
  );
}
