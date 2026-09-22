import { memo } from 'react';
import { normalizeHeading } from '@war-patrol/shared';
import {
  COMPASS_SIZE,
  CrtCompassDashedBug,
  CrtCompassHdgNeedle,
  CrtCompassHub,
  CrtCompassRoseFace,
} from './CrtCompassRose';

interface Props {
  /**
   * Selected contact relative bearing degrees (−180, 180].
   * Bow = 0, starboard positive, port negative. `null` → idle (HDG only).
   */
  relativeBearing: number | null;
  /** Own-ship true heading (0–360) — solid HDG needle on the north-up rose. */
  ownHeading: number;
}

/** Match PeriscopeScope / lookout contact readout language. */
export function formatRelBearing(rel: number): string {
  if (rel === 0) return '000° rel';
  const abs = Math.abs(rel);
  const side = rel > 0 ? 'stbd' : 'port';
  return `${String(abs).padStart(3, '0')}° ${side}`;
}

/**
 * CRT optics bearing dial for lookout / periscope.
 *
 * Same rose + needles as HelmCompass (shared CrtCompassRose): north-up N/E/S/W,
 * solid HDG needle for bow facing, dashed rim-chevron bug for selected contact
 * at true bearing (HDG + REL). Digital REL keeps contact-list port/stbd wording.
 */
function OpticsBearingCompassInner({ relativeBearing, ownHeading }: Props) {
  const hasContact = relativeBearing !== null && Number.isFinite(relativeBearing);
  const hdg = normalizeHeading(ownHeading);
  const rel = hasContact ? relativeBearing : 0;
  const contactTrue = hasContact ? normalizeHeading(hdg + rel) : null;
  const intensity = hasContact ? 'full' : 'dim';

  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const relLabel = hasContact ? formatRelBearing(rel) : '——';
  const contactTrueLabel =
    contactTrue !== null ? String(Math.round(contactTrue)).padStart(3, '0') : null;

  const aria = hasContact
    ? `Heading ${hdgLabel} degrees; contact relative bearing ${relLabel}`
    : `Heading ${hdgLabel} degrees; no contact selected`;

  return (
    <div
      className={`optics-bearing-compass${hasContact ? '' : ' optics-bearing-compass--empty'}`}
      role="img"
      aria-label={aria}
    >
      <svg
        className="optics-bearing-compass-svg"
        viewBox={`0 0 ${COMPASS_SIZE} ${COMPASS_SIZE}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <CrtCompassRoseFace intensity={intensity}>
          {hasContact && contactTrue !== null && (
            <CrtCompassDashedBug
              bearing={contactTrue}
              className="optics-bearing-compass-needle"
            />
          )}
          <CrtCompassHdgNeedle
            bearing={hdg}
            className="optics-bearing-compass-needle"
            intensity={intensity}
          />
          <CrtCompassHub intensity={intensity} />
        </CrtCompassRoseFace>
      </svg>

      <div className="optics-bearing-compass-readouts">
        <div className="optics-bearing-compass-readout">
          <span className="optics-bearing-compass-key">HDG</span>
          <span className="readout optics-bearing-compass-val">{hdgLabel}°</span>
        </div>
        <div className="optics-bearing-compass-readout">
          <span className="optics-bearing-compass-key">REL</span>
          <span className={`readout optics-bearing-compass-val${hasContact ? '' : ' muted'}`}>
            {relLabel}
          </span>
        </div>
      </div>

      <div className="optics-bearing-compass-legend" aria-hidden>
        <span>
          <i className="optics-bearing-compass-swatch optics-bearing-compass-swatch--hdg" />{' '}
          Heading
        </span>
        <span>
          <i className="optics-bearing-compass-swatch optics-bearing-compass-swatch--contact" />{' '}
          Contact
          {contactTrueLabel ? ` ${contactTrueLabel}°` : ''}
        </span>
      </div>
    </div>
  );
}

export const OpticsBearingCompass = memo(OpticsBearingCompassInner);
