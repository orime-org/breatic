import { Sparkles } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Modality } from '@/spaces/canvas/types/node';

interface NodeGeneratePopoverProps {
  modality: Modality;
  onGenerate?: (prompt: string, model: string) => void;
}

const MODELS: Record<Modality, ReadonlyArray<{ id: string; label: string }>> = {
  text: [
    { id: 'gpt-4', label: 'GPT-4' },
    { id: 'claude-3-5', label: 'Claude 3.5' },
  ],
  image: [
    { id: 'sdxl', label: 'SDXL' },
    { id: 'dalle-3', label: 'DALL·E 3' },
  ],
  audio: [
    { id: 'elevenlabs', label: 'ElevenLabs' },
    { id: 'suno', label: 'Suno' },
  ],
  video: [
    { id: 'kling', label: 'Kling' },
    { id: 'veo', label: 'Veo' },
  ],
};

/**
 * Left-zone "Generate" entry on the node toolbar. Opens a popover with a
 * prompt input + model select + send. Submit fires `onGenerate(prompt,
 * model)`; the page-level handler kicks the AI request and updates the
 * NODE IN PLACE (does not create a new node).
 */
export function NodeGeneratePopover({
  modality,
  onGenerate,
}: NodeGeneratePopoverProps) {
  const models = MODELS[modality];
  const [open, setOpen] = React.useState(false);
  const [prompt, setPrompt] = React.useState('');
  const [model, setModel] = React.useState(models[0]?.id ?? '');

  React.useEffect(() => {
    setModel(models[0]?.id ?? '');
  }, [models]);

  const submit = () => {
    if (prompt.trim().length === 0 || model.length === 0) return;
    onGenerate?.(prompt.trim(), model);
    setPrompt('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          className='h-7 gap-1 px-2'
          data-testid='node-generate-trigger'
        >
          <Sparkles className='h-3.5 w-3.5' />
          <span className='text-xs'>Generate</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-72'
        data-testid='node-generate-popover'
      >
        <div className='space-y-3'>
          <div className='space-y-1'>
            <Label htmlFor='gen-prompt'>Prompt</Label>
            <Textarea
              id='gen-prompt'
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder='What should we generate?'
              data-testid='node-generate-prompt'
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='gen-model'>Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id='gen-model'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex justify-end'>
            <Button
              size='sm'
              onClick={submit}
              disabled={prompt.trim().length === 0}
              data-testid='node-generate-submit'
            >
              Send
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
