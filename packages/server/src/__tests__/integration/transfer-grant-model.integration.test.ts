// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer grant as a state machine, driven by random command sequences
 * against the real ledger (inner#1006 design §7.2–§7.5, test spec P09).
 *
 * After every step: the row never names an asset, `consumed_at` and
 * `voided_at` are never both set, a set `consumed_at` never changes, a voided
 * row never changes, the grant's `transfer/` key is never an asset row (scoped to this run's key,
 * so another suite's rows cannot decide it), and a second
 * upload id is refused by the state the grant is in.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import fc from "fast-check";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { uploadFinishService, uploadGrantRepo } from "@breatic/domain";
import {
  grantRow,
  openTransferGrant,
  seedOwner,
  TRANSFER_TYPE,
  transferJob,
  workerAnswers,
  workerRefuses,
  type GrantRow,
  type SeededOwner,
  type Sql,
} from "@server/__tests__/integration/transfer-grant-fixtures.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const DECLARED = 1500019;
const SAME = "upload-model-same";
const OTHER = "upload-model-other";

let sql: Sql;
let owner: SeededOwner;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "transfer-grant-model-test" },
  });
  owner = await seedOwner(sql);
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type State = "open" | "finishing" | "completed" | "voided";

/** What the model knows about the grant. */
interface Model {
  state: State;
  /** Whether claimSame has been granted: a finish job exists only after one. */
  claimed: boolean;
  /** The last finish run, for a rerun to repeat. */
  lastFinish: { stub: () => void; success: State } | null;
}

/** The real grant plus what earlier steps saw, for the invariants. */
interface Real {
  key: string;
  firstConsumedAt: string | null;
  voidedRow: GrantRow | null;
}

/**
 * The state a row is in, read off its columns.
 * @param row - The grant row.
 * @returns Its state.
 */
function stateOf(row: GrantRow): State {
  if (row.voided_at !== null) return "voided";
  if (row.consumed_at !== null) return "completed";
  if (row.finalizing_upload_id !== null) return "finishing";
  return "open";
}

/**
 * Check every invariant against the row as it now stands.
 * @param model - The model after the step.
 * @param real - The real grant.
 */
