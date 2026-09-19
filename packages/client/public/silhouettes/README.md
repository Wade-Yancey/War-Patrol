# Periscope silhouettes

Hull-class → image map used by the submarine Periscope Sensors tab.

| Hull class | Asset | Notes |
| --- | --- | --- |
| Destroyer | `destroyer.jpg` | Wade’s raw recognition plate (white plate + black line art). Served as-is from Vite `public/` → `/silhouettes/destroyer.jpg`. |
| Other classes | _(none mapped)_ | UI falls back to `destroyer.jpg` whenever a contact is selected so the left panel always shows a photo. |

**Display:** Plain `<img>` on a blue sky/sea viewport — **no** CSS filters, phosphor invert, or opacity tricks. Min size enforced so the plate cannot collapse to zero.

Resolver: `silhouetteUrlForClass()` / `periscopeSilhouetteUrl()` in `@war-patrol/shared` (`periscope.ts`).

Optional `destroyer.png` / `destroyer.svg` stubs remain in-tree but are **unused**.
