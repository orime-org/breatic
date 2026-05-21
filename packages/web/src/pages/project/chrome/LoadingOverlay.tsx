import { Loader2 } from 'lucide-react';

interface LoadingOverlayProps {
  /** Visible message displayed under the spinner. */
  message: string;
  /**
   * Test id for the overlay's outer container — callers thread their
   * own id so each loading state (`creating-space-overlay` /
   * `deleting-space-overlay`) can be asserted independently.
   */
  testId?: string;
}

/**
 * Full-screen blocking overlay shown during Space operations
 * (create / delete) that have to wait for the server-published event
 * to round-trip through collab → Y.Doc → WS broadcast.
 *
 * Why an overlay (not a toast):
 *   - Operation is destructive (delete) or scope-changing (create) —
 *     the user's next click depends on which Space is active. Letting
 *     them click around mid-flight produces stale tabs and confusing
 *     navigation jumps when the WS update finally arrives.
 *   - 50-200ms typical (per server route note); 10-second timeout
 *     guards against a wedged collab or wedged WS.
 *
 * Visual: dark scrim + centered spinner + message, `bg-background/80`
 * blur for readability. Sits at z-index 50 so it covers chrome layers.
 */
export function LoadingOverlay({
  message,
  testId = 'loading-overlay',
}: LoadingOverlayProps) {
  return (
    <div
      data-testid={testId}
      role='status'
      aria-live='polite'
      className='fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm'
    >
      <div className='flex flex-col items-center gap-3 rounded-md border border-border bg-popover px-6 py-4 shadow'>
        <Loader2 className='h-6 w-6 animate-spin text-foreground' />
        <span className='text-[13px] text-foreground'>{message}</span>
      </div>
    </div>
  );
}
