// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Listening for committed changes the database triggers announce: `project_members` (inner#911), and the rows behind
 * a Project page's bell, transfer and credits (`live_updates`, #1580).
 *
 * A trigger on the table (migration 0095) sends a NOTIFY on every insert,
 * update of role / deleted_at / key, and delete, whichever code path wrote the
 * row. PostgreSQL delivers it at commit and drops it on rollback, and only to
 * sessions listening at that moment, so a caller re-checks what it holds each
 * time listening starts.
 *
 * postgres.js gives `listen` a dedicated connection, re-listens when it drops
 * (retrying with backoff) and calls the listen callback again each time. This
 * module keeps its own stopped flag to ignore late notifications after `stop`.
 * postgres.js does not say whether it is listening right now, so liveness is
 * answered by a real round trip on a probe channel.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { rawPg } from "@core/db/client.js";
import { CANONICAL_UUID } from "@core/db/canonical-uuid.js";

/** The channel the 0095 trigger notifies on. */
export const PROJECT_MEMBER_CHANGED_CHANNEL = "project_member_changed";

/** The channel a listener's `probe` round-trips on. */
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
  /**
   * Whether this listener receives notifications right now: send a random
   * nonce on the probe channel and wait for it to come back.
   */
  probe: (timeoutMs: number) => Promise<boolean>;
}

const changeSchema = z.object({
  projectId: z.string().regex(CANONICAL_UUID),
  userId: z.string().regex(CANONICAL_UUID),
});

/** The channel the 0131 triggers notify on (#1580). */
export const LIVE_UPDATES_CHANNEL = "live_updates";

/** The channel a live-updates listener's `probe` round-trips on. */
const LIVE_UPDATES_PROBE_CHANNEL = "live_updates_listen_probe";

/**
 * One committed change a Project page shows: a person's bell (`notifications`), a Project's transfer
 * (`project-transfer`) or a Studio's credits (`credits`). It names the kind and one id, nothing of the row.
 */
export type LiveUpdate =
  | { k: "notifications"; u: string }
  | { k: "project-transfer"; p: string }
  | { k: "credits"; s: string };

/** What a live-updates listener calls. */
export interface LiveUpdatesHandlers {
  /** A committed change. */
  onUpdate: (update: LiveUpdate) => void;
  /** Listening started: the first time, and after every reconnect. */
  onListening: () => void;
  /** A notification on the channel that is not an update; the raw payload. */
  onInvalid: (raw: string) => void;
}

/** A running live-updates listener; the same shape as {@link MemberChangeListener}. */
export type LiveUpdatesListener = MemberChangeListener;

const liveUpdateSchema = z.discriminatedUnion("k", [
  z.strictObject({ k: z.literal("notifications"), u: z.string().regex(CANONICAL_UUID) }),
  z.strictObject({ k: z.literal("project-transfer"), p: z.string().regex(CANONICAL_UUID) }),
  z.strictObject({ k: z.literal("credits"), s: z.string().regex(CANONICAL_UUID) }),
]);

/**
 * Read one notification payload against a schema.
 * @param schema - What a valid payload is.
 * @param raw - The payload.
 * @returns The value, or null when it is not one.
 */
function readPayload<T>(schema: z.ZodType<T>, raw: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Listen on one trigger channel of the process pool's database, with a probe channel of its own.
 * @param channel - The channel the trigger notifies on.
 * @param probeChannel - The channel `probe` round-trips on.
 * @param schema - What a valid payload is.
 * @param handlers - Where values, (re)starts and unreadable payloads go.
 * @returns The running listener, once the first LISTEN has been answered.
 * @throws {Error} When the first LISTEN fails (the database is unreachable).
 */
async function listenTriggerChannel<T>(
  channel: string,
  probeChannel: string,
  schema: z.ZodType<T>,
  handlers: { onValue: (value: T) => void; onListening: () => void; onInvalid: (raw: string) => void },
): Promise<MemberChangeListener> {
  let stopped = false;
  const pending = new Map<string, () => void>();
  await rawPg.listen(
    channel,
    (raw) => {
      if (stopped) return;
      const value = readPayload(schema, raw);
      if (value === null) handlers.onInvalid(raw);
      else handlers.onValue(value);
    },
    () => {
      if (!stopped) handlers.onListening();
    },
  );
  await rawPg.listen(probeChannel, (nonce) => {
    if (!stopped) pending.get(nonce)?.();
  });

  /**
   * Round-trip one nonce through the listen connection.
   * @param timeoutMs - How long to wait for it once it has been sent.
   * @returns True when it came back in time; false when it did not, when the
   *   listener is stopped, or when the send failed.
   */
  const probe = async (timeoutMs: number): Promise<boolean> => {
    if (stopped) return false;
    const nonce = randomUUID();
    const arrived = new Promise<boolean>((resolve) => {
      pending.set(nonce, () => resolve(true));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await rawPg.notify(probeChannel, nonce);
      // The wait starts once the nonce is sent, so it measures delivery over
      // the listen connection, not queueing for a pool connection.
      return await Promise.race([
        arrived,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      pending.delete(nonce);
    }
  };

  return {
    stop: async () => {
      stopped = true;
    },
    probe,
  };
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
  return listenTriggerChannel<MemberChange>(PROJECT_MEMBER_CHANGED_CHANNEL, PROBE_CHANNEL, changeSchema, {
    onValue: handlers.onChange,
    onListening: handlers.onListening,
    onInvalid: handlers.onInvalid,
  });
}

/**
 * Start listening for the changes the 0131 triggers announce (#1580), on the same listen connection as membership
 * changes.
 * @param handlers - Where updates, (re)starts and unreadable payloads go.
 * @returns The running listener, once the first LISTEN has been answered.
 * @throws {Error} When the first LISTEN fails (the database is unreachable).
 */
export async function listenLiveUpdates(handlers: LiveUpdatesHandlers): Promise<LiveUpdatesListener> {
  return listenTriggerChannel<LiveUpdate>(LIVE_UPDATES_CHANNEL, LIVE_UPDATES_PROBE_CHANNEL, liveUpdateSchema, {
    onValue: handlers.onUpdate,
    onListening: handlers.onListening,
    onInvalid: handlers.onInvalid,
  });
}
