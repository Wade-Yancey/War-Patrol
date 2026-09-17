War Patrol
Section 1: Architecture Requirements. Draft revision F.

1. Platform and Deployment
ARCH-PD-01. The simulator shall be delivered as a browser-based web application requiring no client-side installation.
ARCH-PD-02. The application shall be self-hostable, supporting deployment on an isolated local area network as well as over the public internet.
ARCH-PD-03. The client shall be lightweight enough to run acceptably on tablets and low-specification computers.
ARCH-PD-04. When deployed over the public internet, the application shall be served over HTTPS, as vessel passwords are transmitted from the client.
2. System Architecture
ARCH-SA-01. The system architecture shall be modular, with a strong separation of concerns between components.
ARCH-SA-02. The simulation shall be optimized for turn-based "we-go" resolution. Robust real-time performance is explicitly out of scope.
ARCH-SA-03. Authoritative simulation state shall be held on the server. Clients shall be treated as presentation and order-entry surfaces only, and shall not compute simulation outcomes locally.
ARCH-SA-04. The detection model of Section 9 shall be resolved on the server. A client shall receive only the contact picture its own vessel has earned, never ground truth. Fog of war shall not be implemented as client-side concealment of data already delivered.
2.1 State Push
ARCH-SA-05. The server shall push state updates to connected clients using Server-Sent Events (SSE) over a single long-lived HTTP connection per open station interface.
ARCH-SA-06. Client-to-server traffic, including order submission, shall use ordinary HTTP requests rather than the push channel.
ARCH-SA-07. Each pushed update shall carry a monotonically increasing state version. A client receiving a version more than one ahead of its own shall request a full state refresh rather than attempting to reconcile.
ARCH-SA-08. Clients shall reconnect automatically after connection loss and shall resynchronize to current state on reconnect. A station reopened on a new device or tab shall render current state without requiring a turn to elapse.
Rationale: traffic is low-frequency, one-way, and server-originated, which SSE covers without the connection handling that a bidirectional protocol would add. It survives ordinary proxies, reconnects on its own, and needs no dependency beyond the standard browser API.
3. Spatial Model and Player Plotting
The goal is a coordinate system that is geographically real without requiring geodesy, and a data flow that gives a player only enough to plot by hand, not a finished picture.
ARCH-SP-01. Every simulation object's position shall be stored as true geographic coordinates: latitude and longitude, plus a vertical value representing altitude for aircraft or depth for surface and subsurface units.
ARCH-SP-02. Distance and bearing between two positions shall be computed using an equirectangular (flat-earth) approximation local to the scenario's operating area, rather than full geodesic calculation. This shall be accurate at the tactical scales the simulator targets and shall avoid the added complexity of true great-circle math.
ARCH-SP-03. A scenario shall define its operating area as a bounding region of latitude and longitude, used to anchor the local approximation of ARCH-SP-02 and to place any chart imagery or land masses.
ARCH-SP-04. Vertical position shall use a single consistent datum per scenario (for example, meters above or below sea level), so that aircraft altitude and submarine depth are directly comparable for detection and weapon logic.
ARCH-SP-05. The system shall not render a shared, auto-plotted map showing a player's own inferred understanding of contacts. A station shall present only the raw sensor readouts available to it, such as a bearing, a signal strength, or a classification confidence, and shall leave the work of plotting those readouts into a position to the player, on paper or otherwise, outside the system.
ARCH-SP-06. A player's own vessel position, heading, speed, and depth shall be displayed numerically to that vessel's stations, consistent with having onboard navigation instruments. This is distinct from ARCH-SP-05, which withholds a plotted view of others.
ARCH-SP-07. The umpire's ground-truth display (ARCH-UC-05) is exempt from ARCH-SP-05 and shall show true plotted positions of all units.
4. State Management and Persistence
ARCH-SM-01. The system shall maintain a persistent state management system that tracks all simulation objects.
ARCH-SM-02. Simulation state shall be manageable and resettable by the umpire.
ARCH-SM-03. The system shall distinguish two document types:
Scenario: the starting conditions of a game, including vessels, station layouts, non-player units, starting positions, the operating area, environment settings, and access settings.
Save: a scenario plus the current turn number, the live state of every simulation object, and the turn history of Section 4.1.
ARCH-SM-04. Both document types shall be serialized as single JSON files. No database shall be required to run the simulator.
ARCH-SM-05. The umpire shall be able to save the current game to a file and load a previously saved file, resuming play from the stored turn.
ARCH-SM-06. The umpire shall be able to export a scenario file and import one created elsewhere, allowing scenarios to be authored once and reused.
ARCH-SM-07. The server shall write the current state to disk after each processed turn, so that a host restart does not lose the game in progress.
ARCH-SM-08. Every scenario and save file shall carry a schema version number so that files from earlier builds can be identified and rejected or migrated.
4.1 Turn History and Rollback
ARCH-SM-09. The system shall retain, for every resolved turn, a complete snapshot of simulation state, the orders of record submitted by each unit, and the resolution events generated by that turn.
ARCH-SM-10. History shall record the contact picture held by each vessel at each turn, not only ground truth, so that a debrief can show what a crew believed at the time it acted.
ARCH-SM-11. Umpire edits to unit state (ARCH-UC-02) shall be recorded in history as distinct entries, attributed to the umpire and separated from the results of order resolution.
ARCH-SM-12. The umpire shall be able to review any prior turn, stepping forward and backward through the game, without altering current state.
ARCH-SM-13. The umpire shall be able to roll the simulation back to any retained turn. Rollback shall restore that turn's state and discard all later turns, and shall require explicit confirmation.
ARCH-SM-14. On rollback, any order in progress at any station shall simply be cleared, and every station shall return to an open ordering state for the restored turn, as if that turn's timer had just started. No attempt shall be made to preserve or replay orders written after the rolled-back point.
ARCH-SM-15. On rollback, each vessel's contact picture shall revert to what history recorded for it at the restored turn, even though players may have already seen a later, more developed picture in the session. This is an accepted limitation given how infrequently rollback is expected to be used.
ARCH-SM-16. The system shall produce an after-action report covering a completed game, including the track of each unit over time, detection and classification events, weapon employment and outcomes, and unit losses.
ARCH-SM-17. The after-action report shall be viewable in the browser and exportable to a file.
ARCH-SM-18. History shall be retained in full for the length of a game. If snapshot size becomes a practical constraint, storing turn deltas rather than full snapshots is an acceptable implementation, provided any retained turn can still be reconstructed exactly.
5. Roles and Game Modes
ARCH-RP-01. The system shall define two distinct roles: umpires (game administrators) and players.
ARCH-RP-02. Players shall be able to operate virtual surface ships and submarines in opposition to one another.
ARCH-RP-03. Umpires shall hold administrative control over the simulation, including turn processing and the controls defined in Section 12.
ARCH-RP-04. The simulator shall support two modes of play, selected as a scenario setting:
Player versus player: opposing sides are crewed by players, and the umpire acts as a neutral facilitator and adjudicator.
Player versus umpire: the umpire plays one side as a game master, using non-player units under direct control, while players crew the other.
ARCH-RP-05. Both modes shall run on the same simulation engine and the same turn model. The mode shall determine whether the umpire is a belligerent, not how the simulation resolves.
ARCH-RP-06. The umpire shall retain ground-truth visibility in both modes.
ARCH-RP-07. In player-versus-umpire mode, the umpire interface shall be able to display the contact picture of an umpire-controlled side alongside ground truth, and to distinguish clearly between them, so that the umpire can choose to play a unit on what it can actually perceive.
ARCH-RP-08. A scenario shall support more than two sides, and shall allow a side to be marked neutral.
6. Access and Authentication
The model is deliberately minimal. There are no user accounts, no registration, and no per-player identity. Access is scoped to a vessel, not to a person.
ARCH-AC-01. The umpire shall create the vessels for a game, and the system shall generate a unique access link for each vessel.
ARCH-AC-02. The umpire shall distribute vessel links to players out of band. The system is not required to send invitations.
ARCH-AC-03. Each vessel shall have an access mode set by the umpire, either protected or open:
Protected: opening any station of that vessel requires a password unique to that vessel.
Open: the link alone grants access, with no password prompt. This mode is intended for local play and for games among trusted players.
ARCH-AC-04. A vessel password shall grant access to every station of that vessel and to no other vessel.
ARCH-AC-05. Once a password has been accepted, the browser shall hold the vessel credential for the duration of the session, so that additional stations for the same vessel opened in other tabs on that device do not prompt again.
ARCH-AC-06. The umpire shall be able to view, change, and regenerate vessel passwords, and to change a vessel's access mode, at any point during a game.
ARCH-AC-07. The umpire interface shall be protected by a separate umpire password, set at game creation and distinct from any vessel password.
ARCH-AC-08. Access control shall be enforced on the server for every request. A client shall not be able to reach another vessel's state by altering a URL.
6.1 Concurrent Connections
ARCH-AC-09. Multiple simultaneous connections to the same station shall be permitted. The system shall not lock a station to a single connection.
ARCH-AC-10. Where concurrent connections submit conflicting orders for the same unit, the most recent submission received before the lock shall be the order of record. Last write wins.
ARCH-AC-11. All connections to a station shall be pushed the resulting order state, so that a connection whose orders were superseded reflects the current submission rather than its own stale entry.
ARCH-AC-12. A station shall indicate when more than one connection is open to it, so that a crew can recognize when they are working over one another.
7. Vessel Library and Configurator
Vessel definitions are treated as reusable data, separate from any one scenario, so that a class built once can be dropped into any future game.
ARCH-LIB-01. The system shall maintain a vessel library, independent of any scenario, holding reusable vessel and aircraft class definitions.
ARCH-LIB-02. A scenario shall reference vessel and aircraft instances by class from the library rather than embedding class definitions inline. A scenario may override an instance's individual starting state, such as position, health, or loadout, without altering the shared class.
ARCH-LIB-03. The umpire shall be able to create, edit, duplicate, and delete a class in the library through a configurator interface, without editing raw data files by hand.
ARCH-LIB-04. A class definition shall include, at minimum: a name and side-neutral type (surface vessel, submarine, or aircraft); a side-profile silhouette image; movement characteristics such as maximum speed and turning performance; a noise signature curve across speed settings; sensor loadout with the ranges and characteristics needed by Section 9; weapon loadout; vessel health and a list of damageable subsystems; and the sound assets of Section 8.3.
ARCH-LIB-05. The configurator shall accept an uploaded PNG for the side-profile silhouette required by ARCH-DET-24, together with the vessel's real-world length, which the system uses to scale the silhouette by range.
ARCH-LIB-06. The configurator shall accept uploaded audio files for each sound category defined in Section 8.3, scoped to the class being edited.
ARCH-LIB-07. Deleting a class already in use by an existing save shall be prevented, or shall prompt the umpire to confirm and reassign affected instances, so that a save cannot be left referencing a missing class.
ARCH-LIB-08. The umpire shall be able to export a class or the entire library to a file and import one created elsewhere, so that a set of custom vessels can be reused across installations.
8. Stations and Presentation
ARCH-UI-01. The simulator shall not render a 3D environment. Information shall instead be conveyed to players through an information-system presentation model.
ARCH-UI-02. Each operating station that controls a vessel shall be presented as a discrete interface addressed by its own unique URL.
ARCH-UI-03. Station interfaces shall be independently openable across separate devices and separate browser tabs, allowing a crew to distribute stations as needed.
ARCH-UI-04. Each station shall display the current turn number, and whether ordering for that turn is open, locked, or awaiting resolution.
8.1 Station Configuration
ARCH-UI-05. The umpire shall be able to add and remove stations on a per-vessel basis, both when authoring a scenario and during a running game.
ARCH-UI-06. A vessel class shall carry a default station layout, which the umpire may adopt as-is or modify for an individual vessel. Editing one vessel's layout shall not affect other vessels of the same class.
ARCH-UI-07. Vessel capabilities (helm, sensors, weapons, damage control, command, and similar) shall be assignable to stations. A single station may hold several capabilities, allowing a vessel to be crewed by one player at a combined station or by several at specialized ones.
ARCH-UI-08. The system shall warn the umpire when a configuration leaves a capability unassigned to any station, since that capability would otherwise be unreachable by the crew.
ARCH-UI-09. Adding a station shall generate a new station URL. Removing a station shall invalidate its URL, and any client still holding it shall be shown a clear notice rather than a broken interface.
ARCH-UI-10. Station configuration changes shall take effect without requiring a turn to elapse or the game to be restarted.
8.2 Engine Order Telegraph
ARCH-EOT-01. A vessel with separate helm and engineering stations shall present an engine order telegraph element: the helm sets a desired speed setting from a discrete set (for example stop, slow, standard, full, flank), and that order is transmitted to the engineering station rather than applied to the vessel directly.
ARCH-EOT-02. The vessel's actual speed shall track only the setting most recently acknowledged at the engineering station, not the helm's requested setting. A vessel shall move at its prior speed until engineering acknowledges the change.
ARCH-EOT-03. Where a vessel's configuration combines helm and engineering into a single station, the telegraph shall still be shown, with the acknowledgment step performed by that same station, so the vessel's response delay stated in ARCH-EOT-04 still applies.
ARCH-EOT-04. Actual vessel speed shall transition toward an acknowledged setting gradually across turns according to the vessel's acceleration characteristics, rather than changing instantly.
8.3 Audio
ARCH-AUD-01. The simulation shall include a rudimentary audio system providing ambiance and general effect.
ARCH-AUD-02. The vessel library (Section 7) shall define, at minimum, the following sound categories per class where applicable: ambient ocean noise, own propeller and engine noise, a hydrophone contact noise per detected unit, explosion noise, depth charge noise, submarine hull creaking under dive, and deep-dive stress sounds.
ARCH-AUD-03. Looping sounds, such as ambient ocean noise and ambient engine noise, shall scale in intensity with relevant state, such as own speed or depth, rather than playing at a fixed level throughout a game.
ARCH-AUD-04. Event sounds, such as explosions and depth charges, shall play once at the triggering event and shall not require the umpire to fire them manually.
ARCH-AUD-05. Audio playback shall be controllable per station, including an overall mute, so that a shared or noisy play environment does not force sound on every device.
8.4 Playable Classes and Standard Stations
Destroyer and submarine are the two playable vessel types. The list below defines the standard set of station capabilities the library and configurator must support for them. Per ARCH-UI-07, any of these capabilities may be combined onto a single station screen to suit available hardware and crew size; the list defines what must exist, not how many screens it must occupy.
ARCH-STA-01. The vessel library shall support, at minimum, the destroyer and submarine vessel types as playable classes, and the merchant, aircraft, and generic vessel types as non-player-only classes per Section 10.
ARCH-STA-02. The system shall define the following standard station capabilities, available for assignment to any playable vessel class under ARCH-UI-07:
Helm: sets course and the desired speed setting sent to the engine order telegraph (Section 8.2).
Engine Order Telegraph: the acknowledgment side of Section 8.2, held by engineering unless combined with helm.
Engineering: acknowledges telegraph orders and manages vessel subsystem status and damage control.
Weapons Control: the firing computer of Section 9.4, covering torpedoes, depth charges, and deck guns as defined in ARCH-FC-07 and ARCH-FC-08.
Hydrophone: the passive listening interface of Section 9.3.
Sonar: the active sonar interface of ARCH-DET-37, distinct from the passive hydrophone.
Radar: the top-down scope of Section 9.2.1.
Lookout: visual silhouette identification of nearby above-water contacts per ARCH-DET-24, for a surfaced or surface vessel.
Periscope: the same silhouette identification as Lookout, available to a submarine at periscope depth, subject to the exposure rule of ARCH-DET-10.
Communications: the message interface of Section 12.1.
ARCH-STA-03. The destroyer class's default station layout shall include Helm, Engine Order Telegraph, Engineering, Weapons Control, Hydrophone, Sonar, Radar, Lookout, and Communications. It shall not include Periscope.
ARCH-STA-04. The submarine class's default station layout shall include Helm, Engine Order Telegraph, Engineering, Weapons Control, Hydrophone, Sonar, Periscope, and Communications. It shall not include Radar or Lookout, reflecting a submarine's reliance on passive sensors and periscope observation, though the umpire remains free to add either capability to an individual boat under ARCH-UI-05.
ARCH-STA-05. These defaults establish a starting point only. The umpire may add, remove, or recombine capabilities on any vessel, consistent with Section 8.1.
9. Detection, Fog of War, and Anti-Submarine Warfare
This section defines the core gameplay loop. The intended experience is a submarine attempting to close and attack while remaining undetected, against a destroyer attempting to find, fix, and prosecute it. The model is deliberately rudimentary, prioritizing the tension of an uncertain contact picture over fidelity of calculation.
9.1 Contact Picture
ARCH-DET-01. Each unit shall hold its own contact picture, derived from what its sensors have detected. No unit shall have access to the position or state of a unit it has not detected.
ARCH-DET-02. Contacts shall be distinct from units. A single unit may generate multiple unresolved contacts, and a contact may prove to be spurious.
ARCH-DET-03. Contacts shall carry a classification state, progressing with accumulated sensor information along the lines of unknown, then probable classification, then confirmed identification.
ARCH-DET-04. Contacts shall carry positional uncertainty. Where a sensor yields bearing without range, the contact shall be held as a bearing line rather than a point.
ARCH-DET-05. Contact uncertainty shall grow each turn that a contact goes unrefreshed, and a contact shall eventually lapse to stale and then be dropped. A lost contact shall leave a last known position with an expanding area of uncertainty.
ARCH-DET-06. Sides shall be able to share contact picture between friendly units, so that a destroyer and a friendly aircraft can build a common picture.
9.2 Line of Sight and Surface Detection
ARCH-DET-07. The system shall implement a rudimentary line-of-sight model for above-water detection, with visual and radar detection limited by a horizon derived from sensor height and target size, computed against the coordinate and elevation model of Section 3.
ARCH-DET-08. Terrain and land masses, where present in a scenario, shall block line of sight.
ARCH-DET-09. Environmental conditions set per scenario, at minimum sea state and visibility, shall modify detection ranges.
ARCH-DET-10. A submerged submarine shall not be detectable by visual or radar sensors. Raising a periscope, mast, or snorkel shall expose the submarine to those sensors at short range for the duration of the exposure.
ARCH-DET-11. Active emissions shall be detectable by others. A unit transmitting on radar or active sonar shall be subject to detection at a range greater than that at which its own emission returns a contact.
ARCH-DET-24. Where a unit is visually detected, at a lookout or periscope station its silhouette shall be rendered using the class's single side-profile image from the vessel library, scaled inversely with range and using the class's real-world length as the reference for that scaling, so that a distant contact appears correspondingly small.
ARCH-DET-25. The side-profile image shall be shown as-is regardless of the contact's relative bearing or aspect. The system shall not rotate, mirror, or otherwise vary the silhouette to reflect bow-on versus broadside viewing angles. Identification from the profile alone, including against external reference material, is an intended part of play rather than a gap to be engineered around.
9.2.1 Radar Display
ARCH-DET-31. A vessel with a radar sensor shall present a traditional top-down radar scope: own ship at the center or at a fixed reference point, contacts shown as blips at their detected bearing and range, consistent with ARCH-UI-01's prohibition on a 3D environment.
ARCH-DET-32. The radar scope is the one station type permitted to show contacts pre-plotted at a bearing and range, since that is what the sensor itself returns; this does not conflict with ARCH-SP-05, which withholds a fused, cross-sensor plot rather than a single sensor's direct readout.
ARCH-DET-33. The radar scope shall render ambient clutter and noise consistent with sea state and range, including the possibility of a spurious blip, so that the display is not a perfectly clean list of true contacts.
ARCH-DET-34. The scope shall display a rotating sweep line consistent with a period-appropriate rotating radar. A contact within detection range shall only be illuminated, meaning newly shown or refreshed to its current position, at the moment the sweep line passes over its true bearing. A player shall therefore wait for the sweep to come back around rather than seeing every contact continuously.
ARCH-DET-36. Between illuminations, a blip shall persist and fade gradually across several sweep rotations rather than disappearing immediately, so that a contact briefly missed or temporarily masked remains visible at reduced confidence for a forgiving grace period before it is finally dropped, consistent with the staleness principle of ARCH-DET-05.
9.3 Subsurface Detection and Hydrophone Operation
ARCH-DET-12. Passive sonar shall yield bearing to a contact without range, and shall be the primary subsurface sensor. Range shall be resolvable only by maneuvering to develop a solution across successive turns, by cross-fixing with another unit, or by an active sensor.
ARCH-DET-13. Active sonar shall yield both bearing and range, at the cost of revealing the emitting unit under ARCH-DET-11.
ARCH-DET-14. Each unit shall have a noise signature that increases with speed and with the machinery it is running. Speed shall therefore trade directly against stealth, and shall degrade a unit's own passive sonar performance.
ARCH-DET-15. The system shall model depth in simplified layers, at minimum above and below a thermal layer set per scenario. The layer shall attenuate detection across it, allowing a submarine to use depth to break or avoid contact.
ARCH-DET-16. Sensor coverage shall be directional where appropriate, including baffles astern of a hull-mounted array. Clearing baffles shall be an available maneuver.
ARCH-DET-17. Air-delivered subsurface sensors, at minimum sonobuoys and dipping sonar, shall be available to aircraft, shall persist for a limited number of turns where applicable, and shall report into the contact picture of their side.
ARCH-DET-26. A vessel's passive sonar station shall present a hydrophone interface with a control the player can freely spin through the full 360 degrees of relative or true bearing, rather than receiving a finished list of contacts.
ARCH-DET-27. As the player spins the control, the interface shall play the class's hydrophone contact sound for each detectable contact, increasing in perceived loudness as the dial approaches that contact's true bearing and fading as it moves away, layered over the class's ambient ocean noise. The loudness rise shall be broad rather than a narrow spike, giving the player a wide, forgiving zone in which a contact is audible before the exact bearing is pinpointed, consistent with a rudimentary rather than precision exercise. The interface is intended to be listened to on headphones and shall support stereo or binaural panning where the playback device allows it, on the same near-louder, far-fainter principle.
ARCH-DET-28. Perceived loudness of a contact through the hydrophone shall reflect range and the source unit's noise signature (ARCH-DET-14), attenuated further by the thermal layer (ARCH-DET-15) and by baffles (ARCH-DET-16), rather than a flat detection radius.
ARCH-DET-29. Spinning the control shall be available to the player throughout the ordering phase, without consuming or being limited by the turn timer, so that a player may listen for as long as the phase allows before submitting orders.
ARCH-DET-30. The bearing a player settles on when submitting orders is a manual reading taken from the interface; the system is not required to record or grade the player's chosen bearing against the true bearing beyond what the resulting orders (such as a course to intercept or a firing solution input) already imply.
ARCH-DET-35. The hydrophone interface shall additionally display an approximate range estimate for a contact currently centered under the dial, derived coarsely from perceived loudness rather than a precise sensor return, consistent with passive sonar yielding no true range under ARCH-DET-12. This estimate shall be presented as a rough band, near, medium, or far, set as a fixed proportion of that contact's own maximum passive detection range at its current noise signature (for example, roughly the closest third as near, the middle third as medium, and the outer third as far), so that a quiet contact and a loud one are each judged against their own detectability rather than a single fixed distance.
ARCH-DET-37. Where a vessel's Sonar capability (ARCH-STA-02) is held on a station separate from Hydrophone, it shall present a distinct active-ping control: triggering a ping applies the active sonar rules of ARCH-DET-13, returning bearing and range for detected contacts directly, at the cost of revealing the emitting vessel per ARCH-DET-11. Where Sonar and Hydrophone are combined onto one station, the same active-ping control shall be available alongside the passive dial of ARCH-DET-26.
ARCH-DET-38. Active sonar shall be subject to a brief recharge or cooldown period between pings, so that continuous active pinging is not a free substitute for passive listening.
9.4 Fire Control and Prosecution
ARCH-DET-18. Torpedoes shall be simulation objects in their own right, moving and searching across turns rather than resolving instantly on launch.
ARCH-DET-19. A torpedo shall be launched against a contact and its solution, not against ground truth. A poor solution shall be capable of producing a miss against a real target.
ARCH-DET-20. A running torpedo shall be detectable by the target under the passive sonar rules, giving the target an opportunity to react before resolution.
ARCH-DET-21. Countermeasures, at minimum decoys and noisemakers, shall be available and shall be capable of seducing or defeating a torpedo seeker.
ARCH-DET-22. Damage shall be resolved against vessel health and against individual subsystems, so that a unit may survive an engagement while losing sensor, propulsion, or weapon capability.
ARCH-DET-23. Subsystem loss shall feed back into the detection model. A damaged array shall degrade the contact picture rather than merely reducing a number.
ARCH-FC-01. A weapon station shall present a rudimentary firing computer interface into which the player manually enters solution inputs, at minimum target bearing, an estimated range or range rate, and an estimated target course and speed, derived by the player from the readings available under Sections 9.1 and 9.3.
ARCH-FC-06. Solution inputs shall be entered through coarse dials and sliders rather than typed numeric fields, sized and spaced for touchscreen use, consistent with the tablet-class hardware targeted by ARCH-PD-03.
ARCH-FC-02. The firing computer shall compute a gyro angle or lead from the player's entered inputs and shall display it to the player before launch, consistent with a real fire-control problem, but shall not correct or validate the player's inputs against ground truth.
ARCH-FC-03. The accuracy of the player's manually entered solution, measured as its deviation from ground truth at the moment of launch, shall directly govern the resulting torpedo's probability of acquiring and hitting its target. A precise manual solution shall meaningfully outperform a rough one.
ARCH-FC-04. Travel time between launch and impact or terminus shall be simulated across the number of turns implied by weapon speed and solution range, rather than resolved on the turn of launch, preserving the suspense of a running weapon and the target's opportunity under ARCH-DET-20.
ARCH-FC-05. The firing station shall display a running weapon's elapsed and remaining time to impact once launched, without revealing whether it will hit.
ARCH-FC-07. Weapons Control shall additionally support deck guns, resolved as a direct-fire weapon against a visually detected surface contact (ARCH-DET-24) within line-of-sight range, rather than the multi-turn solution process of ARCH-FC-01 through ARCH-FC-04. A deck gun engagement shall resolve within the same turn it is ordered, reflecting its much shorter time of flight.
ARCH-FC-08. Weapons Control shall additionally support depth charges, resolved as an area-effect attack against a point or a contact's current bearing and estimated range rather than a guided firing solution. Accuracy shall depend on how closely the player's targeted point matches the target's true position at the moment of attack, reflecting a depth charge's lack of homing.
ARCH-FC-09. Deck gun and depth charge employment, like torpedo launch, shall be recorded in turn history and included in the after-action report of ARCH-SM-16.
10. Non-Player Units
ARCH-NPC-01. The simulation shall support non-player vessels and non-player aircraft, controlled by the umpire.
ARCH-NPC-02. Non-player units shall be full simulation objects, subject to the same movement, detection, damage, and engagement rules as player units.
ARCH-NPC-03. The umpire shall be able to create, assign to a side, position, order, and remove non-player units during scenario authoring and during a running game, selecting their class from the vessel library.
ARCH-NPC-04. The umpire shall issue orders for non-player units during the ordering phase, and those orders shall resolve in the same turn processing as player orders.
ARCH-NPC-05. Non-player units shall support simple standing behaviors, at minimum hold station, transit to a point, and patrol a defined area or track, so that the umpire is not obliged to order every unit every turn.
ARCH-NPC-06. A standing behavior shall persist across turns until changed, and shall be overridable by an explicit umpire order on any turn.
ARCH-NPC-07. Aircraft shall model, at minimum, altitude, endurance, and a station or patrol area, and shall be capable of carrying the sensors and weapons defined in Section 9.
ARCH-NPC-08. Aircraft endurance shall be finite, requiring the umpire to cycle aircraft off station.
ARCH-NPC-09. The umpire shall be able to convert a non-player unit into a player-crewed unit by assigning it stations and issuing an access link, and to return a player unit to umpire control.
ARCH-NPC-10. For a non-player unit, any check that would otherwise depend on a player's manual attention, such as a hydrophone operator noticing a contact while sweeping (ARCH-DET-26), shall instead be resolved automatically by a randomized detection roll, weighted by the same factors that govern the equivalent player-facing sensor, including range, noise signature, and environmental attenuation.
ARCH-NPC-11. The result of an automatic detection roll shall be presented to the umpire as the outcome applied to that unit's contact picture, and the umpire shall be able to override it before the turn resolves, so that the roll speeds up routine handling without removing umpire judgment.
ARCH-NPC-12. Automatic detection rolls, and the fact that a given contact outcome was determined by one, shall be visible only to the umpire. No indication of a roll, its odds, or its result shall be exposed to any player station, so that the underlying randomness does not become information players can react to.
ARCH-NPC-13. Every automatic detection roll shall be recorded in turn history (Section 4.1) as a distinct entry, including its computed probability, its result, and whether the umpire overrode it, so that the umpire can review how NPC-side detection was resolved after the fact. This history entry remains subject to ARCH-NPC-12 and is never exposed to players, including in the after-action report of ARCH-SM-16.
11. Turn Model
ARCH-TM-01. The umpire shall be able to set a timer within which players must submit their orders for the turn.
ARCH-TM-02. On timer expiry, the system shall automatically lock order entry at every station. Players shall not be able to submit or amend orders once locked.
ARCH-TM-03. Orders submitted before the lock shall be the orders of record for that turn. A unit that submitted nothing shall retain its orders from the previous turn as standing orders.
ARCH-TM-04. Timer expiry shall not itself resolve the turn. Resolution shall occur only when the umpire elects to proceed.
ARCH-TM-05. The umpire shall be able to lock ordering early, reopen ordering after a lock, and extend or reset the timer before resolution.
ARCH-TM-06. On resolution, the system shall process all orders of record, including those of non-player units, and advance the simulation to the next state and turn number.
ARCH-TM-07. Turn resolution shall be simultaneous. No side shall gain advantage from the order in which units are processed within a turn.
ARCH-TM-08. Turn length shall be a scenario setting, so that a scenario may be run at a coarse or fine time step.
12. Umpire Controls and Communications
ARCH-UC-01. The system shall provide a rudimentary scenario configurator enabling the umpire to set up scenarios, including placing vessels and non-player units from the library, setting station layouts, setting the operating area, environment, and turn length, and setting access modes.
ARCH-UC-02. The umpire shall be able to dynamically edit the state of player vessels during play, so that the outcomes of activities conducted outside the simulation can be reflected within it.
 Rationale: in live in-person games, the umpire may set players tasks that occur away from the terminal.
