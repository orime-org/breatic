// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A send to a host that resolves to two addresses tries both before it fails
 * (#286).
 *
 * `config/mail.yaml` bounds a stuck send by (addresses x connection timeout)
 * plus the greeting timeout, which holds only if nodemailer moves on to the
 * next resolved address when one times out. This drives the real nodemailer
 * through `sendMail`: the host resolves to two documentation addresses, every
 * TLS connection is pointed at a local server that accepts TCP and never
 * speaks, and the test records which addresses were tried.
 */

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CONNECTION_TIMEOUT_MS = 300;
const ADDRESSES = ["192.0.2.1", "192.0.2.2"];

const mockEnv: Record<string, unknown> = {
  EMAIL_BACKEND: "smtp",
  SMTP_HOST: "rotation.example.test",
  SMTP_PORT: 465,
  SMTP_USER: "user",
  SMTP_PASSWORD: "pass",
  SMTP_FROM: "",
};
vi.mock("@core/config/env.js", () => ({
  get env() { return mockEnv; },
}));
vi.mock("@core/config/mail.js", () => ({
  getSmtpTimeouts: () => ({
    dnsTimeoutMs: 300,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    greetingTimeoutMs: 300,
    socketTimeoutMs: 600,
  }),
}));

describe("mailer — a host with two addresses", () => {
  const accepted = new Set<net.Socket>();
  // Accept and say nothing: the TLS handshake never completes.
  const silent = net.createServer((socket) => accepted.add(socket));
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", done));
    port = (silent.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((done) => silent.close(() => done()));
  });

  it("tries the second address after the first times out", async () => {
    vi.spyOn(dns.Resolver.prototype, "resolve4").mockImplementation(
      ((_host: string, callback: (err: Error | null, addresses: string[]) => void) =>
        callback(null, ADDRESSES)) as typeof dns.Resolver.prototype.resolve4,
    );
    vi.spyOn(dns.Resolver.prototype, "resolve6").mockImplementation(
      ((_host: string, callback: (err: Error | null, addresses: string[]) => void) =>
        callback(null, [])) as typeof dns.Resolver.prototype.resolve6,
    );
    const tried: string[] = [];
    const realConnect = tls.connect.bind(tls);
    vi.spyOn(tls, "connect").mockImplementation(((
      options: tls.ConnectionOptions,
      onConnect?: () => void,
    ) => {
      tried.push(String(options.host));
      return realConnect({ ...options, host: "127.0.0.1", port }, onConnect);
    }) as typeof tls.connect);

    const { sendMail } = await import("../mailer.js");
    const started = performance.now();
    await expect(
      sendMail({ to: "to@example.test", subject: "s", html: "<p>h</p>" }),
    ).rejects.toThrow(/timeout/i);
    const elapsed = performance.now() - started;

    expect([...tried].sort()).toEqual(ADDRESSES);
    expect(elapsed).toBeGreaterThanOrEqual(ADDRESSES.length * CONNECTION_TIMEOUT_MS - 20);
  });
});
