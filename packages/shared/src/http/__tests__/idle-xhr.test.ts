// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The eighth item in a page: a delivery whose bytes stop moving is cut and
 * resent (inner#1367).
 *
 * A page reads upload progress only from XMLHttpRequest, so this stands one in
 * whose events follow a script. What the real one does with a socket is the
 * browser's; what this layer does with the events is what is tested here.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { httpRequest } from "@shared/http/request.js";

const IDLE_MS = 100;

/** How one scripted request behaves. */
type Script = "stall" | "steady";

/** Every instance made, with what it was asked. */
const made: ScriptedXhr[] = [];
let scripts: Script[] = [];

/** A stand-in XMLHttpRequest that plays one script. */
class ScriptedXhr {
  upload: { onprogress: (() => void) | null } = { onprogress: null };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseType = "";
  status = 0;
  statusText = "";
  response: ArrayBuffer | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  aborted = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly script: Script;

  constructor() {
    this.script = scripts[made.length] ?? "steady";
    made.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  getAllResponseHeaders(): string {
    return "content-type: text/plain\r\nx-part: 7\r\n";
  }

  send(): void {
    const later = (ms: number, fn: () => void): void => {
      this.timers.push(setTimeout(fn, ms));
    };
    later(10, () => this.upload.onprogress?.());
    if (this.script === "stall") return;
    for (let i = 1; i <= 5; i += 1) later(10 + i * (IDLE_MS / 3), () => this.upload.onprogress?.());
    later(10 + 6 * (IDLE_MS / 3), () => {
      this.status = 200;
      this.statusText = "OK";
      this.response = new TextEncoder().encode("ok").buffer;
      this.onload?.();
    });
  }

  abort(): void {
    this.aborted = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.onabort?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  made.length = 0;
  scripts = [];
});

describe("httpRequest idle timeout in a page", () => {
  it("cuts a delivery that stops moving and resends it", async () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    scripts = ["stall", "steady"];
    const res = await httpRequest(
      "https://ingest.example/part/1",
      { method: "PUT", body: new Uint8Array(1024), headers: { "x-upload-token": "t" } },
      { replaySafe: true, idleTimeoutMs: IDLE_MS },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("x-part")).toBe("7");
    expect(made).toHaveLength(2);
    expect(made[0]?.aborted).toBe(true);
    expect(made[1]?.headers["x-upload-token"]).toBe("t");
    expect(made[1]?.method).toBe("PUT");
  });

  it("lets a delivery that keeps moving finish without a resend", async () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    scripts = ["steady"];
    const res = await httpRequest(
      "https://ingest.example/part/1",
      { method: "PUT", body: new Blob([new Uint8Array(1024)]) },
      { replaySafe: true, idleTimeoutMs: IDLE_MS },
    );
    expect(res.status).toBe(200);
    expect(made).toHaveLength(1);
  });

  it("does not resend a stalled delivery the caller declared unsafe to replay", async () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    scripts = ["stall"];
    await expect(
      httpRequest(
        "https://ingest.example/part/1",
        { method: "PUT", body: new Uint8Array(1024) },
        { replaySafe: false, idleTimeoutMs: IDLE_MS },
      ),
    ).rejects.toThrow(/stopped moving for 100ms/);
    expect(made).toHaveLength(1);
  });

  it("refuses an idle window where there is no XMLHttpRequest", async () => {
    await expect(
      httpRequest(
        "https://ingest.example/part/1",
        { method: "PUT", body: new Uint8Array(1024) },
        { replaySafe: true, idleTimeoutMs: IDLE_MS },
      ),
    ).rejects.toThrow(/no XMLHttpRequest/);
  });
});
