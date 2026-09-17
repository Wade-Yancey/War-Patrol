import { useEffect, useRef, useState } from 'react';
import type { ClientView } from '@war-patrol/shared';
import { api } from '../api/client';

interface Options {
  gameId: string;
  token: string | null;
  enabled?: boolean;
}

/**
 * SSE subscription with auto-reconnect and full refresh on version gaps (ARCH-SA-05–08).
 */
export function useGameStream({ gameId, token, enabled = true }: Options) {
  const [view, setView] = useState<ClientView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastVersionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !token || !gameId) return;

    let cancelled = false;
    let reconnectTimer: number | undefined;

    const fullRefresh = async () => {
      try {
        const data = await api.view(gameId, token);
        if (cancelled) return;
        lastVersionRef.current = data.stateVersion;
        setStateVersion(data.stateVersion);
        setView(data.view);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    };

    const connect = () => {
      // EventSource cannot set Authorization headers; use fetch-stream polyfill via query is avoided —
      // instead open SSE with a cookie-less bearer through a tiny wrapper using fetch ReadableStream.
      void openSse();
    };

    const openSse = async () => {
      try {
        await fullRefresh();
        const res = await fetch(`/api/games/${gameId}/events`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE failed (${res.status})`);
        }
        if (cancelled) return;
        setConnected(true);
        setError(null);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6)) as {
                type: string;
                stateVersion: number;
                view: ClientView;
              };
              if (payload.type !== 'state') continue;
              const prev = lastVersionRef.current;
              if (prev > 0 && payload.stateVersion > prev + 1) {
                // Version gap → full refresh
                await fullRefresh();
                continue;
              }
              lastVersionRef.current = payload.stateVersion;
              setStateVersion(payload.stateVersion);
              setView(payload.view);
            } catch {
              /* ignore parse errors */
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        setError(err instanceof Error ? err.message : 'SSE disconnected');
      } finally {
        if (!cancelled) {
          setConnected(false);
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, [gameId, token, enabled]);

  return { view, stateVersion, connected, error, setView };
}
