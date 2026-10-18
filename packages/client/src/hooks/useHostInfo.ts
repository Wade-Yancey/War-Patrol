import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type HostInfo = {
  publicBaseUrl: string | null;
  listenPort: number;
  internetMode: boolean;
  /**
   * Client-only: internet mode was on, we polled `/api/host-info`, and never
   * saw a public/tunnel base. UI should treat Copy as blocked (not loopback).
   */
  publicBaseMissing?: boolean;
};

/**
 * Hosting hints from `/api/host-info`. Polls so a late cloudflared quick-tunnel
 * URL (or a Host-learned public base after the first tunnel hit) still lands
 * in the umpire Copy panel after page load.
 */
export function useHostInfo(): HostInfo | null {
  const [info, setInfo] = useState<HostInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    /** ~2.5 min at 1s — quick tunnels + Host-learn after first tunnel hit. */
    const maxAttempts = 150;

    const load = async () => {
      try {
        const next = await api.hostInfo();
        if (cancelled) return null;
        setInfo((prev) => ({
          ...next,
          // Clear missing once a public base appears.
          publicBaseMissing: next.publicBaseUrl ? false : prev?.publicBaseMissing,
        }));
        return next;
      } catch {
        return null;
      }
    };

    let timer: number | undefined;

    void (async () => {
      const first = await load();
      if (cancelled || first?.publicBaseUrl) return;
      // LAN / no internet mode: nothing to wait for.
      if (first && !first.internetMode) return;

      timer = window.setInterval(() => {
        void (async () => {
          attempts += 1;
          const next = await load();
          if (cancelled) return;
          const exhausted = attempts >= maxAttempts;
          const done =
            Boolean(next?.publicBaseUrl) ||
            exhausted ||
            (next && !next.internetMode);
          if (done && timer !== undefined) {
            window.clearInterval(timer);
            if (exhausted && next?.internetMode && !next.publicBaseUrl) {
              setInfo((prev) =>
                prev
                  ? { ...prev, publicBaseMissing: true }
                  : {
                      ...next,
                      publicBaseMissing: true,
                    },
              );
            }
          }
        })();
      }, 1_000);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);

  return info;
}
