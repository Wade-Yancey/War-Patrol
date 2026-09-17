import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export function LandingPage() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<
    Array<{ id: string; name: string; description?: string; mode: string; unitCount: number }>
  >([]);
  const [saves, setSaves] = useState<Array<{ id: string; name: string; updatedAt: string }>>([]);
  const [scenarioId, setScenarioId] = useState('destroyer-sub-demo');
  const [gameName, setGameName] = useState('');
  const [umpirePassword, setUmpirePassword] = useState('umpire');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const createAndEnter = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGame(scenarioId, gameName || undefined);
      const auth = await api.authUmpire(created.gameId, umpirePassword);
      sessionStorage.setItem(`wp-token:${created.gameId}:umpire`, auth.token);
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
      sessionStorage.setItem(`wp-token:${loaded.gameId}:umpire`, auth.token);
      navigate(`/g/${loaded.gameId}/umpire`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell fade-in">
      <header style={{ marginBottom: '2rem' }}>
        <p className="brand">War Patrol</p>
        <p className="subhead">
          Hosted game shell — create an engagement, share vessel station links, and run
          turn-based ordering without revealing ground truth to players.
        </p>
      </header>

      {error && <p className="error">{error}</p>}

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
          <button className="primary" type="submit" disabled={busy || !scenarioId}>
            Create & open umpire view
          </button>
          {scenarios.find((s) => s.id === scenarioId)?.description && (
            <p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>
              {scenarios.find((s) => s.id === scenarioId)?.description}
            </p>
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
                      <button type="button" disabled={busy} onClick={() => void loadSave(s.id)}>
                        Load
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            Demo vessel links use passwords <span className="mono">blue</span> /{' '}
            <span className="mono">red</span>. Umpire default is <span className="mono">umpire</span>.
          </p>
          <Link to="/join">Join with vessel link →</Link>
        </section>
      </div>
    </div>
  );
}
