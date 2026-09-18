# Periscope silhouettes

Hull-class → image map used by the submarine Periscope Sensors tab (side elevation / side profile).

| Hull class | Asset | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.png` | Side elevation only, transparent background. Derived from Wade’s recognition plate (`destroyer.jpg` kept as source). |
| Other classes | _(none)_ | Missing → CRT `?` placeholder. Add kebab files later or reuse stub. |

**Why PNG:** The phosphor CSS filter (`brightness(0)` → invert/sepia) needs transparent negative space. A white-background JPG becomes a solid phosphor rectangle after `brightness(0)` (ink and paper both go black), so the silhouette appears “missing.”

Resolver: `silhouetteUrlForClass()` in `@war-patrol/shared` (`periscope.ts`).

Optional `destroyer.svg` stub remains unused by the client resolver.
