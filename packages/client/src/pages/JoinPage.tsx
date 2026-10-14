import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CrtShell } from '../components/CrtShell';

/** Manual join helper when pasting a station path. */
export function JoinPage() {
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const go = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = path.trim();
    if (!trimmed) {
      setError('Paste a station path or URL');
      return;
    }
    try {
      const url = trimmed.startsWith('http')
        ? new URL(trimmed)
        : new URL(trimmed, window.location.origin);
      navigate(url.pathname);
    } catch {
      setError('Invalid path');
    }
  };

  return (
    <CrtShell>
      <div className="app-shell">
        <span className="brand-mark">Station access</span>
        <p className="brand">War Patrol</p>
        <p className="subhead">Paste a station URL or path from the umpire.</p>
        {error && <p className="error">{error}</p>}
        <form className="panel stack" onSubmit={go} style={{ maxWidth: 520, marginTop: '1.5rem' }}>
          <label>
            Station path
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/g/…/v/…/s/…"
              autoComplete="off"
            />
          </label>
          <button className="primary" type="submit">
            Open station
          </button>
          <Link to="/">← Back</Link>
        </form>
      </div>
    </CrtShell>
  );
}
