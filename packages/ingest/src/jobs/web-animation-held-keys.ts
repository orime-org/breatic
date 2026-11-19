// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { WebAnimationJobEffect, WebAnimationJobRecord } from "@ingest/jobs/web-animation-transition.js";

/**
 * The keys a web-animation job's model calls run on, by upstream, as its submit carried them (inner#1953). Memory only:
 * never written to storage or the job record, so a restarted object holds none and the job's next call ends as
 * `key_lost_on_restart`.
 */
export class HeldKeys {
  private keys: Readonly<Record<string, string>> | null = null;

  /**
   * Hold the keys a submit carried, only when the job it answered is running.
   * @param state - The job's state after the submit; undefined when there is no record.
   * @param keys - The keys the submit carried, opened.
   * @returns Nothing.
   */
  afterSubmit(state: WebAnimationJobRecord["state"] | undefined, keys: Readonly<Record<string, string>>): void {
    if (state === "running") this.keys = keys;
  }

  /**
   * Drop the keys on the transition that destroys the job.
   * @param effects - The transition's effects.
   * @returns Nothing.
   */
  afterEffects(effects: readonly WebAnimationJobEffect[]): void {
    if (effects.includes("destroy")) this.keys = null;
  }

  /**
   * The keys held now.
   * @returns Them, or null when none are held.
   */
  current(): Readonly<Record<string, string>> | null {
    return this.keys;
  }
}
