// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A stateful stand-in for the two Stripe calls the refund disposition makes:
 * `refunds.list({ payment_intent })` and `refunds.create(params, options)`
 * (inner#1410 §5.2, §5.3). Not a test file: the internal API suites inject it
 * at `@server/infra/stripe.js`.
 *
 * It keeps each payment intent's refunds the way Stripe does, so a refund the
 * product creates shows up in the next list, and a create without `amount`
 * refunds "the remaining, unrefunded amount". Every call is recorded with its
 * exact arguments, which is how the suites prove a disposition created at most
 * one refund, under which idempotency key, and for how much.
 *
 * Errors are real stripe-node error objects, so whatever the classifier reads
 * off them (`statusCode`, `code`, `headers`, the raw `type`) is what Stripe's
 * own SDK would hand it.
 */

import Stripe from "stripe";

export type FakeRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

/** The refund object fields the product reads. */
export interface FakeRefund {
  id: string;
  object: "refund";
  amount: number;
  currency: string;
  status: FakeRefundStatus;
  payment_intent: string;
  metadata: Record<string, string>;
  failure_reason: string | null;
  created: number;
}

/** How the next `refunds.create` answers. */
export type CreateBehavior =
  | { kind: "refund"; status: FakeRefundStatus }
  | { kind: "error"; error: Error }
  | { kind: "hang"; until: Promise<void>; then: CreateBehavior };

interface CreateCall {
  params: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

let counter = 0;

/**
 * A refund id that never repeats within a run.
 * @param label - Readable part.
 * @returns `re_…`.
 */
export function fakeRefundId(label: string): string {
  counter += 1;
  return `re_${label}_${counter}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A Stripe API error as stripe-node builds it from an HTTP answer.
 * @param httpStatus - The HTTP status Stripe answered with.
 * @param opts - The error body fields and the retry header.
 * @param opts.code - Stripe's error `code`.
 * @param opts.type - Stripe's error `type`; derived from the status when absent.
 * @param opts.shouldRetry - The `Stripe-Should-Retry` header, when sent.
 * @returns The error object.
 */
export function stripeError(
  httpStatus: number,
  opts: { code?: string; type?: string; shouldRetry?: boolean } = {},
): Error {
  const type =
    opts.type ?? (httpStatus >= 500 ? "api_error" : httpStatus === 429 ? "rate_limit_error" : "invalid_request_error");
  const headers: Record<string, string> = {};
  if (opts.shouldRetry !== undefined) headers["stripe-should-retry"] = String(opts.shouldRetry);
  // stripe-node exports the factory it builds errors from HTTP answers with,
  // but its typings leave it out.
  const { generateV1Error } = Stripe.errors as unknown as {
    generateV1Error: (raw: Record<string, unknown>) => Error;
  };
  return generateV1Error({
    type,
    message: `synthetic ${httpStatus}`,
    code: opts.code,
    statusCode: httpStatus,
    headers,
  });
}

/** The thing `refunds.list` returns, as far as the product reads it. */
type FakeApiList = Promise<unknown> & {
  autoPagingToArray: (opts?: unknown) => Promise<FakeRefund[]>;
  autoPagingEach: (fn: (r: FakeRefund) => unknown) => Promise<void>;
  [Symbol.asyncIterator]: () => AsyncGenerator<FakeRefund>;
};

/**
 * The thing `refunds.list` returns: a promise of one page that can also be
 * auto-paged or iterated, as stripe-node's `ApiListPromise` can.
 * @param answer - The refunds, or the error every way of reading it throws.
 * @returns The list promise.
 */
function apiList(answer: Promise<FakeRefund[]>): FakeApiList {
  const page = answer.then((data) => ({ object: "list", data, has_more: false, url: "/v1/refunds" }));
  // Read through another method, the bare promise is never awaited.
  page.catch(() => undefined);
  return Object.assign(page, {
    autoPagingToArray: () => answer,
    autoPagingEach: async (fn: (r: FakeRefund) => unknown) => {
      for (const r of await answer) await fn(r);
    },
    [Symbol.asyncIterator]: async function* () {
      yield* await answer;
    },
  });
}

/** Stripe, as far as the refund disposition talks to it. */
export class FakeStripeRefunds {
  private readonly refunds = new Map<string, FakeRefund[]>();
  private readonly paid = new Map<string, number>();
  private readonly script: CreateBehavior[] = [];
  private listFailure: Error | null = null;
  private readonly listFailureFor = new Map<string, Error>();
  readonly listCalls: Record<string, unknown>[] = [];
  readonly createCalls: CreateCall[] = [];

  /** The object handed out as the Stripe client. */
  readonly client = {
    refunds: {
      list: (params: Record<string, unknown>) => this.list(params),
      create: (params: Record<string, unknown>, options?: Record<string, unknown>) =>
        this.create(params, options),
    },
  };

  /** Forget every payment, refund, script and recorded call. */
  reset(): void {
    this.refunds.clear();
    this.paid.clear();
    this.script.length = 0;
    this.listFailure = null;
    this.listFailureFor.clear();
    this.listCalls.length = 0;
    this.createCalls.length = 0;
  }

  /**
   * A payment intent Stripe knows about, with the refunds it already has.
   * @param paymentIntent - `pi_…`.
   * @param paidCents - What was charged.
   * @param existing - Refunds already on it.
   */
  register(paymentIntent: string, paidCents: number, existing: Omit<FakeRefund, "object" | "payment_intent" | "created">[] = []): void {
    this.paid.set(paymentIntent, paidCents);
    this.refunds.set(
      paymentIntent,
      existing.map((r) => ({ ...r, object: "refund", payment_intent: paymentIntent, created: 1_700_000_000 })),
    );
  }

  /**
   * Make every `refunds.list` throw until cleared.
   * @param error - What to throw; null restores normal answers.
   */
  failLists(error: Error | null): void {
    this.listFailure = error;
  }

  /**
   * Make `refunds.list` of one payment intent throw until cleared; the
   * others answer normally.
   * @param paymentIntent - `pi_…`.
   * @param error - What to throw; null restores normal answers.
   */
  failListFor(paymentIntent: string, error: Error | null): void {
    if (error === null) this.listFailureFor.delete(paymentIntent);
    else this.listFailureFor.set(paymentIntent, error);
  }

  /**
   * The payment intents `refunds.list` was called for, in call order.
   * @returns One entry per call.
   */
  listedIntents(): string[] {
    return this.listCalls.map((p) => String(p.payment_intent));
  }

  /**
   * Queue how the next `refunds.create` answers. Unqueued calls succeed.
   * @param behavior - The answer.
   */
  nextCreate(behavior: CreateBehavior): void {
    this.script.push(behavior);
  }

  /**
   * Change a refund's status on Stripe, as Stripe would later.
   * @param refundId - The refund.
   * @param status - Its new status.
   */
  setStatus(refundId: string, status: FakeRefundStatus): void {
    for (const list of this.refunds.values()) {
      const r = list.find((x) => x.id === refundId);
      if (r) r.status = status;
    }
  }

  /**
   * The refunds Stripe holds for a payment intent, copied.
   * @param paymentIntent - `pi_…`.
   * @returns The refunds.
   */
  refundsOf(paymentIntent: string): FakeRefund[] {
    return structuredClone(this.refunds.get(paymentIntent) ?? []);
  }

  private list(params: Record<string, unknown>): FakeApiList {
    this.listCalls.push(structuredClone(params));
    const pi = String(params.payment_intent);
    const failure = this.listFailure ?? this.listFailureFor.get(pi) ?? null;
    return apiList(failure ? Promise.reject(failure) : Promise.resolve(structuredClone(this.refunds.get(pi) ?? [])));
  }

  private async create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<FakeRefund> {
    this.createCalls.push({ params: structuredClone(params), options: options ? structuredClone(options) : undefined });
    return this.answer(this.script.shift() ?? { kind: "refund", status: "succeeded" }, params);
  }

  private async answer(behavior: CreateBehavior, params: Record<string, unknown>): Promise<FakeRefund> {
    if (behavior.kind === "hang") {
      await behavior.until;
      return this.answer(behavior.then, params);
    }
    if (behavior.kind === "error") throw behavior.error;
    const pi = String(params.payment_intent);
    const paid = this.paid.get(pi);
    if (paid === undefined) throw new Error(`fake Stripe: unknown payment intent ${pi}`);
    const list = this.refunds.get(pi) ?? [];
    const held = list
      .filter((r) => r.status === "succeeded" || r.status === "pending" || r.status === "requires_action")
      .reduce((sum, r) => sum + r.amount, 0);
    const refund: FakeRefund = {
      id: fakeRefundId("created"),
      object: "refund",
      amount: typeof params.amount === "number" ? params.amount : paid - held,
      currency: "usd",
      status: behavior.status,
      payment_intent: pi,
      metadata: { ...((params.metadata as Record<string, string> | undefined) ?? {}) },
      failure_reason: behavior.status === "failed" ? "lost_or_stolen_card" : null,
      created: 1_700_000_100,
    };
    this.refunds.set(pi, [...list, refund]);
    return structuredClone(refund);
  }
}

/** The one instance the mocked `getStripeClient` hands out. */
export const fakeStripe = new FakeStripeRefunds();

/**
 * Wrap the next `refunds.list` call. On that call the list method is
 * restored, then `around` is handed `read`, which does the real list read
 * (recording the call and reading what Stripe holds at that moment);
 * whatever `around` resolves to, or throws, is what every way of reading the
 * list (`await`, `autoPagingToArray`, `autoPagingEach`, `for await`) sees.
 * @param fake - The fake whose next list call to wrap.
 * @param around - Runs in place of the read; may wait, read, write, or throw.
 */
export function aroundNextList(
  fake: FakeStripeRefunds,
  around: (read: () => Promise<FakeRefund[]>) => Promise<FakeRefund[]>,
): void {
  const original = fake.client.refunds.list;
  fake.client.refunds.list = (params: Record<string, unknown>) => {
    fake.client.refunds.list = original;
    return apiList(around(() => original(params).autoPagingToArray()));
  };
}

/**
 * Run `hook` once, at the start of the next `refunds.list` call, before that
 * call reads what Stripe holds. It lets a suite change Stripe between a
 * create answer and the list read that follows it (a refund that moved on
 * since), or note what had already been called when the first read came.
 * The list method is restored on that call, before the hook runs.
 * @param fake - The fake whose next list call to hook.
 * @param hook - What to do first.
 */
export function beforeNextList(fake: FakeStripeRefunds, hook: () => void): void {
  aroundNextList(fake, (read) => {
    hook();
    return read();
  });
}

/**
 * A gate a stubbed call waits on.
 * @returns The promise to wait on and the function that opens it.
 */
export function gate(): { until: Promise<void>; open: () => void } {
  let open!: () => void;
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}
