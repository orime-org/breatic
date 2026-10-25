// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a transfer file back (inner#1006 §4.5): `read(key, maxBytes)` asks
 * for one byte more than the cap with a Range, so an object holding more than
 * `maxBytes` is told apart from one holding exactly that many. Cases T40–T45
 * and P06 of the test spec.
 *
 * The adapter's S3 client is a private field, so the SDK's `send` is stubbed
 * on the prototype. The stub answers with a body that is both async-iterable
 * and carries `transformToByteArray`, as the SDK's stream does.
 */

import { Readable } from "node:stream";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const loggerCalls = vi.hoisted(() => vi.fn());

vi.mock("@core/infra/logger.js", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const record = (level: string) => (...args: unknown[]) => loggerCalls(level, ...args);
  const logger = {
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    child: () => logger,
  };
  return { ...real, logger };
});

const { S3StorageAdapter } = await import("@core/infra/storage/s3.js");
const { ObjectMissing, ObjectTooLarge } = (await import("@core/index.js")) as unknown as {
  ObjectMissing: new (...args: never[]) => Error;
  ObjectTooLarge: new (...args: never[]) => Error;
};

const BUCKET = "transfer-test-bucket";
const KEY = "transfer/2026-10-24/1_x.transfer";

/**
 * The adapter under test, pointed at a bucket nobody reaches.
 * @returns The adapter.
 */
function adapter(): InstanceType<typeof S3StorageAdapter> {
  return new S3StorageAdapter({
    bucket: BUCKET,
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    endpoint: "https://r2.test.invalid",
    publicBaseUrl: "https://assets.test.invalid",
  });
}

/**
 * What a GetObject answers with for these bytes.
 * @param bytes - The object's bytes, already cut by the Range.
 * @returns The output, its body readable either way the SDK's is.
 */
function objectOutput(bytes: Uint8Array): { Body: Readable & { transformToByteArray: () => Promise<Uint8Array> } } {
  const body = Object.assign(Readable.from([Buffer.from(bytes)]), {
    transformToByteArray: async () => Uint8Array.from(bytes),
  });
  return { Body: body };
}

/**
 * Bytes of a given length with a recognisable pattern.
 * @param n - How many.
 * @returns The bytes.
 */
function patterned(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i % 251);
}

/**
 * Call `read` on an adapter whose type does not have it yet.
 * @param target - The adapter.
 * @param key - The object's key.
 * @param maxBytes - The cap.
 * @returns What `read` resolves to.
 */
function readOf(
  target: InstanceType<typeof S3StorageAdapter>,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return (target as unknown as { read: (k: string, m: number) => Promise<Uint8Array> }).read(
    key,
    maxBytes,
  );
}

let send: MockInstance<(command: unknown) => Promise<unknown>>;
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  send = vi.spyOn(
    S3Client.prototype as unknown as { send: (command: unknown) => Promise<unknown> },
    "send",
  );
  loggerCalls.mockClear();
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  send.mockRestore();
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

/**
 * How many times anything was logged, through the logger or the console.
 * @returns The count.
 */
function loggedCount(): number {
  return loggerCalls.mock.calls.length + consoleSpies.reduce((n, spy) => n + spy.mock.calls.length, 0);
}

describe("T40 the command sent", () => {
  it("asks for one byte past the cap with a Range", async () => {
    send.mockResolvedValue(objectOutput(patterned(10)));

    await readOf(adapter(), KEY, 1_048_576);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY, Range: "bytes=0-1048576" });
  });
});

describe("T41 exactly at the cap", () => {
  it("returns all 1048576 bytes unchanged", async () => {
    const bytes = patterned(1_048_576);
    send.mockResolvedValue(objectOutput(bytes));

    const read = await readOf(adapter(), KEY, 1_048_576);

    expect(read).toBeInstanceOf(Uint8Array);
    expect(read.length).toBe(1_048_576);
    expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("T42 past the cap", () => {
  it("throws ObjectTooLarge, exported from @breatic/core", async () => {
    send.mockResolvedValue(objectOutput(patterned(1_048_577)));

    await expect(readOf(adapter(), KEY, 1_048_576)).rejects.toBeInstanceOf(ObjectTooLarge);
    expect(loggedCount()).toBe(0);
  });
});

describe("T43 no such object", () => {
  it("throws ObjectMissing", async () => {
    send.mockRejectedValue(
      new NoSuchKey({ message: "The specified key does not exist.", $metadata: { httpStatusCode: 404 } }),
    );

    await expect(readOf(adapter(), KEY, 1_048_576)).rejects.toBeInstanceOf(ObjectMissing);
    expect(loggedCount()).toBe(0);
  });
});

describe("T44 any other storage error", () => {
  it("throws something that is neither ObjectMissing nor ObjectTooLarge", async () => {
    const failure = Object.assign(new Error("We encountered an internal error."), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    });
    send.mockRejectedValue(failure);

    const caught = await readOf(adapter(), KEY, 1_048_576).then(
      () => null,
      (err: unknown) => err,
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ObjectMissing);
    expect(caught).not.toBeInstanceOf(ObjectTooLarge);
    expect(loggedCount()).toBe(0);
  });
});

describe("T45 the library does not log", () => {
  it("logs nothing through the logger or the console while refusing", async () => {
    send.mockResolvedValueOnce(objectOutput(patterned(1_048_577)));
    send.mockRejectedValueOnce(
      new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } }),
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }),
    );

    const settled = await Promise.allSettled([
      readOf(adapter(), KEY, 1_048_576),
      readOf(adapter(), KEY, 1_048_576),
      readOf(adapter(), KEY, 1_048_576),
    ]);

    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected", "rejected"]);
    const reasons = settled.map((s) => (s as PromiseRejectedResult).reason as unknown);
    expect(reasons[0]).toBeInstanceOf(ObjectTooLarge);
    expect(reasons[1]).toBeInstanceOf(ObjectMissing);
    expect(loggedCount()).toBe(0);
  });
});

describe("P06 the cut at maxBytes", () => {
  it("returns n bytes up to the cap and throws ObjectTooLarge past it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4096 }).chain((m) =>
          fc.tuple(fc.constant(m), fc.integer({ min: 1, max: 2 * m })),
        ),
        async ([m, n]) => {
          send.mockReset();
          // What R2 answers to `bytes=0-m`: at most m + 1 bytes of an n-byte object.
          send.mockResolvedValue(objectOutput(patterned(Math.min(n, m + 1))));

          const outcome = await readOf(adapter(), KEY, m).then(
            (bytes) => ({ length: bytes.length }),
            (err: unknown) => ({ err }),
          );

          const command = send.mock.calls[0]?.[0] as GetObjectCommand;
          expect(command.input.Range).toBe(`bytes=0-${m}`);
          if (n <= m) {
            expect(outcome).toEqual({ length: n });
          } else {
            expect((outcome as { err: unknown }).err).toBeInstanceOf(ObjectTooLarge);
          }
        },
      ),
    );
  });
});
