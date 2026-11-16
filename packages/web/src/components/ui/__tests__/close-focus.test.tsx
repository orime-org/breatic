import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import * as React from 'react';

import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogTrigger } from '@web/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@web/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@web/components/ui/sheet';

type Overlay = (props: { open: boolean; onOpenChange: (open: boolean) => void }) => React.JSX.Element;

const trigger = <button type='button' data-testid='trigger'>Open</button>;
const OVERLAYS: Array<[string, Overlay]> = [
  ['Popover', ({ open, onOpenChange }) => <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent><button type='button'>Inside</button></PopoverContent></Popover>],
  ['Dialog', ({ open, onOpenChange }) => <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild>{trigger}</DialogTrigger><DialogContent><DialogTitle>Title</DialogTitle><button type='button'>Inside</button></DialogContent></Dialog>],
  ['Sheet', ({ open, onOpenChange }) => <Sheet open={open} onOpenChange={onOpenChange} modal>
    <SheetTrigger asChild>{trigger}</SheetTrigger><SheetContent><SheetTitle>Title</SheetTitle><button type='button'>Inside</button></SheetContent></Sheet>],
  ['AlertDialog', ({ open, onOpenChange }) => <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger><AlertDialogContent><AlertDialogTitle>Title</AlertDialogTitle><button type='button'>Inside</button></AlertDialogContent></AlertDialog>],
  ['DropdownMenu', ({ open, onOpenChange }) => <DropdownMenu open={open} onOpenChange={onOpenChange}>
    <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Inside</DropdownMenuItem></DropdownMenuContent></DropdownMenu>],
];

/**
 * Mount an overlay with its open state held here and a control outside it.
 * @param Overlay - The overlay under test.
 * @returns A setter for its open state.
 */
function mount(Overlay: Overlay): { setOpen: (open: boolean) => void } {
  let set: (open: boolean) => void = () => {};
  /** The overlay, open from the start, beside a control that stands for another overlay. */
  function Harness(): React.JSX.Element {
    const [open, setOpen] = React.useState(true);
    set = setOpen;
    return <><Overlay open={open} onOpenChange={setOpen} /><button type='button' data-testid='elsewhere'>Elsewhere</button></>;
  }
  render(<Harness />);
  return { setOpen: (open) => act(() => set(open)) };
}

const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

describe.each(OVERLAYS)('%s closing', (_, Overlay) => {
  it('leaves focus where another overlay moved it while it closed', async () => {
    const { setOpen } = mount(Overlay);
    await settle();
    setOpen(false);
    act(() => screen.getByTestId('elsewhere').focus());
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
  });

  it('gives focus back to its trigger when focus went down with it', async () => {
    const { setOpen } = mount(Overlay);
    await settle();
    act(() => (screen.getByText('Inside').closest('button, [role="menuitem"]') as HTMLElement).focus());
    setOpen(false);
    await settle();
    expect(document.activeElement).toBe(screen.getByTestId('trigger'));
  });
});
