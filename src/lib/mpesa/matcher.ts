/**
 * mpesa/matcher.ts
 *
 * THE PROBLEM: three tills share one Till number. A customer pays KES 250 on
 * their own phone. Safaricom posts the payment to us within ~1-2s, but the
 * payload contains no indication of WHICH till the customer is standing at.
 *
 * If two customers pay KES 250 within seconds of each other at different
 * tills, the match is genuinely ambiguous and MUST NOT be guessed.
 *
 * Strategy:
 *   1. Score candidate payments against the open cart on the till.
 *   2. If exactly one candidate scores decisively, offer it for one-tap match.
 *   3. If several are plausible, show the cashier a picker with payer name
 *      and phone suffix -- the customer is standing right there and can
 *      confirm "0712...789, Jane?" in a second.
 *   4. Never auto-match an ambiguous payment. A wrong match means one
 *      customer is charged for another's order.
 */

import type { Cents } from '../money/money';

export interface CandidatePayment {
  mpesaTxnId: string;
  receiptNumber: string;
  amount: Cents;
  phoneNumber: string | null;
  payerName: string | null;
  confirmedAt: Date;
  /** Already attached to a sale -- must never be offered again. */
  matched: boolean;
}

export interface MatchContext {
  /** Amount still owed on the cart. */
  amountDue: Cents;
  /** When the cashier opened the tender screen. */
  tenderOpenedAt: Date;
  now?: Date;
  /** Optional: customer read out the last 3-4 digits of their number. */
  phoneHint?: string;
}

export interface ScoredMatch {
  candidate: CandidatePayment;
  score: number;
  reasons: string[];
}

export interface MatchResult {
  /** Safe to offer as a single one-tap confirmation. */
  confident: ScoredMatch | null;
  /** Everything plausible, best first. Shown in the picker. */
  candidates: ScoredMatch[];
  ambiguous: boolean;
}

/** Payments older than this are not offered against a fresh cart. */
export const MATCH_WINDOW_MS = 10 * 60 * 1000;

/** A confident match needs this score AND a clear lead over the runner-up. */
export const CONFIDENT_SCORE = 70;
export const CONFIDENT_LEAD = 25;

export function matchC2BPayment(
  candidates: CandidatePayment[],
  ctx: MatchContext,
): MatchResult {
  const now = ctx.now ?? new Date();
  const windowStart = new Date(
    Math.min(ctx.tenderOpenedAt.getTime(), now.getTime() - MATCH_WINDOW_MS),
  );

  const scored: ScoredMatch[] = [];

  for (const c of candidates) {
    if (c.matched) continue;
    if (c.confirmedAt < windowStart) continue;
    if (c.confirmedAt > new Date(now.getTime() + 60_000)) continue; // clock skew

    let score = 0;
    const reasons: string[] = [];

    // Amount is the strongest signal.
    if (c.amount === ctx.amountDue) {
      score += 50;
      reasons.push('exact amount');
    } else if (c.amount > ctx.amountDue) {
      // Overpayment happens (customer rounds up). Weaker but plausible.
      const over = c.amount - ctx.amountDue;
      if (over <= 10_000) {          // within KES 100
        score += 20;
        reasons.push('overpayment within KES 100');
      } else {
        continue;                    // too far off to offer
      }
    } else {
      // Underpayment: only plausible as part of a split tender.
      score += 10;
      reasons.push('partial payment');
    }

    // Recency relative to the tender screen opening.
    const sinceTender = c.confirmedAt.getTime() - ctx.tenderOpenedAt.getTime();
    if (sinceTender >= -5_000 && sinceTender <= 90_000) {
      score += 30;
      reasons.push('arrived while tendering');
    } else if (sinceTender > 90_000 && sinceTender <= 300_000) {
      score += 10;
      reasons.push('arrived recently');
    }

    // Phone hint read out by the customer -- decisive when present.
    if (ctx.phoneHint && c.phoneNumber) {
      const hint = ctx.phoneHint.replace(/\D/g, '');
      if (hint.length >= 3 && c.phoneNumber.replace(/\D/g, '').endsWith(hint)) {
        score += 40;
        reasons.push(`phone ends ${hint}`);
      }
    }

    scored.push({ candidate: c, score, reasons });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.confirmedAt.getTime() - a.candidate.confirmedAt.getTime(),
  );

  const best = scored[0] ?? null;
  const runnerUp = scored[1] ?? null;

  const confident =
    best &&
    best.score >= CONFIDENT_SCORE &&
    (!runnerUp || best.score - runnerUp.score >= CONFIDENT_LEAD)
      ? best
      : null;

  return {
    confident,
    candidates: scored,
    // Two or more plausible payments and no decisive winner: ask the cashier.
    ambiguous: !confident && scored.length > 1,
  };
}

/** Mask a phone for on-screen display. 254712345678 -> 0712***678 */
export function maskPhone(phone: string | null): string {
  if (!phone) return 'unknown';
  const d = phone.replace(/\D/g, '');
  if (d.length < 9) return phone;
  const local = d.startsWith('254') ? `0${d.slice(3)}` : d;
  return `${local.slice(0, 4)}***${local.slice(-3)}`;
}
