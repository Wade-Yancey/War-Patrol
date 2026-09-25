# Periscope / lookout silhouettes

Side-profile recognition plates for the Sensors visual optics tab (sub periscope + DD lookout).

| Hull class / plate | File | Notes |
| --- | --- | --- |
| Destroyer (Fletcher default) | `destroyer.png` | Side-profile plate with alpha (stippled hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/destroyer.png`. |
| Destroyer — Kagerō plate | `kagero.png` | IJN Kagerō-class plate as Wade’s provided RGBA profile (grayscale detail + alpha, bow right) — shipped lossless, not quantized/inverted. Selected via `silhouettePlate: "kagero"` / `classId` containing `kagero`. Does **not** overwrite Fletcher `destroyer.png`. |
| Fleet Submarine | `submarine.png` | Side-profile plate with alpha (halftone hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/submarine.png`. |
| Oiler | `oiler.png` | Cimarron-class (T3-S2-A1) fleet oiler plate with alpha (halftone hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/oiler.png`. |
| Aircraft Carrier | `carrier.png` | Shōkaku-class fleet carrier plate with alpha (grayscale hull, bow right; derived from port-side reference, flipped). Bundled via Vite at `packages/client/src/assets/silhouettes/carrier.png`. |

Keep public + Vite asset copies byte-identical when updating a plate. Preserve PNG transparency (`tRNS` / alpha) so the plate composites over the optics sky/sea. CRT grain/scanlines are CSS overlays above the `<img>` — do not bake them into the PNG.

## Horizontal flip (port / starboard aspect)

Plates are authored **bow right** (starboard-side elevation). The optics CRT mirrors them with CSS `scaleX(-1)` when the observed aspect is **port**:

1. `trueBearing = ownHeading + relativeBearing` (FoW coarsened relative bearing).
2. Signed AOB = shortest turn from FoW `courseDeg` to `trueBearing + 180°` (bearing from target back to observer).
3. **`aob < 0` → flip** (port aspect, bow left); **`aob ≥ 0` → no flip** (starboard / end-on, bow right).
4. No `courseDeg` (periscope feathers) → no flip.

Helper: `periscopeSilhouetteFlipX()` in `@war-patrol/shared`. UI class: `.periscope-silhouette--flip` in `PeriscopeScope`.

Resolver (docs / verify): `silhouetteUrlForClass()` / `silhouetteUrlForOptics()` / `DESTROYER_SILHOUETTE_URL` / `KAGERO_SILHOUETTE_URL` / `SUBMARINE_SILHOUETTE_URL` / `OILER_SILHOUETTE_URL` / `CARRIER_SILHOUETTE_URL` in `@war-patrol/shared`.  
Runtime UI: class + plate map of Vite imports in `PeriscopeScope.tsx` (bundled URLs). Unknown classes fall back to the destroyer plate.
