/**
 * In-app station blurbs synced from docs/player-station-guides.md (project store).
 * Keep player-facing; trim lightly for UI. Store handout and this map can drift —
 * update both when station copy changes.
 */

export type StationGuideBlurb = {
  title: string;
  /** Short “What it’s for” line. */
  purpose: string;
  bullets: string[];
};

export type StationGuideId =
  | 'sub/helm'
  | 'sub/eot'
  | 'sub/dive'
  | 'sub/torpedoes'
  | 'sub/guns'
  | 'sub/countermeasures'
  | 'sub/damage'
  | 'sub/radar'
  | 'sub/periscope'
  | 'sub/hydrophone'
  | 'dd/helm'
  | 'dd/eot'
  | 'dd/guns'
  | 'dd/depth_charges'
  | 'dd/damage'
  | 'dd/radar'
  | 'dd/lookout'
  | 'dd/hydrophone'
  | 'dd/active_sonar'
  | 'umpire';

export const STATION_GUIDES: Record<StationGuideId, StationGuideBlurb> = {
  'sub/helm': {
    title: 'Controls · Helm',
    purpose: 'Point the boat.',
    bullets: [
      'Set ordered course with the compass / steer nudges, then Submit course.',
      'Status strip shows heading vs ordered course — they can lag while you turn.',
      'Orders only stick while the turn is open.',
      'If steering is stuck/disabled, course submit is blocked until repaired.',
    ],
  },
  'sub/eot': {
    title: 'Controls · Engine orders',
    purpose: 'Speed telegraph (how hard you drive).',
    bullets: [
      'Move the EOT, then Submit engine orders.',
      'Faster = louder underwater; quieter EOTs help the hydrophone and hide you.',
      'Re-submitting the same standing order does nothing flashy — change it first.',
      'Propulsion disabled → telegraph locked.',
    ],
  },
  'sub/dive': {
    title: 'Controls · Dive Plane',
    purpose: 'Ordered keel depth.',
    bullets: [
      'Presets (Surface, Periscope, Patrol, Test, Emergency blow) and the depth dial both place an order — they submit when you use them.',
      'Patrol / Test / Crush band marks are readouts only (labeled REF) — not buttons. Use presets or the dial to order depth.',
      'Depth changes over turns (~15 m per in-game minute toward ordered).',
      'Emergency blow surfaces you via ballast (still works if dive planes are stuck).',
      'Watch risk banners past test / at crush — going deeper is dangerous.',
    ],
  },
  'sub/torpedoes': {
    title: 'Controls · Torpedoes',
    purpose: 'Tube solutions and reloads.',
    bullets: [
      'Pick room (forward/aft), set the shot, Submit; clear cancels a pending shot.',
      'Magazines and reload timers live on this tab.',
      'Pending shot shows until resolve; you can clear while the turn is still open.',
      'Arc-block messages mean the tube can’t fire that way right now — fix heading/depth or wait.',
    ],
  },
  'sub/guns': {
    title: 'Controls · Guns',
    purpose: 'Deck gun (surfaced / shallow enough to use).',
    bullets: [
      'Aim, load state, submit salvo or clear pending.',
      'Too deep → gun won’t fire; surface or climb first.',
      'Reload on this tab when the magazine says so.',
    ],
  },
  'sub/countermeasures': {
    title: 'Controls · Countermeasures',
    purpose: 'Deploy a drifting noisemaker.',
    bullets: [
      'Choose deploy depth, submit; clear cancels pending deploy.',
      'Cooldown between deploys — watch the countdown.',
      'Decoy runs for a few turns after resolve; it is not a silent ship.',
    ],
  },
  'sub/damage': {
    title: 'Controls · Damage',
    purpose: 'Own-ship hurt and gopher tasks.',
    bullets: [
      'Hull condition, propulsion / steering / dive / sensors status.',
      'Active GOPHER TASK from the host shows here (and as a header cue) — do the physical errand; report by phone, don’t type an answer into the UI.',
      'Combat log lines are what you felt — not the enemy’s full board.',
    ],
  },
  'sub/radar': {
    title: 'Sensors · Radar',
    purpose: 'Surface PPI picture.',
    bullets: [
      'Usable only when surfaced (keel ≤ ~5 m). Deeper → “Radar unavailable — submerged”.',
      'Range scale buttons (5 / 10 / 25 / 50 nm); contacts are Contact N only — no names/sides.',
      'Contact N numbers stay stable across instruments once assigned.',
    ],
  },
  'sub/periscope': {
    title: 'Sensors · Periscope',
    purpose: 'Visual contacts + silhouette ID.',
    bullets: [
      'Usable at/above periscope depth (~20 m order); deeper → unavailable.',
      'Mast toggle raises/lowers the scope immediately. Lowered = “Scope down” (blank visual) even if depth is fine.',
      'Click a Contact N for bearing, range, course, speed, and silhouette.',
      'Mast up can be spotted by lookouts — don’t leave it hanging.',
    ],
  },
  'sub/hydrophone': {
    title: 'Sensors · Hydrophone',
    purpose: 'Passive listen (audio + bearing). No blips on the dial.',
    bullets: [
      'Submerged only (deeper than ~5 m). On the surface this tab is unavailable.',
      'Train the listen needle (drag or ◀/▶), then Start listening.',
      'ASSUME is source loudness for the range band — LOUD | QUIET | UNK. It is not own-ship or contact speed.',
      'RNG readout is a band from intensity + your ASSUME guess; INT is signal strength; QTY is how quiet you are.',
      'You hear props, enemy active pings, and reload knocks — not aircraft.',
    ],
  },
  'dd/helm': {
    title: 'Controls · Helm',
    purpose: 'Point the ship.',
    bullets: [
      'Same pattern as the sub: set course → Submit course.',
      'Watch heading lag during hard turns.',
      'Steering damage blocks course orders.',
    ],
  },
  'dd/eot': {
    title: 'Controls · Engine orders',
    purpose: 'Speed telegraph.',
    bullets: [
      'Set EOT → Submit engine orders.',
      'High speed helps chase; it also makes you louder on enemy hydrophones.',
      'Propulsion disabled → locked.',
    ],
  },
  'dd/guns': {
    title: 'Controls · Guns',
    purpose: 'Deck-gun fire.',
    bullets: [
      'Aim, submit salvo or clear; reload here when empty/awaiting.',
      'Magazine count is on this tab only — not under Engine orders.',
    ],
  },
  'dd/depth_charges': {
    title: 'Controls · Depth charges',
    purpose: 'Pattern drops.',
    bullets: [
      'Set count and depth setting, then submit (or clear pending).',
      'Rack ready / reload status is on this tab.',
      'Depth setting is where charges are meant to go off — match Sensors’ EST depth guesses.',
      'Empty rack needs reload (or umpire rearm if the UI says so).',
    ],
  },
  'dd/damage': {
    title: 'Controls · Damage',
    purpose: 'Own-ship casualties + gopher tasks.',
    bullets: [
      'Same idea as the sub Damage tab: condition, subsystems, host tasks.',
      'Complete gopher errands in the ship/venue; host marks them done after the phone report.',
    ],
  },
  'dd/radar': {
    title: 'Sensors · Radar',
    purpose: 'Surface search PPI.',
    bullets: [
      'Always available on a surface ship (unless radar is knocked out).',
      'Range scales + anonymous Contact N list — same rules as sub radar.',
      'Air and surface blips can both appear; labels stay Contact N.',
    ],
  },
  'dd/lookout': {
    title: 'Sensors · Lookout',
    purpose: 'Bridge visual (same idea as sub periscope, always “up”).',
    bullets: [
      'Contact list + silhouette / feather plates; click for precise readouts.',
      'No mast toggle on the destroyer — you’re already looking from the bridge.',
      'Good for confirming radar contacts and spotting periscope feathers.',
    ],
  },
  'dd/hydrophone': {
    title: 'Sensors · Hydrophone',
    purpose: 'Passive listen from the escort.',
    bullets: [
      'Same audio-first dial as the sub: train bearing, Start listening.',
      'ASSUME = LOUD | QUIET | UNK (loudness prior for RNG) — not speed.',
      'Self-noise rises when you steam hard; quieter EOT helps you hear.',
      'Complements active sonar: listen without pinging, or hear reload knocks / props while prosecuting.',
    ],
  },
  'dd/active_sonar': {
    title: 'Sensors · Active sonar',
    purpose: 'Ping search in a forward cone.',
    bullets: [
      'Toggle ON / OFF immediately (not a turn order). ON = pinging + contacts; OFF = quiet standby.',
      'Contacts show bearing/range and EST depth (accurate meters).',
      'Pings can be heard on enemy hydrophones — ON is loud advertising.',
      'Cone is ahead of your heading; turn the ship to sweep.',
    ],
  },
  umpire: {
    title: 'Umpire (host note)',
    purpose: 'Short checklist — not a full host manual.',
    bullets: [
      'Player join URLs: Copy = clipboard full URL for tablets (uses public/tunnel URL when available). Open = open that station in this browser on the host origin — use Open for local umpire/test tabs; give players Copy links.',
      'Turn buttons: Open = crews order · Lock = freeze · Resolve & advance = move the world.',
      'Ground-truth map is yours alone; players never see it.',
      'Gopher task panel pushes a physical errand to a vessel’s Damage tab — complete/fail after they report by phone.',
      'Only Destroyer + Fleet Submarine get station links; carriers, merchants, aircraft, etc. are NPC/umpire-only.',
    ],
  },
};

/** Resolve a guide id for a playable hull + instrument, or null if none. */
export function stationGuideIdFor(
  hullClass: string | undefined,
  instrument:
    | 'helm'
    | 'eot'
    | 'dive'
    | 'torpedoes'
    | 'guns'
    | 'depth_charges'
    | 'countermeasures'
    | 'damage'
    | 'radar'
    | 'periscope'
    | 'lookout'
    | 'hydrophone'
    | 'active_sonar',
): StationGuideId | null {
  const prefix =
    hullClass === 'Destroyer' ? 'dd' : hullClass === 'Fleet Submarine' ? 'sub' : null;
  if (!prefix) return null;
  const id = `${prefix}/${instrument}` as StationGuideId;
  return id in STATION_GUIDES ? id : null;
}
