/**
 * pos/parked.ts — park and recall (SAL-03).
 *
 * BUG FIXED HERE: the previous inline implementation in TillContainer passed
 * `device_id: undefined` and omitted `business_id`. Both columns are NOT NULL,
 * so the insert always threw — and the error was swallowed, so the cart
 * cleared and the sale was silently lost. A cashier would believe it was
 * parked. That is worse than a button that visibly does nothing.
 *
 * Both ids are now passed explicitly and the caller is expected to surface
 * any error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cart } from './cart';

export interface ParkContext {
  businessId: string;
  deviceId: string;
  shiftId: string;
  cashierId: string;
}

export interface ParkedRow {
  parkedId: string;
  label: string;
  parkedAt: Date;
  cart: Cart;
  itemCount: number;
  totalCents: number;
}

export async function parkSale(
  supabase: SupabaseClient,
  cart: Cart,
  ctx: ParkContext,
): Promise<void> {
  if (cart.lines.length === 0) return;

  const { error } = await supabase.from('parked_sales').insert({
    business_id: ctx.businessId,     // NOT NULL — was missing
    device_id: ctx.deviceId,         // NOT NULL — was `undefined`
    shift_id: ctx.shiftId,
    cashier_id: ctx.cashierId,
    label: cart.localRef,
    cart: cart as unknown as Record<string, unknown>,
  });

  // Never swallow this. If parking failed the cashier must know BEFORE the
  // cart is cleared.
  if (error) {
    throw new Error(`Could not park the sale: ${error.message}`);
  }
}

export async function listParked(
  supabase: SupabaseClient,
  shiftId: string,
): Promise<ParkedRow[]> {
  const { data, error } = await supabase
    .from('parked_sales')
    .select('parked_id, label, parked_at, cart')
    .eq('shift_id', shiftId)
    .is('recalled_at', null)
    .order('parked_at', { ascending: true });

  if (error) throw new Error(`Could not load parked sales: ${error.message}`);

  return ((data ?? []) as Array<{
    parked_id: string; label: string; parked_at: string;
    cart: Record<string, unknown>;
  }>).map((row) => {
    const cart = reviveCart(row.cart);
    return {
      parkedId: row.parked_id,
      label: row.label ?? cart.localRef,
      parkedAt: new Date(row.parked_at),
      cart,
      itemCount: cart.lines.length,
      totalCents: cart.lines.reduce(
        (sum, l) => sum + Math.round(l.qty * l.unitPrice) - l.discount, 0),
    };
  });
}

export async function recallParked(
  supabase: SupabaseClient,
  parkedId: string,
): Promise<void> {
  const { error } = await supabase
    .from('parked_sales')
    .update({ recalled_at: new Date().toISOString() })
    .eq('parked_id', parkedId);

  if (error) throw new Error(`Could not recall: ${error.message}`);
}

export async function discardParked(
  supabase: SupabaseClient,
  parkedId: string,
): Promise<void> {
  // Marked recalled rather than deleted: a parked sale that a supervisor
  // later asks about should still be findable.
  await recallParked(supabase, parkedId);
}

/**
 * JSON round-tripping turns Date into string. The cart engine expects a real
 * Date on `openedAt`, so restore it rather than letting a subtle type lie
 * propagate into the sale payload.
 */
function reviveCart(raw: Record<string, unknown>): Cart {
  const cart = raw as unknown as Cart;
  return {
    ...cart,
    openedAt: new Date(cart.openedAt as unknown as string),
    // A recalled sale gets a fresh id so it cannot collide with the
    // idempotency key of anything already submitted.
    saleId: crypto.randomUUID(),
  };
}
