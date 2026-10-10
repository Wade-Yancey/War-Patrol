import { useEffect, useId, useRef, useState } from 'react';
import { STATION_GUIDES, type StationGuideId } from '../stationGuides';

export type StationInfoButtonProps = {
  guideId: StationGuideId;
  /** Optional override for the open control label (default: Info). */
  label?: string;
};

/**
 * Discrete ⓘ control + shared CRT modal for player station guide blurbs.
 * Reused across Controls / Sensors instrument heads (and optional umpire host note).
 */
export function StationInfoButton({ guideId, label = 'Info' }: StationInfoButtonProps) {
  const blurb = STATION_GUIDES[guideId];
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="station-info-btn"
        aria-label={`${label}: ${blurb.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="station-info-btn-glyph" aria-hidden>
          ⓘ
        </span>
        <span className="station-info-btn-label">{label}</span>
      </button>

      {open && (
        <div
          className="station-info-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="station-info-dialog panel stack"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="station-info-dialog-head">
              <h2 id={titleId} className="station-info-dialog-title">
                {blurb.title}
              </h2>
              <button
                ref={closeRef}
                type="button"
                className="station-info-close ghost"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            <p className="station-info-purpose muted">{blurb.purpose}</p>
            <ul className="station-info-bullets">
              {blurb.bullets.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

/** Title row: instrument h2 + discrete info control. */
export function StationInstrumentTitle({
  title,
  guideId,
}: {
  title: string;
  guideId: StationGuideId;
}) {
  return (
    <div className="station-instrument-title-row">
      <h2>{title}</h2>
      <StationInfoButton guideId={guideId} />
    </div>
  );
}
