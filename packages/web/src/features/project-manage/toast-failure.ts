// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { toast } from '@web/lib/toast';

/**
 * An `onError` handler that toasts a failed project action, with the
 * server's own reason underneath when it gave one.
 * @param title - The action's failure headline.
 * @returns The `onError` handler.
 */
export function toastFailure(title: string): (err: unknown) => void {
  return (err) => {
    const message = err instanceof Error ? err.message : '';
    toast.error(title, { description: message || undefined });
  };
}
