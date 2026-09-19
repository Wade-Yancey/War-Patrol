import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UmpireView } from '@war-patrol/shared';

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

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).href;
}

function formatVesselBlock(v: VesselLink): string {
  const lines = [`${v.name}`];
  for (const s of v.stations) {
    lines.push(`${s.name}: ${absoluteUrl(s.path)}`);
  }
  return lines.join('\n');
}

export function VesselJoinLinks({ vesselLinks, units, busy, onRotateToken }: Props) {
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

  const allPlayerText = useMemo(
    () =>
      playerLinks
        .map((v) => formatVesselBlock(v))
        .join('\n\n'),
    [playerLinks],
  );

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
            disabled={busy}
            onClick={() => void copy('all', allPlayerText)}
          >
            {copyLabel('all', 'Copy all')}
          </button>
        )}
      </div>
      <p className="muted vessel-join-links-help">
        One-click copy full station URLs for each vessel. Send <strong>Controls</strong> and{' '}
        <strong>Sensors</strong> links to players (Destroyer + Fleet Submarine). Optional vessel
        password is set in Unit edit.
      </p>

      <div className="stack vessel-join-list">
        {vesselLinks.map((v) => {
          const unit = units.find((u) => u.id === v.unitId);
          const vesselCopyKey = `vessel:${v.unitId}`;
          return (
            <article key={v.unitId} className="vessel-join-vessel">
              <div className="vessel-join-vessel-head">
                <div>
                  <div className="vessel-join-vessel-name">{v.name}</div>
                  <div className="vessel-join-vessel-meta mono muted">
                    {unit ? (
                      <>
                        <span
                          className={`side-badge side-badge--${unit.faction.toLowerCase()} vessel-faction-badge`}
                        >
                          {unit.faction}
                        </span>{' '}
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
                      disabled={busy}
                      onClick={() => void copy(vesselCopyKey, formatVesselBlock(v))}
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
                    const url = absoluteUrl(s.path);
                    const stationKey = `station:${v.unitId}:${s.stationId}`;
                    return (
                      <li key={s.stationId} className="vessel-join-station">
                        <div className="vessel-join-station-label">
                          <span className="vessel-join-station-name">{s.name}</span>
                          <span className="muted mono vessel-join-station-id">{s.stationId}</span>
                        </div>
                        <div className="vessel-join-url-row">
                          <code className="mono vessel-join-url" title={url}>
                            {url}
                          </code>
                          <div className="vessel-join-station-actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busy}
                              onClick={() => void copy(stationKey, url)}
                            >
                              {copyLabel(stationKey, 'Copy')}
                            </button>
                            <Link className="vessel-join-open" to={s.path}>
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
