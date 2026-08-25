'use client';

/**
 * ParkedSales — recall (SAL-03).
 *
 * A parked sale is a customer who stepped away: gone to find cash, gone to
 * ask a friend, waiting on a phone call. The cashier serves the next person
 * and brings this back when they return, so the list is ordered oldest-first
 * — the one waiting longest is at the top.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listParked, recallParked, discardParked, type ParkedRow } from '../../lib/pos/parked';
import { formatKes, type Cents } from '../../lib/money/money';
import type { Cart } from '../../lib/pos/cart';

export function ParkedSales({
  supabase, shiftId, onRecall, onClose,
}: {
  supabase: SupabaseClient;
  shiftId: string;
  onRecall: (cart: Cart) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ParkedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setRows(await listParked(supabase, shiftId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [supabase, shiftId]);

  useEffect(() => { void load(); }, [load]);

  const recall = async (row: ParkedRow) => {
    setBusy(row.parkedId);
    try {
      await recallParked(supabase, row.parkedId);
      onRecall(row.cart);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const discard = async (row: ParkedRow) => {
    setBusy(row.parkedId);
    try {
      await discardParked(supabase, row.parkedId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="parked-title">
      <div className="till-block__card" style={{ maxWidth: 560, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title" id="parked-title">Parked sales</h2>

        {error && <p className="tender__error" role="alert">{error}</p>}

        {loading ? (
          <p className="tender__hint">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="tender__hint">
            Nothing parked. Use <strong>Park sale</strong> when a customer steps
            away, then bring it back here.
          </p>
        ) : (
          <div className="recon" style={{ marginBottom: 18 }}>
            {rows.map((row) => (
              <div className="recon__row" key={row.parkedId}>
                <div>
                  <strong>{formatKes(row.totalCents as Cents)}</strong>
                  <small>
                    {row.label} · {row.itemCount} {row.itemCount === 1 ? 'item' : 'items'} ·
                    {' '}parked {minutesAgo(row.parkedAt)}
                  </small>
                </div>
                <div className="recon__actions">
                  <button className="till-cat" disabled={busy === row.parkedId}
                          onClick={() => void recall(row)}>
                    Recall
                  </button>
                  <button className="till-cat" disabled={busy === row.parkedId}
                          onClick={() => void discard(row)}>
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button className="till-btn till-btn--pay" style={{ width: '100%' }} onClick={onClose}>
          Back to sale
        </button>
      </div>
    </div>
  );
}

function minutesAgo(at: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}
