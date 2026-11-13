// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Worker's copies of the model keys the web-animation container's calls are sent with (inner#1743): `HARNESS_`
 * plus the key variable a plan's upstream names, so a Worker variable never shares a name with a key of our services.
 */

/** The prefix of the Worker's copy of a model key. */
const HARNESS_KEY_PREFIX = "HARNESS_";

/**
 * The Worker's variable for one upstream key a plan names.
 * @param keyEnv - The upstream's key variable.
 * @returns The Worker's variable name.
 */
export function harnessKeyName(keyEnv: string): string {
  return `${HARNESS_KEY_PREFIX}${keyEnv}`;
}

/**
 * Reads the Worker's copy of the key a plan names.
 * @param env - The bindings.
 * @returns The reader; undefined or empty means not configured.
 */
export function harnessKeyOf(env: object): (keyEnv: string) => string | undefined {
  return (keyEnv) => {
    const value = (env as Record<string, unknown>)[harnessKeyName(keyEnv)];
    return typeof value === "string" ? value : undefined;
  };
}
