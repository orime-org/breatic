/**
 * Payment repository — data access for the payments table.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { payments } from "../db/schema.js";
import type { PaymentEntity } from "@breatic/shared";

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
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Create a new payment record. */
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

/** Get a payment by ID. */
export async function getPaymentById(id: string): Promise<PaymentEntity | null> {
  const rows = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** Get a payment by Stripe session ID. */
export async function getPaymentByStripeSessionId(sessionId: string): Promise<PaymentEntity | null> {
  const rows = await db
    .select()
    .from(payments)
    .where(eq(payments.stripeSessionId, sessionId))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/** Update payment status and optionally set Stripe payment intent ID. */
export async function updatePaymentStatus(
  id: string,
  status: string,
  stripePaymentIntentId?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { status, updatedAt: new Date() };
  if (stripePaymentIntentId) updates.stripePaymentIntentId = stripePaymentIntentId;
  await db.update(payments).set(updates).where(eq(payments.id, id));
}

/** List payments for a user, ordered by most recent. */
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
