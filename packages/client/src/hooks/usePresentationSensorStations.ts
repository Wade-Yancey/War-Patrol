import { useEffect, useRef } from 'react';
import {
  presentationSensorGate,
  type UnitCondition,
  type UnitSubsystems,
  type VesselView,
} from '@war-patrol/shared';

type PresentationUnit = {
  condition: UnitCondition;
  subsystems: UnitSubsystems;
  type: VesselView['unit']['type'];
};

export type PresentationSensorStations = {
  radarOperational: boolean;
  radarUnavailableReason: VesselView['radarUnavailableReason'];
  radarContacts: NonNullable<VesselView['radarContacts']>;
  hydrophoneOperational: boolean;
  hydrophoneUnavailableReason: VesselView['hydrophoneUnavailableReason'];
  hydrophoneContacts: NonNullable<VesselView['hydrophoneContacts']>;
  sonarOperational: boolean;
  sonarUnavailableReason: VesselView['sonarUnavailableReason'];
  sonarContacts: NonNullable<VesselView['sonarContacts']>;
  /** Presentation toggle while active-sonar casualty is still held. */
  activeSonarEnabled: boolean;
  periscopeOperational: boolean;
  periscopeUnavailableReason: VesselView['periscopeUnavailableReason'];
  periscopeContacts: NonNullable<VesselView['periscopeContacts']>;
  opticsSightings: NonNullable<VesselView['opticsSightings']>;
  /** Presentation mast while lookout casualty is still held. */
  periscopeRaised: boolean;
};

/**
 * Sensors FoW chrome + last-good contact pictures, gated on audio-synced
 * presentation subsystems/condition (not resolve-time vessel.unit.subsystems).
 */
export function usePresentationSensorStations(
  vessel: VesselView | null,
  presentation: PresentationUnit | null,
): PresentationSensorStations {
  const heldRadarRef = useRef<NonNullable<VesselView['radarContacts']>>([]);
  const heldHydroRef = useRef<NonNullable<VesselView['hydrophoneContacts']>>([]);
  const heldSonarRef = useRef<NonNullable<VesselView['sonarContacts']>>([]);
  const heldPeriContactsRef = useRef<NonNullable<VesselView['periscopeContacts']>>([]);
  const heldSightingsRef = useRef<NonNullable<VesselView['opticsSightings']>>([]);
  const heldActiveSonarOnRef = useRef(false);
  const heldPeriRaisedRef = useRef(false);

  useEffect(() => {
    if (!vessel) return;
    if (vessel.radarOperational) {
      heldRadarRef.current = vessel.radarContacts ?? [];
    }
    if (vessel.hydrophoneOperational) {
      heldHydroRef.current = vessel.hydrophoneContacts ?? [];
    }
    if (vessel.sonarOperational) {
      heldSonarRef.current = vessel.sonarContacts ?? [];
    }
    if (vessel.periscopeOperational) {
      heldPeriContactsRef.current = vessel.periscopeContacts ?? [];
      heldSightingsRef.current = vessel.opticsSightings ?? vessel.torpedoWakeCues ?? [];
    }
    // Capture toggle/mast only while the matching subsystem is still resolve-intact.
    if (vessel.unit.subsystems?.activeSonar !== 'disabled') {
      heldActiveSonarOnRef.current = Boolean(vessel.unit.activeSonarEnabled);
    }
    if (vessel.unit.subsystems?.lookout !== 'disabled') {
      heldPeriRaisedRef.current = Boolean(vessel.unit.periscopeRaised);
    }
  }, [vessel]);

  if (!vessel || !presentation) {
    return {
      radarOperational: false,
      radarUnavailableReason: undefined,
      radarContacts: [],
      hydrophoneOperational: false,
      hydrophoneUnavailableReason: undefined,
      hydrophoneContacts: [],
      sonarOperational: false,
      sonarUnavailableReason: undefined,
      sonarContacts: [],
      activeSonarEnabled: false,
      periscopeOperational: false,
      periscopeUnavailableReason: undefined,
      periscopeContacts: [],
      opticsSightings: [],
      periscopeRaised: false,
    };
  }

  const radar = presentationSensorGate(
    presentation,
    'radar',
    vessel.radarOperational,
    vessel.radarUnavailableReason,
  );
  const hydro = presentationSensorGate(
    presentation,
    'hydrophone',
    vessel.hydrophoneOperational,
    vessel.hydrophoneUnavailableReason,
  );
  const sonar = presentationSensorGate(
    presentation,
    'active_sonar',
    vessel.sonarOperational,
    vessel.sonarUnavailableReason,
  );
  const peri = presentationSensorGate(
    presentation,
    'lookout',
    vessel.periscopeOperational,
    vessel.periscopeUnavailableReason,
  );

  const holdingRadar = radar.operational && vessel.radarOperational === false;
  const holdingHydro = hydro.operational && vessel.hydrophoneOperational === false;
  const holdingSonarCasualty =
    (vessel.sonarUnavailableReason === 'sensors_disabled' ||
      vessel.sonarUnavailableReason === 'sunk') &&
    sonar.unavailableReason === undefined;
  const holdingPeriCasualty =
    (vessel.periscopeUnavailableReason === 'sensors_disabled' ||
      vessel.periscopeUnavailableReason === 'sunk') &&
    peri.unavailableReason === undefined;

  const activeSonarEnabled = holdingSonarCasualty
    ? heldActiveSonarOnRef.current
    : Boolean(vessel.unit.activeSonarEnabled);

  // Sonar “operational” also means search is ON — restore that when holding.
  const sonarOperational = holdingSonarCasualty
    ? activeSonarEnabled
    : sonar.operational;

  const periscopeRaised = holdingPeriCasualty
    ? heldPeriRaisedRef.current
    : Boolean(vessel.unit.periscopeRaised);

  // Lookout casualty clears the mast server-side; while held, restore prior mast
  // chrome. Mast-down subs still show scope_down (not “sensors disabled”).
  let periOperational = peri.operational;
  let periReason = peri.unavailableReason;
  if (holdingPeriCasualty) {
    if (presentation.type === 'Submarine' && !periscopeRaised) {
      periOperational = false;
      periReason = 'scope_down';
    } else {
      periOperational = true;
      periReason = undefined;
    }
  }

  return {
    radarOperational: radar.operational,
    radarUnavailableReason: radar.unavailableReason,
    radarContacts: holdingRadar ? heldRadarRef.current : (vessel.radarContacts ?? []),
    hydrophoneOperational: hydro.operational,
    hydrophoneUnavailableReason: hydro.unavailableReason,
    hydrophoneContacts: holdingHydro
      ? heldHydroRef.current
      : (vessel.hydrophoneContacts ?? []),
    sonarOperational,
    sonarUnavailableReason: sonar.unavailableReason,
    sonarContacts:
      holdingSonarCasualty && activeSonarEnabled
        ? heldSonarRef.current
        : (vessel.sonarContacts ?? []),
    activeSonarEnabled,
    periscopeOperational: periOperational,
    periscopeUnavailableReason: periReason,
    periscopeContacts:
      holdingPeriCasualty && periOperational
        ? heldPeriContactsRef.current
        : (vessel.periscopeContacts ?? []),
    opticsSightings:
      holdingPeriCasualty && periOperational
        ? heldSightingsRef.current
        : (vessel.opticsSightings ?? vessel.torpedoWakeCues ?? []),
    periscopeRaised,
  };
}
