// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { suppressTooltipFocusOpen } from '@web/lib/overlay-focus';
import { cn } from '@web/lib/utils';

/**
 * Forward Radix trigger bindings through a scene icon control with shared hover styling.
 * @throws {never} Never directly.
 */
export const SceneIconButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof Button> & { label: string; active?: boolean; rail?: boolean }>(function SceneIconButton({ label, active, rail, className, children, ...props }, ref): React.JSX.Element {
  return <Tooltip><TooltipTrigger asChild><Button {...props} ref={ref} variant={null} size={null} aria-label={label}
    onFocusCapture={suppressTooltipFocusOpen} className={cn('relative inline-flex shrink-0 items-center justify-center transition-colors',
      rail ? 'h-10 w-10 rounded-lg' : 'h-8 w-8 rounded-md', active ? 'bg-foreground text-background shadow-sm hover:bg-primary-hover' : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground', className)}>{children}</Button></TooltipTrigger>
  <TooltipContent side={rail ? 'right' : 'top'}>{label}</TooltipContent></Tooltip>;
});
