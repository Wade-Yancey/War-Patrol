import { memo } from 'react';
import { normalizeHeading } from '@war-patrol/shared';
import { useTweenedHeading } from '../hooks/useTweenedHeading';
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

/** Padded true bearing (0–360) for optics contact / sighting readouts. */
export function formatTrueBearing(trueDeg: number): string {
  return `${String(Math.round(normalizeHeading(trueDeg))).padStart(3, '0')}°`;
}

/**
 * CRT optics bearing dial for lookout / periscope.
 *
 * Same rose + needles as HelmCompass (shared CrtCompassRose): north-up N/E/S/W,
 * solid HDG needle for bow facing (tweens with {@link useTweenedHeading}, same
 * window as helm / sensor contacts), dashed rim-chevron bug for selected contact
 * at true bearing (HDG + REL). Digital REL / TRUE sit in a dedicated contact
 * block under the rose so the selected bearing is not buried in the legend.
 */
function OpticsBearingCompassInner({ relativeBearing, ownHeading }: Props) {
  const hasContact = relativeBearing !== null && Number.isFinite(relativeBearing);
  const hdg = useTweenedHeading(ownHeading);
  const rel = hasContact ? relativeBearing : 0;
  const contactTrue = hasContact ? normalizeHeading(hdg + rel) : null;
  const intensity = hasContact ? 'full' : 'dim';

  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const relLabel = hasContact ? formatRelBearing(rel) : '——';
  const contactTrueLabel =
    contactTrue !== null ? formatTrueBearing(contactTrue) : '——';

  const aria = hasContact
    ? `Heading ${hdgLabel} degrees; contact relative bearing ${relLabel}; true bearing ${contactTrueLabel}`
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
      </div>

      <div
        className={`optics-bearing-compass-contact${hasContact ? '' : ' optics-bearing-compass-contact--empty'}`}
      >
        <span className="optics-bearing-compass-contact-label">Contact brg</span>
        <div className="optics-bearing-compass-contact-readouts">
          <div className="optics-bearing-compass-readout optics-bearing-compass-readout--contact">
            <span className="optics-bearing-compass-key">REL</span>
            <span
              className={`readout optics-bearing-compass-val optics-bearing-compass-val--contact${hasContact ? '' : ' muted'}`}
            >
              {relLabel}
            </span>
          </div>
          <div className="optics-bearing-compass-readout optics-bearing-compass-readout--contact">
            <span className="optics-bearing-compass-key">TRUE</span>
            <span
              className={`readout optics-bearing-compass-val optics-bearing-compass-val--contact${hasContact ? '' : ' muted'}`}
            >
              {contactTrueLabel}
            </span>
          </div>
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
        </span>
      </div>
    </div>
  );
}

export const OpticsBearingCompass = memo(OpticsBearingCompassInner);
