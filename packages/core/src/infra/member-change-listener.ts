// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Listening for committed changes to `project_members` (inner#911).
 *
 * A trigger on the table (migration 0095) sends a NOTIFY on every insert,
 * update of role / deleted_at / key, and delete, whichever code path wrote the
 * row. PostgreSQL delivers it at commit and drops it on rollback, and only to
 * sessions listening at that moment, so a caller re-checks what it holds each
 * time listening starts.
 *
 * postgres.js gives `listen` a dedicated connection and re-listens when it
 * drops. On a re-listen it registers new callback objects, so the `unlisten`
 * handed back at start no longer reaches them; this module keeps its own
 * stopped flag instead. It also does not say whether it is listening right now,
 * so liveness is answered by a real round trip on a probe channel.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { rawPg } from "@core/db/client.js";
import { CANONICAL_UUID } from "@core/db/canonical-uuid.js";

/** The channel the 0095 trigger notifies on. */
export const PROJECT_MEMBER_CHANGED_CHANNEL = "project_member_changed";

/** The channel {@link probeMemberListen} round-trips on. */
const PROBE_CHANNEL = "project_member_listen_probe";

/** One changed membership row. */
export interface MemberChange {
  projectId: string;
  userId: string;
}

/** What the listener calls. */
export interface MemberChangeHandlers {
  /** A committed change to the membership of `userId` on `projectId`. */
  onChange: (change: MemberChange) => void;
  /** Listening started: the first time, and after every reconnect. */
  onListening: () => void;
  /** A notification on the channel that is not a change; the raw payload. */
  onInvalid: (raw: string) => void;
}

/** A running listener. */
export interface MemberChangeListener {
  /** Stop delivering; nothing reaches the handlers afterwards. */
  stop: () => Promise<void>;
}

const changeSchema = z.object({
  projectId: z.string().regex(CANONICAL_UUID),
  userId: z.string().regex(CANONICAL_UUID),
});

/** Probe nonces waiting to come back, for the listener that is running. */
let probes: Map<string, () => void> | null = null;

/**
 * Read one notification payload.
 * @param raw - The payload.
 * @returns The change, or null when it is not one.
 */
function readChange(raw: string): MemberChange | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = changeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Start listening for membership changes on the process pool's database.
 * @param handlers - Where changes, (re)starts and unreadable payloads go.
 * @returns The running listener, once the first LISTEN has been answered.
 * @throws {Error} When the first LISTEN fails (the database is unreachable).
 */
export async function listenProjectMemberChanges(
  handlers: MemberChangeHandlers,
): Promise<MemberChangeListener> {
  let stopped = false;
  const pending = new Map<string, () => void>();
  await rawPg.listen(
    PROJECT_MEMBER_CHANGED_CHANNEL,
    (raw) => {
      if (stopped) return;
      const change = readChange(raw);
      if (change === null) handlers.onInvalid(raw);
      else handlers.onChange(change);
    },
    () => {
      if (!stopped) handlers.onListening();
    },
  );
  await rawPg.listen(PROBE_CHANNEL, (nonce) => {
    if (!stopped) pending.get(nonce)?.();
  });
  probes = pending;
  return {
    stop: async () => {
      stopped = true;
      if (probes === pending) probes = null;
      for (const resolve of pending.values()) resolve();
      pending.clear();
    },
  };
}

/**
 * Whether the running listener receives notifications right now: send a
 * random nonce on the probe channel and wait for it to come back.
 * @param timeoutMs - How long to wait.
 * @returns True when it came back in time; false when it did not, when no
 *   listener is running, or when the send failed.
 */
export async function probeMemberListen(timeoutMs: number): Promise<boolean> {
  const pending = probes;
  if (pending === null) return false;
  const nonce = randomUUID();
  let received = false;
  const arrived = new Promise<void>((resolve) => {
    pending.set(nonce, () => {
      received = probes === pending;
      resolve();
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await rawPg.notify(PROBE_CHANNEL, nonce);
    await Promise.race([arrived, timedOut]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    pending.delete(nonce);
  }
  return received;
}
