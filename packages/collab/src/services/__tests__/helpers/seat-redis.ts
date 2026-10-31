// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A real ioredis client with a thin layer in front of it, for the seat
 * registry's integration tests (inner#1034).
 *
 * The registry is handed the wrapped client. Every command it sends still
 * reaches the real Redis, in the order it was called: the layer only records
 * the call and, when a test asks for it, changes what comes BACK. It never
 * delays a command before it is sent. Holding a command back would let a
 * later ZREM reach Redis ahead of an earlier EVAL, an order production can
 * never produce, because one client executes its commands in sending order.
 *
 * Three ways a test can change what comes back:
 *
 *   reject-before-send  the command is never sent; the call rejects
 *   send-then-reject    the command runs in Redis, then the call rejects the
 *                       way ioredis's `commandTimeout` does
 *   hold                the command runs in Redis, and its reply is kept until
 *                       the test releases it
 */

import type { Redis } from "@breatic/core";

/** One command the registry sent (or tried to send). */
export interface LoggedCall {
  /** Command name, lower case; every script invocation is logged as `eval`. */
  name: string;
  /** Its arguments as the registry passed them. */
  args: unknown[];
}

/** A failure to inject into the next matching command. */
export type Fault = "reject-before-send" | "send-then-reject";

/** A held reply. */
export interface HeldReply {
  /** Resolves once Redis has executed the command (its reply is in hand). */
  executed: Promise<void>;
  /** Hand the reply to the caller. */
  release(): void;
}

/** What the reply of an un-faulted script call is passed through. */
export type ReplyGate = (reply: Promise<unknown>, call: LoggedCall) => Promise<unknown>;

/** The wrapped client and its controls. */
export interface WrappedRedis {
  /** Hand this to the registry. */
  client: Redis;
  /** Every intercepted call, in calling order. */
  log: LoggedCall[];
  /**
   * Inject a fault into the next `times` calls of `name` (`"*"` matches any
   * intercepted command).
   */
  fail(name: string, fault: Fault, times?: number): void;
  /** Hold the reply of the next call of `name`. */
  hold(name: string): HeldReply;
  /** Route every later un-faulted script reply through `gate` (undefined to stop). */
  gateScripts(gate: ReplyGate | undefined): void;
  /** Drop every fault and hold not yet consumed. */
  clearRules(): void;
  /** Resolve once every command already sent on this client has executed. */
  flush(): Promise<void>;
}

/** Commands passed through the recording layer. Anything else goes straight through. */
const INTERCEPTED = new Set([
  "eval",
  "evalsha",
  "evalsha_ro",
  "eval_ro",
  "fcall",
  "call",
  "zadd",
  "zrem",
  "zrange",
  "zrangebyscore",
  "zrevrange",
  "zrevrangebyscore",
  "zscore",
  "zmscore",
  "zcard",
  "zcount",
  "zremrangebyscore",
  "zscan",
  "expire",
  "pexpire",
  "del",
  "exists",
]);

const SCRIPT_COMMANDS = new Set(["eval", "evalsha", "eval_ro", "evalsha_ro", "fcall"]);

type Rule =
  | { kind: Fault }
  | { kind: "hold"; executed: () => void; released: Promise<void> };

/**
 * Wrap a real client.
 * @param real - A dedicated ioredis client (not shared with another registry).
 * @returns The wrapper and its controls.
 */
export function wrapRedis(real: Redis): WrappedRedis {
  const log: LoggedCall[] = [];
  const rules = new Map<string, Rule[]>();
  let gate: ReplyGate | undefined;

  const nextRule = (name: string): Rule | undefined => {
    for (const key of [name, "*"]) {
      const queue = rules.get(key);
      if (queue && queue.length > 0) return queue.shift();
    }
    return undefined;
  };

  const push = (name: string, rule: Rule): void => {
    const queue = rules.get(name) ?? [];
    queue.push(rule);
    rules.set(name, queue);
  };

  const invoke = (prop: string, fn: (...a: unknown[]) => unknown, args: unknown[]): Promise<unknown> => {
    let name = prop.toLowerCase();
    let shown = args;
    if (name === "call" && typeof args[0] === "string") {
      name = args[0].toLowerCase();
      shown = args.slice(1);
    }
    if (SCRIPT_COMMANDS.has(name)) name = "eval";
    const call: LoggedCall = { name, args: shown };
    log.push(call);
    const rule = nextRule(name);
    if (rule?.kind === "reject-before-send") return Promise.reject(new Error("injected"));
    // Sent now, synchronously, in calling order — whatever happens to the reply.
    const sent = Promise.resolve(fn.apply(real, args));
    if (rule?.kind === "send-then-reject") {
      return sent.then(
        () => {
          throw new Error("Command timed out");
        },
        () => {
          throw new Error("Command timed out");
        },
      );
    }
    if (rule?.kind === "hold") {
      return sent.then(
        async (reply) => {
          rule.executed();
          await rule.released;
          return reply;
        },
        async (err: unknown) => {
          rule.executed();
          await rule.released;
          throw err;
        },
      );
    }
    if (name === "eval" && gate) return gate(sent, call);
    return sent;
  };

  const client = new Proxy(real, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (INTERCEPTED.has(prop.toLowerCase())) {
        return (...args: unknown[]): Promise<unknown> => invoke(prop, fn, args);
      }
      return fn.bind(target);
    },
  });

  return {
    client,
    log,
    fail(name: string, fault: Fault, times = 1): void {
      for (let i = 0; i < times; i++) push(name, { kind: fault });
    },
    hold(name: string): HeldReply {
      let executed!: () => void;
      let release!: () => void;
      const executedP = new Promise<void>((resolve) => {
        executed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      push(name, { kind: "hold", executed, released });
      return { executed: executedP, release };
    },
    gateScripts(next: ReplyGate | undefined): void {
      gate = next;
    },
    clearRules(): void {
      rules.clear();
    },
    async flush(): Promise<void> {
      // A command the registry sends after a few awaits of its own has to be
      // on the wire before the PING, or the PING proves nothing about it.
      for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      await real.ping();
    },
  };
}

/**
 * The member string a seat is stored under.
 * @param userId - Who holds it.
 * @param arrivedAtMs - When that connection entered the document.
 * @param instanceId - The instance holding it.
 * @param socketId - Its socket.
 * @returns `{userId}:{arrivedAtMs}:{instanceId}:{socketId}`.
 */
export function m(userId: string, arrivedAtMs: number | string, instanceId: string, socketId: string): string {
  return `${userId}:${arrivedAtMs}:${instanceId}:${socketId}`;
}

/**
 * Every script call in a log slice whose arguments name the given key.
 * @param log - The log, or a slice of it.
 * @param key - The seat key.
 * @returns The matching calls.
 */
export function evalsOn(log: LoggedCall[], key: string): LoggedCall[] {
  return log.filter((c) => c.name === "eval" && c.args.includes(key));
}

/**
 * Every ZREM in a log slice that removes `member` from `key`.
 * @param log - The log, or a slice of it.
 * @param key - The seat key.
 * @param member - The member.
 * @returns The matching calls.
 */
export function zremsOf(log: LoggedCall[], key: string, member: string): LoggedCall[] {
  return log.filter((c) => c.name === "zrem" && c.args[0] === key && c.args.slice(1).flat().includes(member));
}
