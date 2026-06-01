/**
 * Payment repository — data access for the payments table.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "@breatic/core";
import { payments } from "@breatic/core";
import type { PaymentEntity } from "@breatic/shared";

/**
 * Map a raw `payments` table row to a `PaymentEntity` domain object,
 * defaulting a null `metadata` JSONB column to an empty object.
 * @param row - Raw row selected from the `payments` table
 * @returns The mapped payment entity
 */
function toEntity(row: typeof payments.$inferSelect): PaymentEntity {
  return {
    id: row.id,
    userId: row.userId,
    stripeSessionId: row.stripeSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    creditsGranted: row.creditsGranted,
    metadata: (row.metadata ?? {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a new payment record (status defaults to "pending" at the DB level).
 * @param data - Payment fields to insert
 * @param data.userId - User who initiated the purchase
 * @param data.stripeSessionId - Stripe Checkout session ID for this payment
 * @param data.amountCents - Charge amount in the smallest currency unit (cents)
 * @param data.creditsGranted - Number of credits granted once the payment completes
 * @param data.currency - ISO currency code (defaults to "usd")
 * @param data.metadata - Arbitrary JSONB metadata (defaults to an empty object)
 * @returns The inserted payment entity
 */
export async function createPayment(data: {
  userId: string;
  stripeSessionId: string;
  amountCents: number;
  creditsGranted: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}): Promise<PaymentEntity> {
  const rows = await db
    .insert(payments)
    .values({
      userId: data.userId,
      stripeSessionId: data.stripeSessionId,
      amountCents: data.amountCents,
      creditsGranted: data.creditsGranted,
      currency: data.currency ?? "usd",
      metadata: data.metadata ?? {},
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * Get a payment by ID.
 * @param id - Payment UUID
 * @returns The payment entity, or null if not found
 */
export async function getPaymentById(id: string): Promise<PaymentEntity | null> {
  const rows = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Get a payment by Stripe session ID.
 * @param sessionId - Stripe Checkout session ID
 * @returns The payment entity, or null if no payment matches the session
 */
export async function getPaymentByStripeSessionId(sessionId: string): Promise<PaymentEntity | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.stripeSessionId, sessionId))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Update payment status and optionally set Stripe payment intent ID.
 * @param id - Payment UUID
 * @param status - New status value to write
 * @param stripePaymentIntentId - Stripe PaymentIntent ID to record (only set when provided)
 */
export async function updatePaymentStatus(
  id: string,
  status: string,
  stripePaymentIntentId?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { status, updatedAt: new Date() };
  if (stripePaymentIntentId) updates.stripePaymentIntentId = stripePaymentIntentId;
  await db.update(payments).set(updates).where(eq(payments.id, id));
}

/**
 * CAS update: transition status from `fromStatus` to `toStatus`.
 * This is the idempotent guard for webhook replay.
 * @param id - Payment UUID
 * @param fromStatus - Status the row must currently be in for the update to apply
 * @param toStatus - Status to transition the row to
 * @param stripePaymentIntentId - Stripe PaymentIntent ID to record (only set when provided)
 * @returns True if this call performed the transition (row was in `fromStatus`);
 *   false if another concurrent call already transitioned it
 */
export async function updatePaymentStatusCAS(
  id: string,
  fromStatus: string,
  toStatus: string,
  stripePaymentIntentId?: string,
): Promise<boolean> {
  const updates: Record<string, unknown> = { status: toStatus, updatedAt: new Date() };
  if (stripePaymentIntentId) updates.stripePaymentIntentId = stripePaymentIntentId;
  const result = await db
    .update(payments)
    .set(updates)
    .where(and(eq(payments.id, id), eq(payments.status, fromStatus)))
    .returning({ id: payments.id });
  return result.length > 0;
}

/**
 * List payments for a user, ordered by most recent.
 * @param userId - User whose payments to list
 * @param limit - Page size (capped at 100)
 * @param offset - Pagination offset
 * @returns The user's payment entities, newest first
 */
export async function listPaymentsByUser(
  userId: string,
  limit = 20,
  offset = 0,
): Promise<PaymentEntity[]> {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(Math.min(limit, 100))
    .offset(offset);
  return rows.map(toEntity);
}
