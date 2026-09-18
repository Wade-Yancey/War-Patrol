import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DEFAULT_TURN_SECONDS,
  FACTIONS,
  FLIGHT_LEVELS,
  HULL_CLASSES,
  SUBSYSTEM_STATES,
  TIMER_EXTEND_SECONDS,
  TIMER_STEP_SECONDS,
  VESSEL_TYPES,
  classesForType,
  clampSpeedToMax,
  coerceVesselIdentity,
  conditionLabel,
  editMaxSpeedForClass,
  formatGameClock,
  formatWallDuration,
  parseWallDuration,
  snapWallDuration,
  type Faction,
  type FlightLevel,
  type HullClass,
  type SubsystemState,
  type UmpireView,
  type UnitCondition,
  type VesselType,
} from '@war-patrol/shared';
import { api } from '../api/client';
import { getAuthToken, setAuthToken } from '../api/authStorage';
import { useGameStream } from '../hooks/useGameStream';
import { GroundTruthMap } from '../components/GroundTruthMap';
import { PendingOrdersPanel } from '../components/PendingOrdersPanel';
import { TurnStatus } from '../components/TurnStatus';
import { CrtShell } from '../components/CrtShell';
import { TouchNumber } from '../components/TouchNumber';
import { ConfirmAction } from '../components/ConfirmAction';

function tokenKey(gameId: string) {
  return `wp-token:${gameId}:umpire`;
}

