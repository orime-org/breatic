// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from "vitest";

import {
  armTimedStore,
  beginStore,
  commitStore,
  consumeTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
  noteDocumentChange,
  releaseTimedStoreArm,
} from "@collab/services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";
const OTHER = "project-11111111-1111-4111-8111-111111111111/document-2";

beforeEach(() => {
  forgetDocument(DOC);
  forgetDocument(OTHER);
});

describe("hasUnsavedContent", () => {
  it("is false for a document nothing has happened to", () => {
    expect(hasUnsavedContent(DOC)).toBe(false);
  });

  it("becomes true after a change", () => {
    noteDocumentChange(DOC);
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("becomes false again once a store commits what it covered", () => {
    noteDocumentChange(DOC);
    const ticket = beginStore(DOC);
    commitStore(DOC, ticket);
    expect(hasUnsavedContent(DOC)).toBe(false);
  });

  it("stays true when a store never commits — a failed store changes nothing", () => {
    noteDocumentChange(DOC);
    beginStore(DOC);
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("stays true for a change that lands WHILE the store is in flight", () => {
    // The whole reason beginStore returns a value instead of commitStore
    // reading the counter itself: the write takes time, and anything typed
    // during it is not in the bytes that were handed to the database.
    noteDocumentChange(DOC);
    const ticket = beginStore(DOC);
    noteDocumentChange(DOC);
    commitStore(DOC, ticket);
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("ignores a commit from a write that was abandoned before the document went", () => {
    // Nothing can cancel a database write in flight, so one the caller gave
    // up on can still land minutes later. If it recorded what it covered
    // after the document had been forgotten, the count would come back with
    // no `changeCount` beside it and the document would read as saved until
    // it accumulated more changes than the orphan claimed. Gate 2 reproduced
    // exactly that with a 40-change session.
    for (let i = 0; i < 40; i += 1) noteDocumentChange(DOC);
    const abandoned = beginStore(DOC);
    forgetDocument(DOC);

    commitStore(DOC, abandoned);

    noteDocumentChange(DOC);
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("tracks each document separately", () => {
    noteDocumentChange(DOC);
    expect(hasUnsavedContent(OTHER)).toBe(false);
  });

  it("forgets a document completely, so a reload starts clean", () => {
    noteDocumentChange(DOC);
    forgetDocument(DOC);
    expect(hasUnsavedContent(DOC)).toBe(false);
  });
});

describe("the timed-store arm", () => {
  it("is not armed by default — an unarmed store must not write", () => {
    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });

  it("is consumed exactly once", () => {
    armTimedStore(DOC);
    expect(consumeTimedStoreArm(DOC)).toBe(true);
    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });

  it("arms one document without arming another", () => {
    armTimedStore(DOC);
    expect(consumeTimedStoreArm(OTHER)).toBe(false);
    expect(consumeTimedStoreArm(DOC)).toBe(true);
  });

  it("does not survive being forgotten", () => {
    const arm = armTimedStore(DOC);
    forgetDocument(DOC);
    expect(consumeTimedStoreArm(DOC)).toBe(false);
    expect(releaseTimedStoreArm(DOC, arm)).toBe(false);
  });

  it("arming twice still only permits one store", () => {
    // Two arms in a row would otherwise let a change-triggered store slip
    // through on the leftover one.
    armTimedStore(DOC);
    armTimedStore(DOC);
    expect(consumeTimedStoreArm(DOC)).toBe(true);
    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });
});

describe("giving an arm back", () => {
  // Gate 2 round 2 finding 8. Both writers reclaim their arm when they stop
  // waiting, because a chain aborted upstream never reaches the persistence
  // extension and would otherwise leave the arm behind for the next
  // change-triggered store to spend. With the arm keyed only by document
  // name, that reclamation could take back an arm somebody else had just
  // issued — and the store it belonged to then wrote nothing at all.

  it("takes back only the arm this caller issued", () => {
    const mine = armTimedStore(DOC);
    const theirs = armTimedStore(DOC);

    // My attempt gave up. The arm sitting there is no longer mine.
    expect(releaseTimedStoreArm(DOC, mine)).toBe(false);

    // So theirs survived, and their store still gets to write.
    expect(consumeTimedStoreArm(DOC)).toBe(true);
    expect(releaseTimedStoreArm(DOC, theirs)).toBe(false);
  });

  it("reports true when the arm was never spent — nothing reached us", () => {
    // The one signal that separates "the database refused" from "an upstream
    // extension aborted the chain, so our hook never ran at all".
    const arm = armTimedStore(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toBe(true);
    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });

  it("reports false once the store consumed it — our hook did run", () => {
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toBe(false);
  });

  it("does not touch another document's arm", () => {
    const arm = armTimedStore(DOC);
    armTimedStore(OTHER);

    releaseTimedStoreArm(DOC, arm);

    expect(consumeTimedStoreArm(OTHER)).toBe(true);
  });
});
