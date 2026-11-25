// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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

/** The channel the 0136 triggers notify on (#1580). */
export const LIVE_UPDATES_CHANNEL = "live_updates";

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

/**
 * A running live-updates listener. It shares the membership listener's connection, whose `probe` already tells whether
 * that connection receives notifications.
 */
export interface LiveUpdatesListener {
  /** Stop delivering; nothing reaches the handlers afterwards. */
  stop: () => Promise<void>;
}

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
 * Listen on one trigger channel of the process pool's database.
 * @param channel - The channel the trigger notifies on.
 * @param schema - What a valid payload is.
 * @param handlers - Where values, (re)starts and unreadable payloads go.
 * @param handlers.onValue - A valid payload.
 * @param handlers.onListening - Listening started, the first time and after every reconnect.
 * @param handlers.onInvalid - A payload that is not valid; the raw text.
 * @returns The running listener and whether it was stopped, once the first LISTEN has been answered.
 * @throws {Error} When the first LISTEN fails (the database is unreachable).
 */
async function listenTriggerChannel<T>(
  channel: string,
  schema: z.ZodType<T>,
  handlers: { onValue: (value: T) => void; onListening: () => void; onInvalid: (raw: string) => void },
): Promise<LiveUpdatesListener & { stopped: () => boolean }> {
  let stopped = false;
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
  return {
    stop: async () => {
      stopped = true;
    },
    stopped: () => stopped,
  };
}

/**
 * Round-trip nonces through the listen connection on a channel of their own.
 * @param probeChannel - The channel the nonces travel on.
 * @param stopped - Whether the listener they check was stopped.
 * @returns The probe, once its LISTEN has been answered.
 * @throws {Error} When the LISTEN fails (the database is unreachable).
 */
async function listenProbe(probeChannel: string, stopped: () => boolean): Promise<MemberChangeListener["probe"]> {
  const pending = new Map<string, () => void>();
  await rawPg.listen(probeChannel, (nonce) => {
    if (!stopped()) pending.get(nonce)?.();
  });

  /**
   * Round-trip one nonce through the listen connection.
   * @param timeoutMs - How long to wait for it once it has been sent.
   * @returns True when it came back in time; false when it did not, when the
   *   listener is stopped, or when the send failed.
   */
  return async (timeoutMs: number): Promise<boolean> => {
    if (stopped()) return false;
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
  const listener = await listenTriggerChannel<MemberChange>(PROJECT_MEMBER_CHANGED_CHANNEL, changeSchema, {
    onValue: handlers.onChange,
    onListening: handlers.onListening,
    onInvalid: handlers.onInvalid,
  });
  return { stop: listener.stop, probe: await listenProbe(PROBE_CHANNEL, listener.stopped) };
}

/**
 * Start listening for the changes the 0136 triggers announce (#1580), on the same listen connection as membership
 * changes.
 * @param handlers - Where updates, (re)starts and unreadable payloads go.
 * @returns The running listener, once the first LISTEN has been answered.
 * @throws {Error} When the first LISTEN fails (the database is unreachable).
 */
export async function listenLiveUpdates(handlers: LiveUpdatesHandlers): Promise<LiveUpdatesListener> {
  const listener = await listenTriggerChannel<LiveUpdate>(LIVE_UPDATES_CHANNEL, liveUpdateSchema, {
    onValue: handlers.onUpdate,
    onListening: handlers.onListening,
    onInvalid: handlers.onInvalid,
  });
  return { stop: listener.stop };
}

/**
 * Tell a person's pages their bell changed, as the notifications trigger does (#1580): for a change no row write
 * makes, a notification coming due.
 * @param userId - The person.
 * @returns Nothing.
 * @throws {Error} When the database refuses the notify.
 */
export async function publishNotificationsChanged(userId: string): Promise<void> {
  const update: LiveUpdate = { k: "notifications", u: userId };
  await rawPg.notify(LIVE_UPDATES_CHANNEL, JSON.stringify(update));
}

/**
 * Tell a Studio's Project pages its credits changed, as the credit-table triggers do (#1580): for a change no row
 * write makes, a hold coming due.
 * @param studioId - The Studio.
 * @returns Nothing.
 * @throws {Error} When the database refuses the notify.
 */
export async function publishStudioCreditsChanged(studioId: string): Promise<void> {
  const update: LiveUpdate = { k: "credits", s: studioId };
  await rawPg.notify(LIVE_UPDATES_CHANNEL, JSON.stringify(update));
}
