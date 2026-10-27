// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a bounded read of a stored object can refuse with (inner#1006). The
 * caller decides what each means for its request; this library only names it.
 */

/** No object is stored under the key. */
export class ObjectMissing extends Error {
  /**
   * Name the key nothing is stored under.
   * @param key - The key that names nothing.
   */
  constructor(readonly key: string) {
    super(`No object is stored under ${key}`);
    this.name = "ObjectMissing";
  }
}

/** The object holds more bytes than the read allows. */
export class ObjectTooLarge extends Error {
  /**
   * Name the object that is too large.
   * @param key - The key of the object that is too large.
   */
  constructor(readonly key: string) {
    super(`The object under ${key} is larger than the read allows`);
    this.name = "ObjectTooLarge";
  }
}
