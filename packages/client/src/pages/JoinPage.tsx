import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

/** Manual join helper when pasting a station path. */
export function JoinPage() {
  const navigate = useNavigate();
  const [path, setPath] = useState('/g/.../v/.../s/...');
  const [error, setError] = useState<string | null>(null);

  const go = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const url = path.startsWith('http') ? new URL(path) : new URL(path, window.location.origin);
      navigate(url.pathname);
    } catch {
      setError('Invalid path');
    }
  };

  return (
    <div className="app-shell fade-in">
      <p className="brand">War Patrol</p>
      <p className="subhead">Paste a station URL or path from the umpire.</p>
      {error && <p className="error">{error}</p>}
      <form className="panel stack" onSubmit={go} style={{ maxWidth: 520, marginTop: '1.5rem' }}>
        <label>
          Station path
          <input value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <button className="primary" type="submit">
          Open station
        </button>
        <Link to="/">← Back</Link>
      </form>
    </div>
  );
}
