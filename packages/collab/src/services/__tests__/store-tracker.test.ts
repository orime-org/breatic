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
    const covered = beginStore(DOC);
    commitStore(DOC, covered);
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
    const covered = beginStore(DOC);
    noteDocumentChange(DOC);
    commitStore(DOC, covered);
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
    armTimedStore(DOC);
    forgetDocument(DOC);
    expect(consumeTimedStoreArm(DOC)).toBe(false);
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
