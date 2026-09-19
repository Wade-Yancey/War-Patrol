# Periscope silhouettes

Side-profile recognition plates for the submarine periscope Sensors tab.

| Hull class | File | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.jpg` | Wade’s raw recognition plate (white plate + black line art). Also bundled via Vite at `packages/client/src/assets/silhouettes/destroyer.jpg` and mounted as a plain `<img>` in `PeriscopeScope` (no CSS filters). Public copy kept for static `/silhouettes/destroyer.jpg` checks. |

Keep both copies byte-identical when updating the plate.

Resolver (docs / verify): `silhouetteUrlForClass()` / `DESTROYER_SILHOUETTE_URL` in `@war-patrol/shared` → `/silhouettes/destroyer.jpg`.  
Runtime UI: Vite import in `PeriscopeScope.tsx` (bundled URL).