ARCH-UC-03. Editable vessel state shall include, at minimum, vessel health and the status of the vessel's subsystems.
ARCH-UC-04. Umpire edits shall take effect immediately and shall be pushed to affected stations without waiting for turn resolution.
ARCH-UC-05. The umpire shall have an Umpire View: a top-down tactical map showing all units at their true plotted positions, all contacts held by each side, and the current orders of record, giving the umpire a single view of the whole exercise at a glance.
ARCH-UC-06. The umpire shall be able to inject and remove contacts in a unit's contact picture directly, allowing a false contact or an adjudicated detection to be introduced without a corresponding unit.
ARCH-UC-08. The Umpire View's top-down map is reserved to the umpire role. No player station shall present a top-down plotted map of the exercise, consistent with ARCH-SP-05 and ARCH-SP-07.
12.1 Communications
ARCH-UC-07. The umpire shall be able to send text messages to an individual station, to a vessel, or to all players, for orders from higher command and out-of-band adjudication.
ARCH-UC-09. A vessel's Communications station shall present a terminal-like message log where incoming umpire messages appear, distinct from any other station's readouts.
ARCH-UC-10. The umpire shall be able to choose, per message, whether it is sent in plain text or encoded as Morse code. A Morse-coded message shall be presented to the Communications station as its raw code (for example, as audible tones, blinking light, or printed dots and dashes), requiring the player to transcribe and translate it rather than reading it directly.
ARCH-UC-11. The system is not required to provide an in-interface Morse decoder for players; translation is intended to be worked out by the crew, consistent with the manual, paper-based plotting philosophy of Section 3.
ARCH-UC-12. The umpire's copy of a sent message shall always show its plain-text content regardless of how it was delivered to the player, so the umpire is not obliged to decode their own traffic.

Open Questions
Deck gun and depth charge accuracy model. ARCH-FC-07 and ARCH-FC-08 resolve these weapons more simply than the torpedo solution of Section 9.4, but the precise probability curve behind each, and how ARCH-STA hardware constraints affect their touch controls, is left as a tuning and interface detail.
Morse transmission pacing. ARCH-UC-10 sends a coded message as raw Morse. Whether it plays or displays at a fixed real-world code speed, is repeatable on demand, or is limited to one playback, will materially affect difficulty and is not yet specified.
Aircraft basing. Section 10 gives aircraft finite endurance but the architecture does not yet say where an aircraft goes, or what happens to it, once it must cycle off station, such as a carrier, a shore base, or simple removal from play.
Merchant behavior. Merchants are named as an NPC type in ARCH-STA-01 but are not yet given behavior beyond the general standing behaviors of ARCH-NPC-05; whether a merchant needs any target-specific logic (for example, evasive maneuvering once attacked) is open.



