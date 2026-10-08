/** Compact expected move-this-turn readout (Controls / Sensors status strips). */
export function MoveDistanceReadout({
  distanceNm,
  speedKn,
  turnLengthSeconds,
}: {
  distanceNm: number;
  speedKn: number;
  turnLengthSeconds: number;
}) {
  const minutes = turnLengthSeconds / 60;
  const minLabel = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return (
    <div className="controls-status-item">
      <span
        className="controls-status-key"
        title="Expected distance this turn from ordered EOT (class speed table)"
      >
        MOVE
      </span>
      <span className="readout">
        {distanceNm.toFixed(2)} nm
        <span className="muted" style={{ marginLeft: 4, fontSize: '0.75em' }}>
          / {minLabel} min · {Math.abs(speedKn).toFixed(1)} kn
        </span>
      </span>
    </div>
  );
}
