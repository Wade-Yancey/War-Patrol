# Periscope silhouettes

Side-profile recognition plates for the submarine periscope Sensors tab.

| Hull class | File | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.png` | Side-profile plate with alpha (stippled hull, bow right). Bundled via Vite at `packages/client/src/assets/silhouettes/destroyer.png` and mounted as a plain `<img>` in `PeriscopeScope` (no CSS filters). Public copy kept for static `/silhouettes/destroyer.png` checks. |

Keep both copies byte-identical when updating the plate. Preserve PNG transparency (`tRNS` / alpha) so the plate composites over the periscope sky/sea.

Resolver (docs / verify): `silhouetteUrlForClass()` / `DESTROYER_SILHOUETTE_URL` in `@war-patrol/shared` → `/silhouettes/destroyer.png`.  
Runtime UI: Vite import in `PeriscopeScope.tsx` (bundled URL).