async function checkInvariants(model: Model, real: Real): Promise<void> {
  const row = (await grantRow(sql, real.key))!;
  expect(row.asset_id).toBeNull();
  expect(row.consumed_at !== null && row.voided_at !== null).toBe(false);
  if (real.firstConsumedAt !== null) expect(row.consumed_at).toBe(real.firstConsumedAt);
  if (row.consumed_at !== null && real.firstConsumedAt === null) real.firstConsumedAt = row.consumed_at;
  if (real.voidedRow !== null) expect(row).toEqual(real.voidedRow);
  if (row.voided_at !== null && real.voidedRow === null) real.voidedRow = row;
  const assets = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM studio_assets WHERE storage_key = ${real.key}
  `;
  expect(assets[0]!.n).toBe(0);
  expect(stateOf(row)).toBe(model.state);
}

/**
 * Run one finish of the grant with the Worker standing in as `stub` says.
 * @param real - The real grant.
 * @param stub - Installs the Worker's answer.
 */
async function runFinish(real: Real, stub: () => void): Promise<void> {
  stub();
  await uploadFinishService.finishUpload(transferJob(real.key, SAME));
  vi.unstubAllGlobals();
}

/**
 * A finish command: allowed once the grant has been claimed; from
 * `finishing` it lands in `success`, from any other claimed state it changes
 * nothing.
 */
class Finish implements fc.AsyncCommand<Model, Real> {
  /**
   * @param name - What the command is called in a counterexample.
   * @param stub - Installs the Worker's answer.
   * @param success - Where the grant goes from `finishing`.
   */
  constructor(
    readonly name: string,
    readonly stub: () => void,
    readonly success: State,
  ) {}

  /**
   * @param model - The model.
   * @returns Whether the grant has been claimed.
   */
  check(model: Readonly<Model>): boolean {
    return model.claimed;
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    await runFinish(real, this.stub);
    if (model.state === "finishing") model.state = this.success;
    model.lastFinish = { stub: this.stub, success: this.success };
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return this.name;
  }
}

/** Run the last finish again, with the same Worker answer. */
class RerunLastFinish implements fc.AsyncCommand<Model, Real> {
  /**
   * @param model - The model.
   * @returns Whether a finish has run.
   */
  check(model: Readonly<Model>): boolean {
    return model.lastFinish !== null;
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    const last = model.lastFinish!;
    await runFinish(real, last.stub);
    if (model.state === "finishing") model.state = last.success;
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return "rerunLastFinish";
  }
}

/** Claim with the grant's own upload id. */
class ClaimSame implements fc.AsyncCommand<Model, Real> {
  /** @returns Always runnable. */
  check(): boolean {
    return true;
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    const claim = await uploadGrantRepo.claimFinalize({ storageKey: real.key, uploadId: SAME });
    if (model.state === "voided") {
      expect(claim).toEqual({ granted: false, reason: "no_grant" });
    } else {
      expect(claim.granted).toBe(true);
      model.claimed = true;
      if (model.state === "open") model.state = "finishing";
    }
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return "claimSame";
  }
}

/** Claim with a second upload id, once the grant is claimed. */
class ClaimOther implements fc.AsyncCommand<Model, Real> {
  /**
   * @param model - The model.
   * @returns Whether the grant has left `open`.
   */
  check(model: Readonly<Model>): boolean {
    return model.state !== "open";
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    const before = await grantRow(sql, real.key);
    const claim = await uploadGrantRepo.claimFinalize({ storageKey: real.key, uploadId: OTHER });
    const expected = { finishing: "in_flight", completed: "already_registered", voided: "no_grant" } as const;
    expect(claim).toEqual({ granted: false, reason: expected[model.state as Exclude<State, "open">] });
    expect(await grantRow(sql, real.key)).toEqual(before);
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return "claimOther";
  }
}

/** Complete the grant directly, once it is claimed. */
class CompleteTransferGrant implements fc.AsyncCommand<Model, Real> {
  /**
   * @param model - The model.
   * @returns Whether the grant has been claimed.
   */
  check(model: Readonly<Model>): boolean {
    return model.claimed;
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    const done = await uploadGrantRepo.completeTransferGrant(real.key);
    expect(done).toBe(model.state !== "voided");
    if (model.state === "finishing") model.state = "completed";
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return "completeTransferGrant";
  }
}

/** Void the grant as aborted. */
class VoidAborted implements fc.AsyncCommand<Model, Real> {
  /** @returns Always runnable. */
  check(): boolean {
    return true;
  }

  /**
   * @param model - The model.
   * @param real - The real grant.
   * @returns Once the step is applied and checked.
   */
  async run(model: Model, real: Real): Promise<void> {
    const voided = await uploadGrantRepo.voidGrant(real.key, "aborted");
    expect(voided).toBe(model.state === "open" || model.state === "finishing");
    if (voided) model.state = "voided";
    await checkInvariants(model, real);
  }

  /** @returns The command's name. */
  toString(): string {
    return "voidGrant('aborted')";
  }
}

describe("P09: the transfer grant state model", () => {
  it("holds every invariant over random command sequences", async () => {
    const commands = [
      fc.constant(
        new Finish("finishSuccess", () => void workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED }), "completed"),
      ),
      fc.constant(
        new Finish("finishWrongType", () => void workerAnswers({ contentType: "text/plain", sizeBytes: DECLARED }), "voided"),
      ),
      fc.constant(
        new Finish(
          "finishTooLarge",
          () => void workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED + 1 }),
          "voided",
        ),
      ),
      fc.constant(new Finish("finishWorkerRefused", () => void workerRefuses(415, "unsupported_type"), "voided")),
      fc.constant(new RerunLastFinish()),
      fc.constant(new ClaimSame()),
      fc.constant(new ClaimOther()),
      fc.constant(new CompleteTransferGrant()),
      fc.constant(new VoidAborted()),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 12 }), async (cmds) => {
        const key = await openTransferGrant(owner, DECLARED);
        const setup = (): { model: Model; real: Real } => ({
          model: { state: "open", claimed: false, lastFinish: null },
          real: { key, firstConsumedAt: null, voidedRow: null },
        });
        await fc.asyncModelRun(setup, cmds);
      }),
      { numRuns: 20 },
    );
  });
});
