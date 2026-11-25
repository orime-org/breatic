// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What a Space was told about its background work since a mark: the change versions on the task-events stream for its
 * document, and anything still sent on the Project's old `space-tasks:changed` channel, which no writer may use any more
 * (#1580). The channel is read up to a sentinel published after the action, so its silence is a fact, not a timeout.
 */

import crypto from "node:crypto";
import { env, getStreamRedis, taskEventsStreamKey, type Redis } from "@breatic/core";

/** The signals one Space received since the last mark. */
export interface SpaceTaskSignalsRead {
  /** Task-events entries naming the Space's document. */
  doc: Record<string, unknown>[];
  /** Messages for the Space on the Project's old channel. */
  meta: Record<string, unknown>[];
}

/** A running listener for one test file. */
export interface SpaceTaskSignals {
  /** Forget everything seen so far; later reads start here. */
  mark(): Promise<void>;
  /** Read what the Space was told since the last mark. */
  read(place: { projectId: string; spaceId: string; docName: string }): Promise<SpaceTaskSignalsRead>;
  /** Close the listener's connection. */
  stop(): Promise<void>;
}

/**
 * The task-events entry that tells a Space document its background work changed.
 * @param docName - The Space's document.
 * @returns The entry's payload.
 */
export function spaceTasksVersion(docName: string): Record<string, unknown> {
  return { type: "space-tasks-version", docName };
}

/**
 * The Project's old Space-tasks channel name, written out because the shared builder is gone.
 * @param projectId - The Project.
 * @returns The channel.
 */
function oldChannel(projectId: string): string {
  return `${env.REDIS_KEY_PREFIX}:project:${projectId}:space-tasks:changed`;
}

/**
 * Start listening.
 * @returns The listener.
 */
export async function listenSpaceTaskSignals(): Promise<SpaceTaskSignals> {
  const subscriber: Redis = getStreamRedis().duplicate();
  const heard: { channel: string; message: Record<string, unknown> }[] = [];
  subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
    heard.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
  });
  await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
  let since = "0-0";

  /**
   * Publish a sentinel on the Space's old channel and wait until it arrives, so every message sent before it has too.
   * @param projectId - The Project.
   * @returns Nothing.
   * @throws {Error} When the sentinel never arrives.
   */
  async function drain(projectId: string): Promise<void> {
    const sentinel = crypto.randomUUID();
    await getStreamRedis().publish(oldChannel(projectId), JSON.stringify({ sentinel }));
    const deadline = Date.now() + 5000;
    while (!heard.some((h) => h.message.sentinel === sentinel)) {
      if (Date.now() > deadline) throw new Error("the sentinel on the old space-tasks channel never arrived");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return {
    async mark(): Promise<void> {
      heard.length = 0;
      const last = await getStreamRedis().xrevrange(taskEventsStreamKey(), "+", "-", "COUNT", 1);
      since = last[0]?.[0] ?? "0-0";
    },
    async read(place): Promise<SpaceTaskSignalsRead> {
      await drain(place.projectId);
      const doc = (await getStreamRedis().xrange(taskEventsStreamKey(), `(${since}`, "+"))
        .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
        .filter((event) => event.docName === place.docName);
      const meta = heard
        .filter((h) => h.channel === oldChannel(place.projectId) && h.message.sentinel === undefined && h.message.spaceId === place.spaceId)
        .map((h) => h.message);
      return { doc, meta };
    },
    async stop(): Promise<void> {
      await subscriber.quit();
    },
  };
}
