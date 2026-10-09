import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type HostInfo = {
  publicBaseUrl: string | null;
  listenPort: number;
  internetMode: boolean;
};

/**
 * Hosting hints from `/api/host-info`. Polls briefly so a late cloudflared
 * quick-tunnel URL still lands in the umpire Copy panel after page load.
 */
export function useHostInfo(): HostInfo | null {
  const [info, setInfo] = useState<HostInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 30;

    const load = async () => {
      try {
        const next = await api.hostInfo();
        if (cancelled) return;
        setInfo(next);
        return next;
      } catch {
        return null;
      }
    };

    let timer: number | undefined;

    void (async () => {
      const first = await load();
      if (cancelled || first?.publicBaseUrl) return;
      timer = window.setInterval(() => {
        void (async () => {
          attempts += 1;
          const next = await load();
          if (cancelled) return;
          if (next?.publicBaseUrl || attempts >= maxAttempts) {
            if (timer !== undefined) window.clearInterval(timer);
          }
        })();
      }, 2_000);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, []);

  return info;
}
