import * as React from 'react';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Label } from '@web/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { cn } from '@web/lib/utils';

export type SpaceTemplate = 'canvas' | 'document' | 'timeline';

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; template: SpaceTemplate }) => void;
}

const TEMPLATE_OPTIONS: { value: SpaceTemplate; label: string }[] = [
  { value: 'canvas', label: 'Canvas — infinite workspace' },
  { value: 'document', label: 'Document — rich text editor' },
  { value: 'timeline', label: 'Timeline — video / audio (soon)' },
];

/**
 * Create-new-project dialog — name + default space template, then callback
 * to creator (the page wires creator to the backend via `data/api/projects`).
 *
 * V1 keeps the surface minimal: name is required, template defaults to
 * `canvas`. Validation is inline (empty name disables submit). Submit fires
 * `onCreate` and closes; the caller is responsible for navigation /
 * persistence.
 * @param root0 - component props
 * @param root0.open - whether the dialog is open
 * @param root0.onOpenChange - called when the dialog requests an open/close change
 * @param root0.onCreate - called with the entered name and chosen template on submit
 * @returns the create-project dialog with a name field and template selector.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: NewProjectDialogProps): React.JSX.Element {
  const [name, setName] = React.useState('');
  const [template, setTemplate] = React.useState<SpaceTemplate>('canvas');
  const [touched, setTouched] = React.useState(false);

  const trimmed = name.trim();
  const empty = trimmed.length === 0;
  const showError = touched && empty;

  /**
   * Mark the form touched, and if the name is non-empty fire `onCreate`,
   * reset local fields, and close the dialog.
   */
  const submit = (): void => {
    setTouched(true);
    if (empty) return;
    onCreate({ name: trimmed, template });
    setName('');
    setTemplate('canvas');
    setTouched(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Give your project a name and pick the default space type.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='np-name'>Name</Label>
              <input
                id='np-name'
                type='text'
                // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog first input; users open the dialog expecting to type a name immediately
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. Cyberpunk Concept'
                className={cn(
                  'flex h-9 w-full rounded-chrome border border-border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
                  'placeholder:text-muted-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  showError ? 'border-destructive' : 'border-input',
                )}
                aria-invalid={showError}
                aria-describedby={showError ? 'np-name-error' : undefined}
              />
              {showError && (
                <p
                  id='np-name-error'
                  className='text-xs font-medium text-destructive'
                >
                Name is required.
                </p>
              )}
            </div>

            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='np-template'>Template</Label>
              <Select
                value={template}
                onValueChange={(v) => setTemplate(v as SpaceTemplate)}
              >
                <SelectTrigger id='np-template'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogBody>

          <DialogFooter>
            <button
              type='button'
              onClick={() => onOpenChange(false)}
              className='inline-flex h-9 items-center justify-center rounded-chrome border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-muted'
            >
              Cancel
            </button>
            <button
              type='submit'
              className='inline-flex h-9 items-center justify-center rounded-chrome bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50'
              disabled={empty}
            >
              Create
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
