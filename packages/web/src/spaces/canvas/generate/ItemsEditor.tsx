// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Plus, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { useTranslation } from '@web/i18n/use-translation';
import { blankEntry, entriesOf, fixedEntries } from '@web/spaces/canvas/generate/fixed-entries';
import type { ItemFieldControl } from '@web/spaces/canvas/generate/model-controls';

interface ItemsEditorProps {
  /** The param name, for the change and the test ids. */
  name: string;
  /** Its name on screen. */
  label: string;
  /** The most entries the model takes, if it caps them. */
  max: number | undefined;
  /**
   * The fewest the model takes. When it equals `max` the list is a fixed set
   * of rows with nothing to add or remove (Gemini's two speakers).
   */
  min?: number;
  /** How a field is named in its empty box; the field's own name when absent. */
  fieldLabel?: (field: string) => string;
  /** The fields of one entry, in the order the model declares them. */
  fields: readonly ItemFieldControl[];
  /** What the node holds; anything that is not a list reads as none. */
  held: unknown;
  /** Called with the whole new list under the param name. */
  onChange: (partial: Record<string, unknown>) => void;
}


/**
 * A list param's editor (#2156, design §13): one row per entry, one cell per
 * field, a remove button per row and an add button under them.
 * @param root0 - Props.
 * @param root0.name - The param name.
 * @param root0.label - Its name on screen.
 * @param root0.max - The most entries the model takes.
 * @param root0.min - The fewest it takes.
 * @param root0.fieldLabel - How a field is named in its empty box.
 * @param root0.fields - The fields of one entry.
 * @param root0.held - What the node holds.
 * @param root0.onChange - Called with the new list.
 * @returns The editor.
 */
export function ItemsEditor({
  name,
  label,
  max,
  min,
  fieldLabel,
  fields,
  held,
  onChange,
}: ItemsEditorProps): React.JSX.Element {
  const t = useTranslation();
  const fixed = max !== undefined && min === max;
  const entries = fixed ? fixedEntries(held, max, fields) : entriesOf(held);
  const full = max !== undefined && entries.length >= max;
  /**
   * Writes the list with one entry's field changed.
   * @param index - The entry.
   * @param field - The field.
   * @param value - Its new value.
   */
  const setField = (index: number, field: string, value: unknown): void => {
    onChange({ [name]: entries.map((e, i) => (i === index ? { ...e, [field]: value } : e)) });
  };
  return (
    <div>
      <div className='mb-1.5 flex items-center justify-between text-xs'>
        <span className='font-medium text-muted-foreground'>{label}</span>
        {max !== undefined && !fixed ? (
          <span data-testid={`generate-param-${name}-count`} className='tabular-nums text-muted-foreground'>
            {entries.length} / {max}
          </span>
        ) : null}
      </div>
      <div className='flex flex-col gap-1.5'>
        {entries.map((entry, index) => (
          <div key={index} className='flex items-center gap-1.5'>
            {fields.map((field) => (
              <React.Fragment key={field.name}>
                <FieldCell
                  testId={`generate-param-${name}-${index}-${field.name}`}
                  field={field}
                  placeholder={fieldLabel?.(field.name) ?? field.name.charAt(0).toUpperCase() + field.name.slice(1)}
                  value={entry[field.name]}
                  onCommit={(value) => setField(index, field.name, value)}
                />
              </React.Fragment>
            ))}
            {fixed ? null : (
              <Button
                type='button'
                variant='chrome-ghost'
                size={null}
                data-testid={`generate-param-${name}-${index}-remove`}
                aria-label={t('canvas.generatePanel.itemsRemove')}
                onClick={() => onChange({ [name]: entries.filter((_, i) => i !== index) })}
                className='h-8 w-8 shrink-0'
              >
                <X className='h-3.5 w-3.5' aria-hidden='true' />
              </Button>
            )}
          </div>
        ))}
        {fixed ? null : (
          <Button
            type='button'
            variant='outline'
            size={null}
            data-testid={`generate-param-${name}-add`}
            disabled={full}
            onClick={() => onChange({ [name]: [...entries, blankEntry(fields)] })}
            className='h-8 gap-1 text-xs'
          >
            <Plus className='h-3.5 w-3.5' aria-hidden='true' />
            {t('canvas.generatePanel.itemsAdd')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface FieldCellProps {
  testId: string;
  field: ItemFieldControl;
  placeholder: string;
  value: unknown;
  onCommit: (value: unknown) => void;
}

/**
 * One field of one entry: a choice list, or a text box written when the
 * reader leaves it (one write per edit, so each is one canvas undo step).
 * @param root0 - Props.
 * @param root0.testId - The cell's test id.
 * @param root0.field - The field.
 * @param root0.placeholder - What the empty text box says.
 * @param root0.value - What the entry holds for it.
 * @param root0.onCommit - Called with the new value.
 * @returns The cell.
 */
function FieldCell({ testId, field, placeholder, value, onCommit }: FieldCellProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);
  if (field.kind === 'choice') {
    const current = field.options.find((o) => o.value === value) ?? field.options[0];
    return (
      <Select
        value={current === undefined ? undefined : String(current.value)}
        onValueChange={(next) => {
          const picked = field.options.find((o) => String(o.value) === next);
          if (picked) onCommit(picked.value);
        }}
      >
        <SelectTrigger data-testid={testId} className='h-8 min-w-0 flex-1 text-xs'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={String(o.value)} value={String(o.value)} className='text-xs'>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const held = typeof value === 'string' ? value : '';
  /** Writes the draft, when it differs from what the entry holds, and drops it. */
  const commit = (): void => {
    if (draft !== null && draft !== held) onCommit(draft);
    setDraft(null);
  };
  return (
    <Input
      data-testid={testId}
      placeholder={placeholder}
      value={draft ?? held}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit();
      }}
      className='h-8 min-w-0 flex-1 text-xs'
    />
  );
}
