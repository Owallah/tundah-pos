'use client';

/**
 * useNetworkHealth — the status chip's source of truth.
 *
 * Deliberately NOT driven by `navigator.onLine`. A laptop connected to a
 * hotspot whose upstream data has died reports itself as online — which is
 * exactly the situation the cashier most needs to see. So health is measured
 * by real round-trips to Postgres, and `navigator.onLine` is used only as an
 * early negative signal.
 *
 * Thresholds come from ARCHITECTURE §C.2:
 *   healthy  < 1.5s
 *   slow     1.5s – 8s, or Realtime dropped
 *   down     two consecutive failures
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

export type NetworkState = 'online' | 'slow' | 'down';

export interface NetworkHealth {
  state: NetworkState;
  latencyMs: number | null;
  lastOkAt: Date | null;
  consecutiveFailures: number;
  /** How long we have been in the 'down' state. Drives escalation copy. */
  downForMs: number;
  check: () => Promise<void>;
}

const SLOW_MS = 1_500;
const VERY_SLOW_MS = 8_000;
const HEARTBEAT_MS = 20_000;
const FAILURES_TO_DOWN = 2;

export function useNetworkHealth(
  supabase: SupabaseClient,
  { intervalMs = HEARTBEAT_MS }: { intervalMs?: number } = {},
): NetworkHealth {
  const [state, setState] = useState<NetworkState>('online');
  const [latencyMs, setLatency] = useState<number | null>(null);
  const [lastOkAt, setLastOk] = useState<Date | null>(null);
  const [failures, setFailures] = useState(0);
  const [downSince, setDownSince] = useState<number | null>(null);
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const started = performance.now();

    try {
      // A trivially cheap authenticated round-trip. `head: true` avoids
      // transferring rows; we are timing the path, not reading data.
      const { error } = await supabase
        .from('businesses')
        .select('business_id', { head: true, count: 'exact' });

      if (error) throw error;

      const elapsed = Math.round(performance.now() - started);
      setLatency(elapsed);
      setLastOk(new Date());
      setFailures(0);
      setDownSince(null);
      setState(elapsed > VERY_SLOW_MS ? 'slow' : elapsed > SLOW_MS ? 'slow' : 'online');
    } catch {
      setFailures((n) => {
        const next = n + 1;
        if (next >= FAILURES_TO_DOWN) {
          setState('down');
          setDownSince((since) => since ?? Date.now());
        } else {
          setState('slow');
        }
        return next;
      });
    } finally {
      inFlight.current = false;
    }
  }, [supabase]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), intervalMs);

    // Browser signals are hints that trigger an immediate real check, never
    // the verdict themselves.
    const onOnline = () => void check();
    const onOffline = () => {
      setState('down');
      setDownSince((since) => since ?? Date.now());
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check, intervalMs]);

  return {
    state,
    latencyMs,
    lastOkAt,
    consecutiveFailures: failures,
    downForMs: downSince ? Date.now() - downSince : 0,
    check,
  };
}
