// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/** Reads what one part holds now. */
type Collect = () => unknown;

/** What each part asked to carry, read when the page actually unloads. */
const collectors = new Map<string, Collect>();
/** What the page before this one carried; read once, on first ask. */
let carried: Record<string, unknown> | null | undefined;
/** Update was pressed and nothing has been pressed since. */
let armed = false;

/**
 * Reload for a new release, carrying what the user typed but has not sent.
 *
 * Nothing is written now. The reload may yet be cancelled in the browser's
 * leave prompt, and a write made here would then be restored by whatever
 * reload came next, bringing back words long since sent. `pagehide` fires
 * only when the page really goes, so that is where the write happens.
 */
export function reloadForUpdate(): void {
  armed = true;
  window.location.reload();
}

/**
 * Ask for a part's state to cross an update reload, and get back what the
 * page before carried for it.
 * @param part - The part's name; one per store.
 * @param collect - What the part holds now, read at unload.
 * @returns What the page before carried for this part, or undefined.
 */
export function keepAcrossUpdate(part: string, collect: Collect): unknown {
  collectors.set(part, collect);
  if (carried === undefined) carried = readCarried();
  return carried?.[part];
}

/**
 * Take what the page before wrote, leaving nothing for a later reload.
 * @returns The stored parts, or null when there are none.
 */
function readCarried(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.reloadDrafts);
    sessionStorage.removeItem(STORAGE_KEYS.reloadDrafts);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Storage blocked or not ours: start empty, as any reload does.
    return null;
  }
}

/** Write every part, if this unload is the one Update started. */
function writeCarried(): void {
  if (!armed) return;
  armed = false;
  const parts: Record<string, unknown> = {};
  for (const [part, collect] of collectors) parts[part] = collect();
  try {
    sessionStorage.setItem(STORAGE_KEYS.reloadDrafts, JSON.stringify(parts));
  } catch {
    // Storage blocked: the reload goes ahead without them.
  }
}

/**
 * Any press after Update means the reload did not happen as asked: either
 * the leave prompt was cancelled and work went on, or the user is reloading
 * by hand, which carries nothing. Pressing Update again re-arms it, because
 * its own click fires after this.
 */
function disarm(): void {
  armed = false;
}

window.addEventListener('keydown', disarm, true);
window.addEventListener('pointerdown', disarm, true);
window.addEventListener('pagehide', writeCarried);
