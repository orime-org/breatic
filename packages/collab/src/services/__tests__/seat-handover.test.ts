// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The demote channel: the three things one instance does to a connection whose
 * seat has gone to another of the same person's connections.
 *
 * Each has its own way of going wrong on its own, and none of them shows up
 * anywhere else: skip the `readOnly` write and the connection keeps writing,
 * skip the frame and that browser never learns it went read-only, skip the
 * release and the seat is held by a read-only connection for good.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  createSeatHandover,
  type DemotableConnection,
  type SeatHandoverDeps,
} from "@collab/services/seat-handover.js";

const DOC = "project-p1/canvas-s1";
const MEMBER = "user-a:1000000:inst-a:sock-1";

/** A recording stand-in for one Redis client. */
class FakeRedis {
  public published: { channel: string; payload: string }[] = [];
  public subscribed: string[] = [];
  public failPublish = false;
  private handlers: ((channel: string, payload: string) => void)[] = [];

  on(event: string, handler: (channel: string, payload: string) => void): this {
    if (event === "message") this.handlers.push(handler);
    return this;
  }

  async publish(channel: string, payload: string): Promise<number> {
    if (this.failPublish) throw new Error("publish down");
    this.published.push({ channel, payload });
    // Everything on this channel comes back to every subscriber, this
    // instance included: taking a seat and holding the connection it came
    // from are independent, so there is one path rather than two.
    for (const handler of this.handlers) handler(channel, payload);
    return 1;
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribed.push(channel);
    return 1;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.subscribed = this.subscribed.filter((c) => c !== channel);
    return 1;
  }

  /** Deliver a payload as if another instance had published it. */
  deliver(payload: string): void {
    for (const handler of this.handlers) {
      handler("prefix:collab:seat-demote", payload);
    }
  }
}

let redis: FakeRedis;
let connection: DemotableConnection & { sent: Uint8Array[] };
let forgotten: { documentName: string; member: string }[];

/**
 * Build a handover over one fake client acting as both ends.
 * @param overrides - Dependencies to replace.
 * @returns The handover and the fake.
 */
function build(overrides: Partial<SeatHandoverDeps> = {}): {
  handover: ReturnType<typeof createSeatHandover>;
} {
  const handover = createSeatHandover({
    channelPrefix: "prefix",
    publisher: redis as unknown as SeatHandoverDeps["publisher"],
    subscriber: redis as unknown as SeatHandoverDeps["subscriber"],
    findConnection: (documentName, socketId) =>
      documentName === DOC && socketId === "sock-1" ? connection : undefined,
    forgetSeat: async (documentName, member) => {
      forgotten.push({ documentName, member });
    },
    ...overrides,
  });
  return { handover };
}

beforeEach(() => {
  redis = new FakeRedis();
  forgotten = [];
  const sent: Uint8Array[] = [];
  connection = {
    sent,
    readOnly: false,
    webSocket: {
      send(data: Uint8Array): void {
        sent.push(data);
      },
    },
  };
});

describe("seat handover — carrying out a demote", () => {
  it("does all three parts for a connection this instance holds", async () => {
    const { handover } = build();
    await handover.start();

    redis.deliver(JSON.stringify({ documentName: DOC, member: MEMBER }));
    await Promise.resolve();

    expect(connection.readOnly).toBe(true);
    expect(connection.sent.length).toBe(1);
    expect(forgotten).toEqual([{ documentName: DOC, member: MEMBER }]);
  });

  it("addresses the frame to the document it is about", async () => {
    // The client routes an incoming frame by the address it carries. A frame
    // addressed to the wrong document is dropped by the provider, so the tab
    // would go read-only on the server and never say so on screen.
    const { handover } = build();
    await handover.start();

    redis.deliver(JSON.stringify({ documentName: DOC, member: MEMBER }));
    await Promise.resolve();

    const frame = connection.sent[0]!;
    expect(new TextDecoder().decode(frame)).toContain(DOC);
  });

  it("does nothing for a socket another instance holds", async () => {
    const { handover } = build();
    await handover.start();

    redis.deliver(
      JSON.stringify({
        documentName: DOC,
        member: "user-a:1000000:inst-b:sock-99",
      }),
    );
    await Promise.resolve();

    expect(connection.readOnly).toBe(false);
    expect(connection.sent.length).toBe(0);
    expect(forgotten).toEqual([]);
  });

  it("does nothing for a member it cannot take apart", async () => {
    const { handover } = build();
    await handover.start();

    redis.deliver(
      JSON.stringify({ documentName: DOC, member: "not-a-member" }),
    );
    await Promise.resolve();

    expect(connection.readOnly).toBe(false);
    expect(forgotten).toEqual([]);
  });

  it("ignores a payload that is not a demote request", async () => {
    const { handover } = build();
    await handover.start();

    redis.deliver("{ not json");
    redis.deliver(JSON.stringify({ documentName: DOC }));
    redis.deliver(JSON.stringify({ member: MEMBER }));
    await Promise.resolve();

    expect(connection.readOnly).toBe(false);
    expect(forgotten).toEqual([]);
  });
});

describe("seat handover — asking for one", () => {
  it("carries the deployment's prefix in the channel name", async () => {
    const { handover } = build();
    await handover.start();

    await handover.requestDemote(DOC, MEMBER);

    // Pub/sub is not scoped by database number, so this prefix is the only
    // thing keeping two deployments on one Redis out of each other's demotes.
    expect(redis.subscribed).toEqual(["prefix:collab:seat-demote"]);
    expect(redis.published[0]?.channel).toBe("prefix:collab:seat-demote");
  });

  it("reaches this instance too, when it is the one holding the connection", async () => {
    const { handover } = build();
    await handover.start();

    await handover.requestDemote(DOC, MEMBER);

    expect(connection.readOnly).toBe(true);
  });

  it("does not throw when the request cannot be published", async () => {
    const { handover } = build();
    await handover.start();
    redis.failPublish = true;

    await expect(handover.requestDemote(DOC, MEMBER)).resolves.toBeUndefined();
  });

  it("stops answering once it is stopped", async () => {
    const { handover } = build();
    await handover.start();

    await handover.stop();

    expect(redis.subscribed).toEqual([]);
  });
});
