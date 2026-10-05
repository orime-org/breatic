// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Move } from 'lucide-react';
import * as React from 'react';

import {
  CAMERA_COMMAND_AXES,
  CAMERA_COMMANDS_PER_BRACKET,
  cameraCommandBracket,
  type CameraCommandEntry,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@web/components/ui/popover';
import { useTranslation } from '@web/i18n/use-translation';
import {
  canPickCameraCommand,
  pickCameraCommand,
} from '@web/spaces/canvas/generate/camera-command-picks';
import { PARAMS_PILL_CLASS } from '@web/spaces/canvas/generate/generate-tools';
import { PARAM_OPTION_CLASS } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface CameraCommandPickerProps {
  /** The commands the current model reads, each with its preview clip. */
  commands: readonly CameraCommandEntry[];
  /** Writes the picked commands, already bracketed, into the prompt. */
  onInsert: (text: string) => void;
}

/**
 * The commands a model reads, laid out by axis.
 * @param commands - What the model declares.
 * @returns One row per axis it has, then one for the rest.
 */
function groupsOf(
  commands: readonly CameraCommandEntry[],
): Array<{ key: string; commands: CameraCommandEntry[] }> {
  const onAxis = new Set<string>(CAMERA_COMMAND_AXES.flatMap((axis) => axis.directions));
  const rows = CAMERA_COMMAND_AXES.map((axis) => ({
    key: axis.key,
    commands: commands.filter((c) => (axis.directions as readonly string[]).includes(c.name)),
  }));
  rows.push({ key: 'other', commands: commands.filter((c) => !onAxis.has(c.name)) });
  return rows.filter((row) => row.commands.length > 0);
}

/**
 * The test id stem of one command's option.
 * @param name - The command.
 * @returns e.g. `truck-left`.
 */
function slug(name: string): string {
  return name.toLowerCase().replace(/ /g, '-');
}

/**
 * The video panel's camera command picker (inner#1241): a pill in the settings
 * row that opens the commands the model reads, up to three of which go into
 * the prompt as one bracket. Hovering an option, a disabled one included,
 * plays its clip muted and looping in a fixed pane at the top, which covers
 * none of the options the pointer moves across; the last clip stays.
 * @param root0 - Component props.
 * @param root0.commands - The commands the current model reads.
 * @param root0.onInsert - Writes the bracket into the prompt.
 * @returns The picker.
 */
export const CameraCommandPicker = React.memo(function CameraCommandPicker({
  commands,
  onInsert,
}: CameraCommandPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<string[]>([]);
  // The command whose clip the pane plays; it stays after the pointer leaves.
  const [previewed, setPreviewed] = React.useState<CameraCommandEntry | null>(null);
  useFollowCanvasViewport(open);
  const groups = React.useMemo(() => groupsOf(commands), [commands]);

  // Every open starts empty: the content stays live through its close
  // animation, and a hover or click there must not carry into the next open.
  const onOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setPicked([]);
      setPreviewed(null);
    }
  }, []);
  // Focus goes to the popover itself, so every option's focus is one the
  // reader moved there, and the pane shows its hint until they do.
  const focusPopover = React.useCallback((event: Event) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).focus();
  }, []);
  const insert = React.useCallback(() => {
    onInsert(cameraCommandBracket(picked));
    onOpenChange(false);
  }, [onInsert, onOpenChange, picked]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant={null}
          size={null}
          data-testid='generate-video-camera-trigger'
          className={PARAMS_PILL_CLASS}
        >
          <Move className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
          <span className='truncate'>{t('canvas.generatePanel.cameraCommands')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='center'
        // Same as the params popover: it follows the canvas and clips at the
        // edge rather than flipping while following.
        avoidCollisions={false}
        onOpenAutoFocus={focusPopover}
        aria-label={t('canvas.generatePanel.cameraCommands')}
        // As wide as its widest row, so every label and option fits in every locale.
        className='w-max p-3 shadow-md'
      >
        <div
          data-testid='generate-video-camera-preview'
          className='relative mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-overlay bg-muted text-xs text-muted-foreground'
        >
          {previewed ? (
            <>
              <video
                key={previewed.preview_url}
                src={previewed.preview_url}
                muted
                autoPlay
                loop
                playsInline
                // A clip that cannot load leaves the pane as it was before any hover.
                onError={() => setPreviewed(null)}
                // Out of flow, so the clip's own size never feeds the popover's width.
                className='absolute inset-0 h-full w-full object-cover'
              />
              <span className='absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 text-xs text-white'>
                {previewed.name}
              </span>
            </>
          ) : (
            t('canvas.generatePanel.cameraCommandsPreviewHint')
          )}
        </div>
        <div className='grid grid-cols-[max-content_1fr] items-center gap-x-2 gap-y-1.5'>
          {groups.map((group) => (
            <React.Fragment key={group.key}>
              <p className='whitespace-nowrap text-xs font-medium text-muted-foreground'>
                {t(`canvas.generatePanel.cameraCommandGroup.${group.key}`)}
              </p>
              <div className='flex gap-1.5'>
                {group.commands.map((command) => {
                  const order = picked.indexOf(command.name);
                  return (
                    // The wrapper takes the hover: a disabled button gets no pointer events.
                    <span
                      key={command.name}
                      className='flex flex-1'
                      onPointerEnter={() => setPreviewed(command)}
                      onFocus={() => setPreviewed(command)}
                    >
                      <Button
                        type='button'
                        variant={null}
                        size={null}
                        data-testid={`generate-video-camera-option-${slug(command.name)}`}
                        aria-current={order >= 0}
                        disabled={!canPickCameraCommand(picked, command.name)}
                        onClick={() => setPicked((now) => pickCameraCommand(now, command.name))}
                        className={PARAM_OPTION_CLASS}
                      >
                        {/* The order number's room is held on both sides whether or
                            not it shows, so a pick neither resizes the popover nor
                            moves the name off centre. */}
                        <span aria-hidden='true' className='invisible mr-1.5 tabular-nums'>
                          {CAMERA_COMMANDS_PER_BRACKET}
                        </span>
                        {command.name}
                        <span
                          data-testid={`generate-video-camera-order-${slug(command.name)}`}
                          className={`ml-1.5 tabular-nums text-muted-foreground ${order >= 0 ? '' : 'invisible'}`}>
                          {order >= 0 ? order + 1 : CAMERA_COMMANDS_PER_BRACKET}
                        </span>
                      </Button>
                    </span>
                  );
                })}
              </div>
            </React.Fragment>
          ))}
        </div>
        <div className='mt-3 flex items-end justify-between gap-2 border-t border-border pt-3'>
          <span
            data-testid='generate-video-camera-count'
            // Zero width of its own: it wraps inside what the rows give the popover, never widens it.
            className='w-0 min-w-0 flex-1 text-xs tabular-nums text-muted-foreground [overflow-wrap:anywhere]'
          >
            {picked.length}/{CAMERA_COMMANDS_PER_BRACKET}
            {picked.length > 0 ? ` · ${cameraCommandBracket(picked)}` : null}
          </span>
          <Button
            type='button'
            size='sm'
            data-testid='generate-video-camera-insert'
            disabled={picked.length === 0}
            onClick={insert}
          >
            {t('canvas.generatePanel.cameraCommandsInsert')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});
