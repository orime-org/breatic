// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a Dock click, a relaunch or a stray link does (#1599, design §5,
 * §5.1), and when closing the connect window ends the app. A build that
 * is bound to a server (saved, or carried by the build) never offers the address form: with nothing on screen it
 * shows "can't reach" with Retry. A first load still in progress gets no
 * second window. Closing the connect window quits on Windows and Linux only
 * when no app window is on screen.
 */

import { describe, it, expect } from "vitest";

import { activateAction, quitsWhenConnectCloses } from "@desktop/main/window-policy.js";

const none = { connectOpen: false, visibleWindow: false, loadingWindow: false, server: null, boundServer: "" };

describe("activateAction", () => {
  it("brings the connect window forward while it is open", () => {
    expect(activateAction({ ...none, connectOpen: true, visibleWindow: true, server: "https://a.test" })).toBe("focus-connect");
  });

  it("brings the most recent visible app window forward", () => {
    expect(activateAction({ ...none, visibleWindow: true, server: "https://a.test" })).toBe("focus-window");
  });

  it("waits for a first load still in progress", () => {
    expect(activateAction({ ...none, loadingWindow: true, server: "https://a.test" })).toBe("wait");
  });

  it("opens a window on the server it already showed, once every window was closed", () => {
    expect(activateAction({ ...none, server: "https://a.test" })).toBe("new-window");
  });

  it("shows can't-reach for the server it is bound to (saved or built in) and has not shown", () => {
    expect(activateAction({ ...none, boundServer: "https://a.test" })).toBe("unreachable");
  });

  it("offers the address form only to a client bound to no server", () => {
    expect(activateAction(none)).toBe("connect");
  });
});

describe("quitsWhenConnectCloses", () => {
  it("quits on Windows and Linux when nothing else is on screen", () => {
    expect(quitsWhenConnectCloses({ platform: "win32", visibleWindow: false })).toBe(true);
    expect(quitsWhenConnectCloses({ platform: "linux", visibleWindow: false })).toBe(true);
  });

  it("keeps running beside a visible app window, and always on macOS", () => {
    expect(quitsWhenConnectCloses({ platform: "win32", visibleWindow: true })).toBe(false);
    expect(quitsWhenConnectCloses({ platform: "darwin", visibleWindow: false })).toBe(false);
  });
});
