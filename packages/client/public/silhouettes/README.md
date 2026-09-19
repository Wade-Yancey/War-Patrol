# Periscope silhouettes

Hull-class → image map used by the submarine Periscope Sensors tab (side elevation / side profile).

| Hull class | Asset | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.jpg` | Wade’s raw recognition plate (white plate + black line art). Served as-is — no PNG conversion, thresholding, or CSS phosphor filters. |
| Other classes | _(none)_ | Missing → CRT `?` placeholder. Add kebab files later or reuse stub. |

**Display:** Periscope viewport uses a blue sky/sea plane so the white plate + black lines stay readable. The image uses `object-fit: contain` with **no** `brightness(0)` / phosphor CSS filters.

Resolver: `silhouetteUrlForClass()` in `@war-patrol/shared` (`periscope.ts`) → `/silhouettes/destroyer.jpg`.

Optional `destroyer.png` / `destroyer.svg` stubs remain unused by the client resolver.
