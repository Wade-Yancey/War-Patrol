import { memo, useMemo, type ReactNode } from 'react';

/** Shared CRT gyro rose geometry (HelmCompass + OpticsBearingCompass). */
export const COMPASS_SIZE = 320;
export const COMPASS_CX = COMPASS_SIZE / 2;
export const COMPASS_CY = COMPASS_SIZE / 2;
export const COMPASS_R = 118;

export function compassPolar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return {
    x: COMPASS_CX + Math.cos(rad) * r,
    y: COMPASS_CY + Math.sin(rad) * r,
  };
}

export type CompassTick = {
  deg: number;
  major: boolean;
  cardinal: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tx: number;
  ty: number;
};

/** North-up degree ticks + N/E/S/W labels — identical on helm and optics. */
function useCompassTicks(): CompassTick[] {
  return useMemo(() => {
    const marks: CompassTick[] = [];
    const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let deg = 0; deg < 360; deg += 10) {
      const major = deg % 30 === 0;
      const tick = major ? 14 : 8;
      const outer = compassPolar(deg, COMPASS_R);
      const inner = compassPolar(deg, COMPASS_R - tick);
      const label = compassPolar(deg, COMPASS_R - 28);
      marks.push({
        deg,
        major,
        cardinal: cardinals[deg] ?? null,
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
        tx: label.x,
        ty: label.y,
      });
    }
    return marks;
  }, []);
}

type Intensity = 'full' | 'dim';

function tickStroke(major: boolean, intensity: Intensity): string {
  if (intensity === 'full') {
    return major ? '#3dff6a' : 'rgba(61,255,106,0.4)';
  }
  return major ? 'rgba(61,255,106,0.45)' : 'rgba(61,255,106,0.22)';
}

interface RoseFaceProps {
  /** Dim the rose when optics has no selected contact. */
  intensity?: Intensity;
  children?: ReactNode;
}

/**
 * Outer bezel + north-up tick rose. Children render needles above the face
 * (caller stacks HDG / dashed bugs inside the same SVG).
 */
function CrtCompassRoseFaceInner({ intensity = 'full', children }: RoseFaceProps) {
  const ticks = useCompassTicks();
  const CX = COMPASS_CX;
  const CY = COMPASS_CY;
  const R = COMPASS_R;
  const full = intensity === 'full';

  return (
    <>
      <circle
        cx={CX}
        cy={CY}
        r={R + 28}
        fill="#0a120c"
        stroke="#2a3830"
        strokeWidth={8}
      />
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="#041208"
        stroke={full ? '#1a8f3c' : 'rgba(26,143,60,0.45)'}
        strokeWidth={2}
      />
      <circle
        cx={CX}
        cy={CY}
        r={R - 48}
        fill="none"
        stroke="rgba(61,255,106,0.12)"
        strokeWidth={1}
      />

      {ticks.map((t) => (
        <g key={t.deg}>
          <line
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={tickStroke(t.major, intensity)}
            strokeWidth={t.major ? 2 : 1}
          />
          {t.cardinal && (
            <text
              x={t.tx}
              y={t.ty}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={full ? '#7dff9a' : 'rgba(125,255,154,0.5)'}
              fontSize={18}
              fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
              fontWeight={700}
            >
              {t.cardinal}
            </text>
          )}
          {t.major && !t.cardinal && (
            <text
              x={t.tx}
              y={t.ty}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={full ? '#5a9a68' : 'rgba(90,154,104,0.45)'}
              fontSize={11}
              fontFamily="IBM Plex Mono, monospace"
            >
              {String(t.deg).padStart(3, '0')}
            </text>
          )}
        </g>
      ))}

      {children}
    </>
  );
}

export const CrtCompassRoseFace = memo(CrtCompassRoseFaceInner);

interface NeedleProps {
  /** True bearing degrees (0 = north). */
  bearing: number;
  className?: string;
  intensity?: Intensity;
}

/** Solid bright HDG pointer — own-ship bow facing on the north-up rose. */
function CrtCompassHdgNeedleInner({
  bearing,
  className = 'crt-compass-needle',
  intensity = 'full',
}: NeedleProps) {
  const CX = COMPASS_CX;
  const CY = COMPASS_CY;
  const R = COMPASS_R;
  const full = intensity === 'full';
  return (
    <g
      className={className}
      style={{ transform: `rotate(${bearing}deg)`, transformOrigin: `${CX}px ${CY}px` }}
    >
      <polygon
        points={`${CX},${CY - (R - 22)} ${CX - 7},${CY + 22} ${CX + 7},${CY + 22}`}
        fill={full ? '#7dff9a' : 'rgba(125,255,154,0.55)'}
        stroke={full ? '#b8ffc8' : 'rgba(184,255,200,0.45)'}
        strokeWidth={1}
      />
    </g>
  );
}

export const CrtCompassHdgNeedle = memo(CrtCompassHdgNeedleInner);

/**
 * Dashed needle + rim chevron — helm ordered course / optics contact true bearing.
 */
function CrtCompassDashedBugInner({
  bearing,
  className = 'crt-compass-needle',
}: Omit<NeedleProps, 'intensity'>) {
  const CX = COMPASS_CX;
  const CY = COMPASS_CY;
  const R = COMPASS_R;
  return (
    <g
      className={className}
      style={{ transform: `rotate(${bearing}deg)`, transformOrigin: `${CX}px ${CY}px` }}
    >
      <line
        x1={CX}
        y1={CY}
        x2={CX}
        y2={CY - (R - 36)}
        stroke="#3dff6a"
        strokeWidth={2}
        strokeDasharray="5 4"
        opacity={0.85}
      />
      <line
        x1={CX}
        y1={CY - (R - 36)}
        x2={CX}
        y2={CY - (R + 4)}
        stroke="#3dff6a"
        strokeWidth={2.5}
        opacity={0.9}
      />
      <polygon
        points={`${CX},${CY - (R + 16)} ${CX - 9},${CY - (R + 2)} ${CX + 9},${CY - (R + 2)}`}
        fill="#3dff6a"
        opacity={0.95}
      />
    </g>
  );
}

export const CrtCompassDashedBug = memo(CrtCompassDashedBugInner);

/** Hub rivet at rose center. */
export function CrtCompassHub({ intensity = 'full' }: { intensity?: Intensity }) {
  const CX = COMPASS_CX;
  const CY = COMPASS_CY;
  return (
    <>
      <circle cx={CX} cy={CY} r={6} fill="#041208" stroke="#3dff6a" strokeWidth={2} />
      <circle
        cx={CX}
        cy={CY}
        r={2.5}
        fill={intensity === 'full' ? '#3dff6a' : 'rgba(61,255,106,0.4)'}
      />
    </>
  );
}