export function UmpirePage() {
  const { gameId = '' } = useParams();
  const [password, setPassword] = useState('umpire');
  const [token, setToken] = useState(() => getAuthToken(tokenKey(gameId)));
  const [authError, setAuthError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(DEFAULT_TURN_SECONDS);
  const [editUnitId, setEditUnitId] = useState<string>('');
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<VesselType>('Ship');
  const [editClass, setEditClass] = useState<HullClass>('Destroyer');
  const [editFaction, setEditFaction] = useState<Faction>('Blue');
  const [editHealth, setEditHealth] = useState(100);
  const [editDepth, setEditDepth] = useState(0);
  const [editFlightLevel, setEditFlightLevel] = useState<FlightLevel>('medium');
  const [editCondition, setEditCondition] = useState<UnitCondition>('afloat');
  const [editPropulsion, setEditPropulsion] = useState<SubsystemState>('intact');
  const [editSensors, setEditSensors] = useState<SubsystemState>('intact');
  const [editHeading, setEditHeading] = useState(0);
  const [editSpeed, setEditSpeed] = useState(0);
  const [editPassword, setEditPassword] = useState('');
  const [dirty, setDirty] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);

  const { view, stateVersion, connected, error, refresh } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
  });

  const umpire = view?.role === 'umpire' ? (view as UmpireView) : null;
  const phase = umpire?.turn.phase;
  const isOpen = phase === 'open';
  const isLocked = phase === 'locked' || phase === 'awaiting_resolution';

  const selectedUnit = useMemo(
    () => umpire?.units.find((u) => u.id === editUnitId) ?? umpire?.units[0],
    [umpire, editUnitId],
  );

  const classOptions = useMemo(() => classesForType(editType), [editType]);

  /** Speed slider cap: unit/class max, further capped when draft sub is submerged. */
  const editSpeedCap = useMemo(() => {
    if (!selectedUnit) return 36;
    return Math.round(
      editMaxSpeedForClass({
        draftClass: editClass,
        unitClass: selectedUnit.class,
        unitMaxSpeed: selectedUnit.maxSpeed,
        draftType: editType,
        draftDepth: editType === 'Submarine' ? editDepth : 0,
      }),
    );
  }, [selectedUnit, editClass, editType, editDepth]);
  /** Alias for labels (PR #22 UX). */
  const editMaxSpeed = editSpeedCap;

  const loadDraftFromUnit = (u: NonNullable<typeof selectedUnit>) => {
    const identity = coerceVesselIdentity(u.type, u.class);
    setEditName(u.name);
    setEditType(identity.type);
    setEditClass(identity.class);
    setEditFaction(u.faction ?? 'Blue');
    setEditHealth(u.health);
    setEditDepth(Math.round(u.position.depth));
    setEditFlightLevel(u.flightLevel ?? 'medium');
    setEditCondition(u.condition ?? 'afloat');
    setEditPropulsion(u.subsystems?.propulsion ?? 'intact');
    setEditSensors(u.subsystems?.sensors ?? 'intact');
    setEditHeading(Math.round(u.heading));
    setEditSpeed(Math.round(u.speed));
    setEditPassword(u.password ?? '');
    setDirty(false);
  };

  useEffect(() => {
    if (!umpire) return;
    setTimerSeconds(snapWallDuration(umpire.turn.timerSeconds, TIMER_STEP_SECONDS));
  }, [umpire]);

  // Seed / refresh draft from SSE when unit changes, or when live push arrives and form is clean.
  useEffect(() => {
    if (!selectedUnit) return;
    if (!editUnitId) setEditUnitId(selectedUnit.id);
    if (dirty && selectedUnit.id === editUnitId) return;
    loadDraftFromUnit(selectedUnit);
    // Intentional: sync on unit/version when not dirty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUnit?.id, stateVersion]);

  const markDirty = () => {
    setDirty(true);
    setApplyNote(null);
  };

  const onTypeChange = (next: VesselType) => {
    markDirty();
    setEditType(next);
    const allowed = classesForType(next);
    let nextClass = editClass;
    if (!allowed.includes(editClass)) {
      nextClass = allowed[0] ?? 'Destroyer';
      setEditClass(nextClass);
    }
    if (next === 'Aircraft' && !editFlightLevel) {
      setEditFlightLevel('medium');
    }
    const nextDepth = next === 'Ship' ? 0 : editDepth;
    if (next === 'Ship') {
      setEditDepth(0);
    }
    // Re-cap speed to the (possibly new) class / depth max.
    const cap = selectedUnit
      ? editMaxSpeedForClass({
          draftClass: nextClass,
          unitClass: selectedUnit.class,
          unitMaxSpeed: selectedUnit.maxSpeed,
          draftType: next,
          draftDepth: next === 'Submarine' ? nextDepth : 0,
        })
      : editMaxSpeedForClass({
          draftClass: nextClass,
          unitClass: nextClass,
          unitMaxSpeed: 0,
          draftType: next,
          draftDepth: next === 'Submarine' ? nextDepth : 0,
        });
    setEditSpeed((s) => Math.round(clampSpeedToMax(s, cap)));
  };

  const onClassChange = (next: HullClass) => {
    markDirty();
    const identity = coerceVesselIdentity(editType, next);
    setEditClass(identity.class);
    setEditType(identity.type);
    const cap = selectedUnit
      ? editMaxSpeedForClass({
          draftClass: identity.class,
          unitClass: selectedUnit.class,
          unitMaxSpeed: selectedUnit.maxSpeed,
          draftType: identity.type,
          draftDepth: identity.type === 'Submarine' ? editDepth : 0,
        })
      : editMaxSpeedForClass({
          draftClass: identity.class,
          unitClass: identity.class,
          unitMaxSpeed: 0,
          draftType: identity.type,
          draftDepth: identity.type === 'Submarine' ? editDepth : 0,
        });
    setEditSpeed((s) => Math.round(clampSpeedToMax(s, cap)));
  };

  const login = async (e?: FormEvent) => {
    e?.preventDefault();
    setAuthError(null);
    try {
      const auth = await api.authUmpire(gameId, password);
      setAuthToken(tokenKey(gameId), auth.token);
      setToken(auth.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Auth failed');
    }
  };

  /** Run umpire action; always refresh view so tablet UI stays in sync even if SSE hiccups. */
  const run = async (fn: () => Promise<unknown>, note?: string) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      setDirty(false);
      if (note) setApplyNote(note);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      try {
        await refresh();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <CrtShell>
        <div className="app-shell">
          <span className="brand-mark">Umpire console</span>
          <p className="brand">War Patrol</p>
          <p className="subhead">Umpire login for game {gameId}</p>
          {authError && <p className="error">{authError}</p>}
          <form className="panel stack" onSubmit={login} style={{ maxWidth: 420, marginTop: '1.5rem' }}>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </label>
            <button className="primary" type="submit">
              Enter umpire view
            </button>
            <Link to="/">← Home</Link>
          </form>
        </div>
      </CrtShell>
    );
  }

  return (
    <CrtShell>
      <div className="app-shell">
        <header className="header-bar">
          <div>
            <span className="brand-mark">Umpire · ground truth</span>
            <p className="brand" style={{ fontSize: 'clamp(1.35rem, 3.5vw, 1.85rem)' }}>
              War Patrol
            </p>
            <p className="muted" style={{ margin: '0.25rem 0 0' }}>
              {umpire?.name ?? gameId}
            </p>
          </div>
          <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <span className={`live-dot ${connected ? '' : 'off'}`} />
              <span className="mono muted">{connected ? 'LIVE' : 'RECONNECTING'}</span>
              <span className="mono muted">v{stateVersion}</span>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              Refresh
            </button>
            <Link to="/">Home</Link>
          </div>
        </header>

        {(error || actionError) && <p className="error">{error || actionError}</p>}

        {umpire && (
          <>
            <section className="panel stack">
              <h2>Turn status</h2>
              <TurnStatus turn={umpire.turn} turnLengthSeconds={umpire.turnLengthSeconds} />
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                Open = crews enter orders · Lock = freeze orders · Resolve = apply movement and open the next
                turn.
              </p>
            </section>

            <div style={{ marginTop: '1rem' }}>
              <PendingOrdersPanel units={umpire.units} />
            </div>

            <div className="umpire-controls" style={{ marginTop: '1rem' }}>
              <section className="panel stack umpire-control-group">
                <h2>1 · Timer</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Counts down while the turn is open. Expiry auto-locks orders. Adjust in 30s or
                  1‑minute steps.
                </p>
                <TouchNumber
                  label="Order timer"
                  value={timerSeconds}
                  onChange={setTimerSeconds}
                  min={0}
                  max={3600}
                  step={TIMER_STEP_SECONDS}
                  showSlider
                  format={formatWallDuration}
                  parse={parseWallDuration}
                  hint="±30s · tap to type minutes (3 or 3:30) · 0–60m"
                />
                <div className="control-actions">
                  <button
                    type="button"
                    disabled={busy || timerSeconds < 60}
                    onClick={() =>
                      setTimerSeconds((s) =>
                        snapWallDuration(Math.max(0, s - 60), TIMER_STEP_SECONDS),
                      )
                    }
                  >
                    −1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || timerSeconds >= 3600}
                    onClick={() =>
                      setTimerSeconds((s) =>
                        snapWallDuration(Math.min(3600, s + 60), TIMER_STEP_SECONDS),
                      )
                    }
                  >
                    +1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnTimer(gameId, token, timerSeconds))}
                  >
                    Start / set timer
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() =>
                      void run(() => api.turnExtend(gameId, token, TIMER_STEP_SECONDS))
                    }
                  >
                    Extend +30s
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() =>
                      void run(() => api.turnExtend(gameId, token, TIMER_EXTEND_SECONDS))
                    }
                  >
                    Extend +1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnResetTimer(gameId, token))}
                  >
                    Restart timer
                  </button>
                </div>
              </section>

              <section className="panel stack umpire-control-group">
                <h2>2 · Order lock</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Lock closes ordering. Reopen returns to open without moving ships.
                </p>
                <div className="control-actions">
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnLock(gameId, token))}
                  >
                    Lock orders
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isLocked}
                    onClick={() => void run(() => api.turnReopen(gameId, token))}
                  >
                    Reopen orders
                  </button>
                </div>
              </section>

              <section className="panel stack umpire-control-group">
                <h2>3 · Resolve turn</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Applies all vessel orders, advances the plot, then opens the next turn. Works from open or
                  locked.
                </p>
                <div className="control-actions">
                  <button
                    className="primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.turnResolve(gameId, token))}
                  >
                    Resolve &amp; advance
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.saveGame(gameId, token))}
                  >
                    Save to disk
                  </button>
                </div>
                {umpire.historyTurnNumbers.length > 0 && (
                  <div className="stack" style={{ gap: '0.4rem' }}>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      Rollback to end of turn (requires confirmation):
                    </span>
                    <div className="row">
                      {umpire.historyTurnNumbers.map((n) => (
                        <button
                          key={n}
                          type="button"
                          className="danger"
                          disabled={busy || rollbackTarget !== null}
                          onClick={() => setRollbackTarget(n)}
                        >
                          T{n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </div>

            {rollbackTarget !== null && token && (
              <div style={{ marginTop: '1rem' }}>
                <ConfirmAction
                  title={`Rollback to end of turn ${rollbackTarget}`}
                  warning={
                    <>
                      <p>
                        <strong>Destructive.</strong> Restores units to the snapshot after turn{' '}
                        {rollbackTarget} resolved, clears in-progress orders, and discards every later
                        turn.
                      </p>
                      <p>
                        Current turn {umpire.turn.number} and in-game clock{' '}
                        <span className="mono">{formatGameClock(umpire.turn.gameTimeSeconds)}</span>{' '}
                        will be replaced by the restored clock. Later movement and history are gone.
                      </p>
                    </>
                  }
                  confirmTokens={['ROLLBACK', String(rollbackTarget)]}
                  confirmHint={`Type ROLLBACK or ${rollbackTarget} to confirm`}
                  placeholder="ROLLBACK"
                  confirmLabel={`Execute rollback to T${rollbackTarget}`}
                  busy={busy}
                  onCancel={() => setRollbackTarget(null)}
                  onConfirm={(matched) =>
                    void run(async () => {
                      await api.rollback(gameId, token, rollbackTarget, matched);
                      setRollbackTarget(null);
                    })
                  }
                />
              </div>
            )}

            <section className="panel umpire-gt-map" style={{ marginTop: '1rem' }}>
              <h2>Ground truth</h2>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.8rem' }}>
                Full operating picture — zoom/pan, trails, true-north compass, optional sensor range bands
                (Ranges).
              </p>
              <GroundTruthMap
                area={umpire.operatingArea}
                units={umpire.units}
                trails={umpire.trails}
              />
            </section>

            <div className="grid-2 umpire-modules" style={{ marginTop: '1rem' }}>
              <section className="panel">
                  <h2>Vessel links &amp; passwords</h2>
                  <p className="muted" style={{ marginTop: 0, fontSize: '0.8rem' }}>
                    Destroyers and fleet submarines include a dedicated <strong>Radar</strong> station plus an
                    installed radar sensor. Sub radar (own PPI and as a contact) only when surfaced (depth ≤ 5
                    m).
                  </p>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Vessel</th>
                        <th>Stations</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {umpire.vesselLinks.map((v) => {
                        const unit = umpire.units.find((u) => u.id === v.unitId);
                        return (
                          <tr key={v.unitId}>
                            <td>
                              <div>{v.name}</div>
                              {unit && (
                                <span
                                  className={`side-badge side-badge--${unit.faction.toLowerCase()} vessel-faction-badge`}
                                >
                                  {unit.faction}
                                </span>
                              )}
                              <div className="mono muted" style={{ fontSize: '0.75rem' }}>
                                {unit ? `${unit.type} · ${unit.class}` : '—'}
                              </div>
                              <div className="mono muted" style={{ fontSize: '0.75rem' }}>
                                token {v.accessToken}
                                {v.passwordProtected ? ' · password set' : ' · open'}
                              </div>
                            </td>
                            <td>
                              <div className="stack" style={{ gap: '0.25rem' }}>
                                {v.stations.length === 0 ? (
                                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                                    NPC / umpire-only — no player stations in v1
                                    (Destroyer + Submarine only)
                                  </span>
                                ) : (
                                  v.stations.map((s) => (
                                    <div key={s.stationId}>
                                      <Link to={s.path}>{s.name}</Link>
                                      <span className="mono muted" style={{ marginLeft: 8, fontSize: '0.7rem' }}>
                                        {s.path}
                                      </span>
                                    </div>
                                  ))
                                )}
                              </div>
                            </td>
                            <td>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await api.rotateToken(gameId, token, v.unitId);
                                  })
                                }
                              >
                                Rotate token
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>

                <section
                  className={`panel stack unit-edit${selectedUnit ? ` unit-edit--${editFaction.toLowerCase()}` : ''}`}
                >
                  {selectedUnit && (
                    <div
                      className={`unit-edit-faction-stripe unit-edit-faction-stripe--${editFaction.toLowerCase()}`}
                      aria-hidden="true"
                    />
                  )}
                  <div className="unit-edit-header">
                    <div className="unit-edit-title-row">
                      <h2>Unit edit</h2>
                      {selectedUnit && (
                        <span
                          className={`side-badge side-badge--${editFaction.toLowerCase()}`}
                          title={`${editFaction} faction`}
                        >
                          {editFaction}
                        </span>
                      )}
                    </div>
                    <span className={`mono muted unit-edit-status${dirty ? ' dirty' : ''}`}>
                      {dirty ? 'DRAFT' : 'LIVE'}
                    </span>
                  </div>
                  <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                    Tablet controls — steppers and selectors. Live SSE keeps fields fresh until you edit;
                    apply writes to the server.
                  </p>

                  <label className="unit-edit-select">
                    Unit
                    <select
                      value={selectedUnit?.id ?? ''}
                      onChange={(e) => {
                        setEditUnitId(e.target.value);
                        setDirty(false);
                        setApplyNote(null);
                        const u = umpire.units.find((x) => x.id === e.target.value);
                        if (u) loadDraftFromUnit(u);
                      }}
                    >
                      {umpire.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} · {u.faction}
                        </option>
                      ))}
                    </select>
                  </label>

                  {selectedUnit && (
                    <>
                      <div className="unit-edit-group">
                        <div className="unit-edit-identity-head">
                          <h3>Identity</h3>
                          <span
                            className={`side-badge side-badge--${editFaction.toLowerCase()}`}
                            title={`${editFaction} faction`}
                          >
                            {editFaction}
                          </span>
                        </div>
                        <label>
                          Name
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => {
                              markDirty();
                              setEditName(e.target.value);
                            }}
                            autoComplete="off"
                          />
                        </label>
                        <div className="unit-edit-pair">
                          <label className="unit-edit-select">
                            Type
                            <select
                              value={editType}
                              onChange={(e) => onTypeChange(e.target.value as VesselType)}
                            >
                              {VESSEL_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="unit-edit-select">
                            Class
                            <select
                              value={editClass}
                              onChange={(e) => onClassChange(e.target.value as HullClass)}
                            >
                              {(classOptions.length ? classOptions : [...HULL_CLASSES]).map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="unit-edit-select">
                          Faction
                          <select
                            value={editFaction}
                            onChange={(e) => {
                              markDirty();
                              setEditFaction(e.target.value as Faction);
                            }}
                          >
                            {FACTIONS.map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div
                          className="unit-edit-faction-preview"
                          role="group"
                          aria-label="Faction accent"
                        >
                          {FACTIONS.map((f) => (
                            <button
                              key={f}
                              type="button"
                              className={`unit-edit-faction-chip${
                                editFaction === f ? ' is-active' : ''
                              } unit-edit-faction-chip--${f.toLowerCase()}`}
                              disabled={busy}
                              onClick={() => {
                                markDirty();
                                setEditFaction(f);
                              }}
                            >
                              <span className="unit-edit-faction-chip-swatch" aria-hidden />
                              {f}
                            </button>
                          ))}
                        </div>
                        <p className="mono muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                          Library {selectedUnit.classId}
                        </p>
                        <div className="control-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.updateUnit(gameId, token, selectedUnit.id, {
                                    name: editName.trim() || selectedUnit.name,
                                    type: editType,
                                    class: editClass,
                                    faction: editFaction,
                                    ...(editType === 'Aircraft'
                                      ? { flightLevel: editFlightLevel }
                                      : {}),
                                  }),
                                'Identity applied',
                              )
                            }
                          >
                            Apply identity
                          </button>
                        </div>
                      </div>

                      <div className="unit-edit-group">
                        <h3>Navigation</h3>
                        <TouchNumber
                          label="Heading"
                          value={editHeading}
                          onChange={(v) => {
                            markDirty();
                            setEditHeading(v);
                          }}
                          min={0}
                          max={359}
                          step={1}
                          wrap
                          unit="°"
                          format={(v) => `${String(v).padStart(3, '0')}°`}
                        />
                        <TouchNumber
                          label={`Speed (max ${editMaxSpeed} kn)`}
                          value={editSpeed}
                          onChange={(v) => {
                            markDirty();
                            setEditSpeed(Math.round(clampSpeedToMax(v, editSpeedCap)));
                          }}
                          min={-editSpeedCap}
                          max={editSpeedCap}
                          step={1}
                          unit="kn"
                          showSlider
                          disabled={editCondition === 'sunk' || editPropulsion === 'disabled'}
                          hint={`Class cap ±${editMaxSpeed} kn · tap readout to type`}
                        />
                        <p className="mono muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                          Cap ±{editSpeedCap} kn ({editClass}
                          {selectedUnit.class !== editClass ? ' draft' : ''}
                          {editType === 'Submarine' && editDepth > 5 ? ' · submerged' : ''})
                        </p>
                        <div className="control-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.updateUnit(gameId, token, selectedUnit.id, {
                                    heading: editHeading,
                                    speed: clampSpeedToMax(editSpeed, editMaxSpeed),
                                  }),
                                'Navigation applied',
                              )
                            }
                          >
                            Apply navigation
                          </button>
                        </div>
                      </div>

                      {editType === 'Submarine' && (
                        <div className="unit-edit-group">
                          <h3>Depth</h3>
                          <TouchNumber
                            label="Depth (radar surface ≤5 m)"
                            value={editDepth}
                            onChange={(v) => {
                              markDirty();
                              setEditDepth(v);
                              if (selectedUnit) {
                                const cap = editMaxSpeedForClass({
                                  draftClass: editClass,
                                  unitClass: selectedUnit.class,
                                  unitMaxSpeed: selectedUnit.maxSpeed,
                                  draftType: editType,
                                  draftDepth: v,
                                });
                                setEditSpeed((s) => Math.round(clampSpeedToMax(s, cap)));
                              }
                            }}
                            min={0}
                            max={300}
                            step={5}
                            unit="m"
                            showSlider
                          />
                          <div className="control-actions">
                            <button
                              type="button"
                              disabled={busy || editDepth === 0}
                              onClick={() => {
                                markDirty();
                                setEditDepth(0);
                              }}
                            >
                              Surface
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                markDirty();
                                setEditDepth(40);
                              }}
                            >
                              Dive 40 m
                            </button>
                            <button
                              className="primary"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () =>
                                    api.updateUnit(gameId, token, selectedUnit.id, {
                                      position: { depth: editDepth },
                                    }),
                                  'Depth applied',
                                )
                              }
                            >
                              Apply depth
                            </button>
                          </div>
                        </div>
                      )}

                      {editType === 'Aircraft' && (
                        <div className="unit-edit-group">
                          <h3>Flight level</h3>
                          <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                            Aircraft use discrete elevation bands only — no free altitude.
                          </p>
                          <div className="unit-edit-chip-row" role="group" aria-label="Flight level">
                            {FLIGHT_LEVELS.map((level) => (
                              <button
                                key={level}
                                type="button"
                                className={editFlightLevel === level ? 'primary' : undefined}
                                disabled={busy}
                                onClick={() => {
                                  markDirty();
                                  setEditFlightLevel(level);
                                }}
                              >
                                {level}
                              </button>
                            ))}
                          </div>
                          <div className="control-actions">
                            <button
                              className="primary"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () =>
                                    api.updateUnit(gameId, token, selectedUnit.id, {
                                      flightLevel: editFlightLevel,
                                      type: 'Aircraft',
                                      class: editClass,
                                    }),
                                  'Flight level applied',
                                )
                              }
                            >
                              Apply flight level
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="unit-edit-group">
                        <h3>Condition &amp; systems</h3>
                        <div className="unit-edit-pair">
                          <label className="unit-edit-select">
                            Hull / airframe
                            <select
                              value={editCondition}
                              onChange={(e) => {
                                markDirty();
                                setEditCondition(e.target.value as UnitCondition);
                              }}
                            >
                              <option value="afloat">
                                {conditionLabel(editType, 'afloat')}
                              </option>
                              <option value="sunk">{conditionLabel(editType, 'sunk')}</option>
                            </select>
                          </label>
                          <label className="unit-edit-select">
                            Propulsion
                            <select
                              value={editPropulsion}
                              onChange={(e) => {
                                markDirty();
                                setEditPropulsion(e.target.value as SubsystemState);
                              }}
                            >
                              {SUBSYSTEM_STATES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="unit-edit-select">
                          Sensors
                          <select
                            value={editSensors}
                            onChange={(e) => {
                              markDirty();
                              setEditSensors(e.target.value as SubsystemState);
                            }}
                          >
                            {SUBSYSTEM_STATES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                          Sunk/destroyed stops movement and radar. Disabled propulsion forces stop; disabled
                          sensors blank the PPI and remove useful emissions.
                        </p>
                        <div className="control-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.updateUnit(gameId, token, selectedUnit.id, {
                                    condition: editCondition,
                                    subsystems: {
                                      propulsion: editPropulsion,
                                      sensors: editSensors,
                                    },
                                  }),
                                'Condition applied',
                              )
                            }
                          >
                            Apply condition
                          </button>
                        </div>
                      </div>

                      <div className="unit-edit-group">
                        <h3>Health</h3>
                        <TouchNumber
                          label="Hull integrity"
                          value={editHealth}
                          onChange={(v) => {
                            markDirty();
                            setEditHealth(v);
                          }}
                          min={0}
                          max={100}
                          step={5}
                          unit="%"
                          showSlider
                        />
                        <div className="control-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.updateUnit(gameId, token, selectedUnit.id, {
                                    health: editHealth,
                                  }),
                                'Health applied',
                              )
                            }
                          >
                            Apply health
                          </button>
                        </div>
                      </div>

                      <div className="unit-edit-group">
                        <h3>Access</h3>
                        <label>
                          Vessel password
                          <input
                            type="text"
                            value={editPassword}
                            onChange={(e) => {
                              markDirty();
                              setEditPassword(e.target.value);
                            }}
                            autoComplete="off"
                            placeholder="(empty = open)"
                          />
                        </label>
                        <div className="control-actions">
                          <button
                            className="primary"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  api.updateUnit(gameId, token, selectedUnit.id, {
                                    password: editPassword,
                                  }),
                                'Password set',
                              )
                            }
                          >
                            Apply password
                          </button>
                          <button
                            type="button"
                            disabled={busy || !dirty}
                            onClick={() => {
                              loadDraftFromUnit(selectedUnit);
                              setApplyNote('Draft discarded');
                            }}
                          >
                            Discard draft
                          </button>
                        </div>
                      </div>

                      {applyNote && (
                        <p className="mono unit-edit-note" role="status">
                          {applyNote}
                        </p>
                      )}
                    </>
                  )}
                </section>
            </div>

            <section className="panel" style={{ marginTop: '1rem' }}>
              <h2>Connections</h2>
              {umpire.connections.length === 0 ? (
                <p className="muted">No live SSE clients.</p>
              ) : (
                <ul className="mono" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {umpire.connections.map((c, i) => (
                    <li key={i}>
                      {c.role}
                      {c.unitId ? ` · ${c.unitId}` : ''}
                      {c.stationId ? ` / ${c.stationId}` : ''} ×{c.count}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </CrtShell>
  );
}
