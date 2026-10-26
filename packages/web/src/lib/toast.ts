// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { toast as sonnerToast } from 'sonner';

type ToastMessage = Parameters<typeof sonnerToast.error>[0];
type ToastOptions = Parameters<typeof sonnerToast.error>[1];
type ToastId = ReturnType<typeof sonnerToast.error>;

/** Set once the page must reload; see {@link muteToasts}. */
let muted = false;

/**
 * Derives the sonner options for a typed toast, adding a stable de-dup `id` from
 * `type + message` unless the caller already set one. sonner de-duplicates by
 * id, so identical repeats REFRESH the one toast (resetting its timer) instead
 * of stacking a pile of collapsed bars — "new refreshes old" (user 2026-07-18).
 * Two DIFFERENT messages (or the same text at a different severity) get
 * different ids and still stack, so distinct notices are never swallowed. A
 * non-string message (a ReactNode) has no stable content key, so it gets no
 * auto id (pass an explicit `options.id` if such a toast must de-dup).
 * @param type - The semantic toast type — drives both the color and the id prefix.
 * @param message - The toast content.
 * @param options - Caller options; a caller-provided `id` wins.
 * @returns The options to pass to sonner, with the derived id (or unchanged).
 */
function withDedupId(
  type: string,
  message: ToastMessage,
  options?: ToastOptions,
): ToastOptions {
  if (options?.id !== undefined) return options;
  if (typeof message === 'string') return { ...options, id: `${type}:${message}` };
  return options;
}

/**
 * The application's SINGLE toast entry point (mandate: `packages/web/AGENTS.md#toasts-have-one-entry`).
 * Every notice MUST route through here — the `breatic/single-toast-entry` CI guard
 * forbids importing `toast` straight from 'sonner' anywhere but this file and
 * the Toaster component — so two invariants always hold:
 *
 *   1. Every toast carries a semantic TYPE (`error` / `warning` / `success` /
 *      `info`); the Toaster colors by `data-type`, and there is deliberately NO
 *      untyped method (a bare `toast()` / `toast.message()` renders neutral and
 *      loses the severity signal — this object simply does not expose one).
 *   2. Identical repeats DE-DUPLICATE by a content-derived id, so rapidly
 *      re-firing the same notice refreshes one toast instead of stacking.
 *
 * `loading` / `promise` / `dismiss` / `custom` pass through unchanged — they
 * carry their own id / lifecycle semantics and are not content-typed notices.
 */
export const toast = {
  error: (message: ToastMessage, options?: ToastOptions): ToastId =>
    muted ? '' : sonnerToast.error(message, withDedupId('error', message, options)),
  warning: (message: ToastMessage, options?: ToastOptions): ToastId =>
    muted ? '' : sonnerToast.warning(message, withDedupId('warning', message, options)),
  success: (message: ToastMessage, options?: ToastOptions): ToastId =>
    muted ? '' : sonnerToast.success(message, withDedupId('success', message, options)),
  info: (message: ToastMessage, options?: ToastOptions): ToastId =>
    muted ? '' : sonnerToast.info(message, withDedupId('info', message, options)),
  loading: sonnerToast.loading,
  promise: sonnerToast.promise,
  dismiss: sonnerToast.dismiss,
  custom: sonnerToast.custom,
};


/**
 * Silence every typed toast for the rest of this page's life.
 *
 * Called once the page is found out of date: a modal that only reloads is up,
 * and the refusal that proved it, plus anything else still failing for the
 * same reason, would only contradict it.
 */
export function muteToasts(): void {
  muted = true;
  sonnerToast.dismiss();
}

/** Let toasts through again between tests; a real page only reloads. */
export function _unmuteToastsForTests(): void {
  muted = false;
}
