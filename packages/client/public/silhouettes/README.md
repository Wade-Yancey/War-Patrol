# Periscope silhouettes

Hull-class → image map used by the submarine Periscope Sensors tab (side elevation / side profile).

| Hull class | Asset | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.png` | Solid opaque black side elevation on transparent. Derived from Wade’s recognition plate (`destroyer.jpg` kept as source). |
| Other classes | _(none)_ | Missing → CRT `?` placeholder. Add kebab files later or reuse stub. |

**Why solid PNG (not stippled JPG):**

1. Wade’s plate is white-bg + dithered gray ink. A white-bg JPG under `brightness(0)` phosphor CSS becomes a solid phosphor rectangle (ink and paper both go black).
2. A “transparent” PNG that keeps the stipple as semi-transparent dark pixels stays nearly invisible on a dark CRT — and still fails after phosphor recolor.
3. Fix: crop side elevation, threshold ink → **fully opaque black**, white → transparent. Viewport uses a **blue sky/sea** plane (no `brightness(0)` on the image) so the black hull has clear contrast.

Resolver: `silhouetteUrlForClass()` in `@war-patrol/shared` (`periscope.ts`).

Optional `destroyer.svg` stub remains unused by the client resolver.
