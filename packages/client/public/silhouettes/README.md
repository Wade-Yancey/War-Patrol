# Periscope / lookout silhouettes

Side-profile recognition plates for the Sensors visual optics tab (sub periscope + DD lookout).

| Hull class | File | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.png` | Side-profile plate with alpha (stippled hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/destroyer.png`. |
| Fleet Submarine | `submarine.png` | Side-profile plate with alpha (halftone hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/submarine.png`. |
| Oiler | `oiler.png` | Cimarron-class (T3-S2-A1) fleet oiler plate with alpha (halftone hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/oiler.png`. |

Keep public + Vite asset copies byte-identical when updating a plate. Preserve PNG transparency (`tRNS` / alpha) so the plate composites over the optics sky/sea. CRT grain/scanlines are CSS overlays above the `<img>` — do not bake them into the PNG.

Resolver (docs / verify): `silhouetteUrlForClass()` / `DESTROYER_SILHOUETTE_URL` / `SUBMARINE_SILHOUETTE_URL` / `OILER_SILHOUETTE_URL` in `@war-patrol/shared`.  
Runtime UI: class map of Vite imports in `PeriscopeScope.tsx` (bundled URLs). Unknown classes fall back to the destroyer plate.
