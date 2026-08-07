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
  noteStoreOutcome,
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
    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: false });
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

    // My attempt gave up. The arm sitting there is no longer mine, so I learn
    // nothing about it — and "nothing" must not read as "it worked".
    expect(releaseTimedStoreArm(DOC, mine)).toEqual({ ran: false });

    // So theirs survived, and their store still gets to write.
    expect(consumeTimedStoreArm(DOC)).toBe(true);
    expect(releaseTimedStoreArm(DOC, theirs)).toEqual({ ran: true });
  });

  it("takes the permission out of circulation when nothing spent it", () => {
    // A leftover would otherwise be spent by the library's own
    // change-triggered store, which is the one write this design prevents.
    const arm = armTimedStore(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: false });
    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });

  it("does not touch another document's arm", () => {
    const arm = armTimedStore(DOC);
    armTimedStore(OTHER);

    releaseTimedStoreArm(DOC, arm);

    expect(consumeTimedStoreArm(OTHER)).toBe(true);
  });
});

describe("what an arm brings back", () => {
  // Gate 2 round 3 findings 8 and 6. The unload gate used to answer "did my
  // write land?" by asking "does this document hold anything unstored right
  // now?" — a different question with a different answer. An edit arriving
  // while the write was in flight made a landed write read as refused; a
  // document forgotten mid-attempt made a write that never happened read as
  // stored, and the gate then deleted the rescue file holding the only copy.
  //
  // The arm already identifies one attempt. It carries that attempt's result
  // back to whoever issued it, so the question can be asked precisely.

  it("says our extension never ran when nothing consumed it", () => {
    const arm = armTimedStore(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: false });
  });

  it("says it ran but has not finished when the store is still in flight", () => {
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true });
  });

  it("brings back that the write landed", () => {
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);
    noteStoreOutcome(DOC, "stored");

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true, outcome: "stored" });
  });

  it("brings back that the database refused it", () => {
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);
    noteStoreOutcome(DOC, "refused");

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true, outcome: "refused" });
  });

  it("still says the write landed even though an edit arrived during it", () => {
    // The case that used to read as "refused". Both are true at once: the
    // write landed, AND the document now holds something newer that it does
    // not contain. Two facts, two questions.
    noteDocumentChange(DOC);
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);
    const ticket = beginStore(DOC);
    noteDocumentChange(DOC);
    commitStore(DOC, ticket);
    noteStoreOutcome(DOC, "stored");

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true, outcome: "stored" });
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("brings back nothing for a document forgotten mid-attempt", () => {
    // The case that used to read as "stored" — and had the gate delete the
    // rescue file. An arm from a lifetime that has ended answers nothing.
    const arm = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);
    noteStoreOutcome(DOC, "stored");
    forgetDocument(DOC);

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: false });
  });

  it("ignores an outcome recorded against somebody else's arm", () => {
    const mine = armTimedStore(DOC);
    consumeTimedStoreArm(DOC);
    armTimedStore(DOC);
    noteStoreOutcome(DOC, "stored");

    expect(releaseTimedStoreArm(DOC, mine)).toEqual({ ran: false });
  });
});
