import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type HostInfo = {
  publicBaseUrl: string | null;
  listenPort: number;
  internetMode: boolean;
};

/**
 * Hosting hints from `/api/host-info`.
 *
 * When internet mode is on and `publicBaseUrl` is still null (cloudflared still
 * allocating, or Host-header learn not yet hit), keep polling so the umpire
 * Copy panel flips to `https://….trycloudflare.com` without a reload.
 * Once a public base lands — or we are not in internet mode — stop.
 */
export function useHostInfo(): HostInfo | null {
  const [info, setInfo] = useState<HostInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const next = await api.hostInfo();
        if (cancelled) return null;
        setInfo(next);
        return next;
      } catch {
        return null;
      }
    };

    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const shouldKeepPolling = (next: HostInfo | null) =>
      Boolean(next?.internetMode && !next.publicBaseUrl);

    void (async () => {
      const first = await load();
      if (cancelled) return;
      if (!shouldKeepPolling(first)) return;
      timer = window.setInterval(() => {
        void (async () => {
          const next = await load();
          if (cancelled) return;
          if (!shouldKeepPolling(next)) stop();
        })();
      }, 1_500);
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return info;
}
