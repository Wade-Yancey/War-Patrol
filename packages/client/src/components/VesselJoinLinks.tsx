import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UmpireView } from '@war-patrol/shared';
import { useHostInfo } from '../hooks/useHostInfo';

type VesselLink = UmpireView['vesselLinks'][number];
type Unit = UmpireView['units'][number];

type Props = {
  vesselLinks: VesselLink[];
  units: Unit[];
  busy?: boolean;
  onRotateToken: (unitId: string) => void;
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Absolute URL against an explicit base, else the page origin. */
function absoluteUrl(path: string, baseOrigin?: string | null): string {
  if (typeof window === 'undefined') return path;
  const base = (baseOrigin && baseOrigin.length > 0 ? baseOrigin : window.location.origin).replace(
    /\/+$/,
    '',
  );
  return new URL(path, `${base}/`).href;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function formatVesselBlock(v: VesselLink, copyBase: string | null): string | null {
  if (!copyBase) return null;
  const lines = [`${v.name}`];
  for (const s of v.stations) {
    lines.push(`${s.name}: ${absoluteUrl(s.path, copyBase)}`);
  }
  return lines.join('\n');
}

export function VesselJoinLinks({ vesselLinks, units, busy, onRotateToken }: Props) {
  const hostInfo = useHostInfo();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedKey) return;
    const t = window.setTimeout(() => setCopiedKey(null), 1600);
    return () => window.clearTimeout(t);
  }, [copiedKey]);

  const copy = useCallback(async (key: string, text: string) => {
    const ok = await writeClipboard(text);
    if (ok) setCopiedKey(key);
  }, []);

  const playerLinks = useMemo(
    () => vesselLinks.filter((v) => v.stations.length > 0),
    [vesselLinks],
  );

  /**
   * Prefer the server-advertised public/tunnel origin for Copy so remotes get
   * a working HTTPS link even when the host umpire tab is on 127.0.0.1.
   * While internet hosting is on and the umpire tab is loopback, do **not**
   * fall back to 127.0.0.1 — wait for publicBaseUrl (tunnel scrape / Host
   * learn / WAR_PATROL_PUBLIC_URL). LAN (no internetMode) still uses page origin.
   */
  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const onLoopback = Boolean(pageOrigin) && isLoopbackOrigin(pageOrigin);
  const internetMode = Boolean(hostInfo?.internetMode);
  const publicBase = hostInfo?.publicBaseUrl?.replace(/\/+$/, '') || null;
  const copyBase =
    publicBase ?? (internetMode && onLoopback ? null : pageOrigin || null);
  const waitingForPublic = internetMode && onLoopback && !publicBase;
  const copyUsesPublic =
    Boolean(publicBase) &&
    publicBase !== pageOrigin.replace(/\/+$/, '');

  const allPlayerText = useMemo(() => {
    if (!copyBase) return null;
    const blocks = playerLinks
      .map((v) => formatVesselBlock(v, copyBase))
      .filter((b): b is string => Boolean(b));
    return blocks.length > 0 ? blocks.join('\n\n') : null;
  }, [playerLinks, copyBase]);

  const copyLabel = (key: string, idle: string) =>
    copiedKey === key ? 'Copied' : idle;

  return (
    <section className="panel vessel-join-links">
      <div className="vessel-join-links-header">
        <h2>Player join URLs</h2>
        {playerLinks.length > 0 && (
          <button
            type="button"
            className="ghost"
            disabled={busy || !allPlayerText}
            onClick={() => {
              if (allPlayerText) void copy('all', allPlayerText);
            }}
          >
            {copyLabel('all', 'Copy all')}
          </button>
        )}
      </div>
      <p className="muted vessel-join-links-help">
        <strong>Copy</strong> gives players full station URLs
        {copyUsesPublic ? (
          <>
            {' '}
            on <span className="mono">{publicBase}</span>
          </>
        ) : null}
        . <strong>Open</strong> uses this browser — for the host, prefer{' '}
        <span className="mono">http://127.0.0.1:{hostInfo?.listenPort ?? 8787}</span> over
        the tunnel.
      </p>
      {waitingForPublic && (
        <p className="muted vessel-join-links-help">
          {hostInfo?.publicBaseMissing ? (
            <>
              No public/tunnel URL yet — Copy stays disabled (will not share{' '}
              <span className="mono">127.0.0.1</span>). Start with{' '}
              <span className="mono">WAR_PATROL_TUNNEL=cloudflared pnpm host</span>,
              set <span className="mono">WAR_PATROL_PUBLIC_URL</span>, or open the
              tunnel join-ready link once so the server can learn the public origin.
            </>
          ) : (
            <>
              Waiting for a public/tunnel URL… Copy stays disabled until one is
              ready (so remotes do not get <span className="mono">127.0.0.1</span>
              ).
            </>
          )}
        </p>
      )}

      <div className="stack vessel-join-list">
        {vesselLinks.map((v) => {
          const unit = units.find((u) => u.id === v.unitId);
          const vesselCopyKey = `vessel:${v.unitId}`;
          return (
            <article key={v.unitId} className="vessel-join-vessel">
              <div className="vessel-join-vessel-head">
                <div className="vessel-join-vessel-identity">
                  <div className="vessel-join-vessel-title">
                    <span className="vessel-join-vessel-name">{v.name}</span>
                    {unit ? (
                      <span
                        className={`side-badge side-badge--${unit.faction.toLowerCase()} vessel-faction-badge`}
                      >
                        {unit.faction}
                      </span>
                    ) : null}
                  </div>
                  <div className="vessel-join-vessel-meta mono muted">
                    {unit ? (
                      <>
                        {unit.type} · {unit.class}
                        {v.passwordProtected ? ' · password set' : ' · open'}
                      </>
                    ) : (
                      '—'
                    )}
                  </div>
                </div>
                <div className="vessel-join-vessel-actions">
                  {v.stations.length > 0 && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !copyBase}
                      onClick={() => {
                        const text = formatVesselBlock(v, copyBase);
                        if (text) void copy(vesselCopyKey, text);
                      }}
                    >
                      {copyLabel(vesselCopyKey, 'Copy vessel')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRotateToken(v.unitId)}
                  >
                    Rotate token
                  </button>
                </div>
              </div>

              {v.stations.length === 0 ? (
                <p className="muted vessel-join-npc">
                  NPC / umpire-only — no player stations in v1 (Destroyer + Submarine only)
                </p>
              ) : (
                <ul className="vessel-join-stations">
                  {v.stations.map((s) => {
                    const remoteUrl = copyBase ? absoluteUrl(s.path, copyBase) : null;
                    const localUrl = absoluteUrl(s.path, pageOrigin);
                    const stationKey = `station:${v.unitId}:${s.stationId}`;
                    return (
                      <li key={s.stationId} className="vessel-join-station">
                        <div className="vessel-join-station-label">
                          <span className="vessel-join-station-name">{s.name}</span>
                          <span className="muted mono vessel-join-station-id">{s.stationId}</span>
                        </div>
                        <div className="vessel-join-url-row">
                          <code
                            className="mono vessel-join-url"
                            title={remoteUrl ?? 'Waiting for public/tunnel URL'}
                          >
                            {remoteUrl ?? 'Waiting for public/tunnel URL…'}
                          </code>
                          <div className="vessel-join-station-actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busy || !remoteUrl}
                              onClick={() => {
                                if (remoteUrl) void copy(stationKey, remoteUrl);
                              }}
                            >
                              {copyLabel(stationKey, 'Copy')}
                            </button>
                            <Link className="vessel-join-open" to={s.path} title={localUrl}>
                              Open
                            </Link>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
