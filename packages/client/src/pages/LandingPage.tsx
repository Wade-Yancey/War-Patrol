import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { setAuthToken } from '../api/authStorage';
import { CrtShell } from '../components/CrtShell';
import { ConfirmAction } from '../components/ConfirmAction';

type ScenarioRow = {
  id: string;
  name: string;
  description?: string;
  mode: string;
  unitCount: number;
};

type SaveRow = { id: string; name: string; updatedAt: string };

type PendingDelete =
  | { kind: 'save'; id: string; name: string }
  | { kind: 'all-saves'; count: number }
  | { kind: 'scenario'; id: string; name: string };

export function LandingPage() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioRow[]>([]);
  const [saves, setSaves] = useState<SaveRow[]>([]);
  const [scenarioId, setScenarioId] = useState('destroyer-sub-demo');
  const [gameName, setGameName] = useState('');
  const [umpirePassword, setUmpirePassword] = useState('umpire');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const refreshLists = async () => {
    const [sc, sv] = await Promise.all([api.scenarios(), api.saves()]);
    setScenarios(sc);
    setSaves(sv);
    if (sc.length && !sc.some((s) => s.id === scenarioId)) {
      setScenarioId(sc[0]!.id);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [sc, sv] = await Promise.all([api.scenarios(), api.saves()]);
        setScenarios(sc);
        setSaves(sv);
        if (sc[0]) setScenarioId(sc[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load scenarios');
      }
    })();
  }, []);

  const createAndEnter = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGame(scenarioId, gameName || undefined);
      const auth = await api.authUmpire(created.gameId, umpirePassword);
      setAuthToken(`wp-token:${created.gameId}:umpire`, auth.token);
      navigate(`/g/${created.gameId}/umpire`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const loadSave = async (saveId: string) => {
    setBusy(true);
    setError(null);
    try {
      const loaded = await api.loadSave(saveId);
      const auth = await api.authUmpire(loaded.gameId, umpirePassword);
      setAuthToken(`wp-token:${loaded.gameId}:umpire`, auth.token);
      navigate(`/g/${loaded.gameId}/umpire`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      if (pendingDelete.kind === 'save') {
        await api.deleteSave(pendingDelete.id);
      } else if (pendingDelete.kind === 'all-saves') {
        await api.deleteAllSaves();
      } else {
        await api.deleteScenario(pendingDelete.id);
      }
      setPendingDelete(null);
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteConfirmTitle =
    pendingDelete?.kind === 'save'
      ? `Delete save · ${pendingDelete.name}`
      : pendingDelete?.kind === 'all-saves'
        ? `Delete all saves · ${pendingDelete.count}`
        : pendingDelete?.kind === 'scenario'
          ? `Delete scenario · ${pendingDelete.name}`
          : '';

  const deleteConfirmLabel =
    pendingDelete?.kind === 'save'
      ? 'Delete save'
      : pendingDelete?.kind === 'all-saves'
        ? 'Delete all saves'
        : 'Delete scenario';

  return (
    <CrtShell>
      <div className="app-shell">
        <header className="header-bar">
          <div>
            <span className="brand-mark">Naval simulation · terminal</span>
            <p className="brand">War Patrol</p>
            <p className="subhead">
              Hosted game shell — create an engagement, share vessel station links, and run
              turn-based ordering without revealing ground truth to players.
            </p>
          </div>
        </header>

        {error && <p className="error">{error}</p>}

        {pendingDelete && (
          <div style={{ marginBottom: '1rem' }}>
            <ConfirmAction
              title={deleteConfirmTitle}
              warning={
                pendingDelete.kind === 'save' ? (
                  <>
                    <p>
                      This permanently removes the save file from disk and unloads it from memory if
                      active. Open sessions for that game will disconnect.
                    </p>
                    <p>
                      <strong>This cannot be undone.</strong>
                    </p>
                  </>
                ) : pendingDelete.kind === 'all-saves' ? (
                  <>
                    <p>
                      This permanently removes <strong>all {pendingDelete.count}</strong> save file
                      {pendingDelete.count === 1 ? '' : 's'} from disk and unloads any matching games
                      from memory. Open sessions for those games will disconnect.
                    </p>
                    <p>
                      <strong>This cannot be undone.</strong>
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      This permanently deletes the scenario JSON file. Existing games already created
                      from it keep running, but you will not be able to create new games from this
                      scenario.
                    </p>
                    <p>
                      <strong>This cannot be undone.</strong>
                    </p>
                  </>
                )
              }
              confirmTokens={pendingDelete.kind === 'all-saves' ? ['DELETE ALL'] : ['DELETE']}
              confirmHint={
                pendingDelete.kind === 'all-saves'
                  ? 'Type DELETE ALL to confirm'
                  : 'Type DELETE to confirm'
              }
              confirmLabel={deleteConfirmLabel}
              busy={busy}
              onCancel={() => setPendingDelete(null)}
              onConfirm={() => void runDelete()}
            />
          </div>
        )}

        <div className="grid-2">
          <form className="panel stack" onSubmit={createAndEnter}>
            <h2>Create game</h2>
            <label>
              Scenario
              <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.mode}, {s.unitCount} units)
                  </option>
                ))}
              </select>
            </label>
            <label>
              Game name (optional)
              <input value={gameName} onChange={(e) => setGameName(e.target.value)} placeholder="Local demo" />
            </label>
            <label>
              Umpire password
              <input
                type="password"
                value={umpirePassword}
                onChange={(e) => setUmpirePassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={busy || !scenarioId}
              onClick={() => void createAndEnter()}
            >
              Create & open umpire view
            </button>
            {scenarios.find((s) => s.id === scenarioId)?.description && (
              <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>
                {scenarios.find((s) => s.id === scenarioId)?.description}
              </p>
            )}
            {scenarios.length > 0 && (
              <div className="stack" style={{ gap: '0.4rem' }}>
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  Scenario files on disk
                </span>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Id</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td className="mono muted" style={{ fontSize: '0.75rem' }}>
                          {s.id}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy || pendingDelete !== null}
                            onClick={() => setPendingDelete({ kind: 'scenario', id: s.id, name: s.name })}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </form>

          <section className="panel stack">
            <h2>Load save</h2>
            <label>
              Umpire password (for login after load)
              <input
                type="password"
                value={umpirePassword}
                onChange={(e) => setUmpirePassword(e.target.value)}
              />
            </label>
            {saves.length === 0 ? (
              <p className="muted">No saves on disk yet.</p>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {saves.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td className="mono muted">{new Date(s.updatedAt).toLocaleString()}</td>
                        <td>
                          <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap' }}>
                            <button type="button" disabled={busy} onClick={() => void loadSave(s.id)}>
                              Load
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={busy || pendingDelete !== null}
                              onClick={() => setPendingDelete({ kind: 'save', id: s.id, name: s.name })}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || pendingDelete !== null}
                  onClick={() => setPendingDelete({ kind: 'all-saves', count: saves.length })}
                >
                  Delete all saves
                </button>
              </>
            )}
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
              Demo vessel links use passwords <span className="mono">blue</span> /{' '}
              <span className="mono">red</span>. Umpire default is <span className="mono">umpire</span>.
            </p>
            <Link to="/join">Join with vessel link →</Link>
          </section>
        </div>
      </div>
    </CrtShell>
  );
}
