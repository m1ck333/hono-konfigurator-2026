# Storage reorganization — clean R2 layout + migration mapping

The legacy Laravel storage is inconsistent (some paths have a `storage/` prefix, some don't;
equipment lives under two roots `images/equipment` AND `equipments/`; thumbnails vs full images
are crossed; some `equipment_others.thumbnail` values are bare codes, not paths). During the
migration we **re-key every asset by its row id** into one predictable scheme in R2, and rewrite
the DB (D1) paths to match. No more `storage/` prefix; one root; one pattern per entity.

## Clean R2 layout (D1 stores exactly these keys)
```
doors/{model_code}/staklo.png          # compositing layer assets (per model, derived by renderer)
doors/{model_code}/sandblast.png        #   (fallback glass)
doors/{model_code}/udubljenje.png       #   dent
doors/{model_code}/okvir.png            #   glass frame
doors/{model_code}/oplata.png           #   plating
doors/{model_code}/thumbnail.png        # catalog thumbnail
frame/{side-L,side-R,side-T,side-LT,corner-L,corner-R,pillar-H,pillar-V}.png
glass/{name}.png                        # named compositing glass (chinchilla, sandblast, ...)
sideglass/{name}.jpg
colors/{id}.png                         # color swatch/texture
locks/{id}.png                          # lock thumbnail
systems/{id}.png                        # system thumbnail
glasses/{id}.png                        # equipment_glass thumbnail
equipment/{category}/{id}.png           # equipment_other RENDER overlay (from .image)
equipment/{category}/{id}-inner.png     # spy inner overlay (from .inner_image)
equipment/{category}/{id}-thumb.png     # selector thumbnail (from .thumbnail)
houses/{id}.png
house-colors/{id}.png
logos/{user_id}.png
```
`{category}` = the equipment category code (handrail, spy, hinges, doorknobInside, ...).

## Mapping (old DB path/pattern -> new key), by table.column
| Source | New key | Notes |
|---|---|---|
| `colors.thumbnail` | `colors/{id}.png` | |
| `doors.thumbnail` | `doors/{model_code}/thumbnail.png` | |
| `equipment_glasses.thumbnail` | `glasses/{id}.png` | |
| `equipment_locks.thumbnail` | `locks/{id}.png` | |
| `equipment_systems.thumbnail` | `systems/{id}.png` | |
| `equipment_others.image` | `equipment/{cat}/{id}.png` | the overlay the renderer composites |
| `equipment_others.inner_image` | `equipment/{cat}/{id}-inner.png` | spy |
| `equipment_others.thumbnail` | `equipment/{cat}/{id}-thumb.png` | selector image (bare-code values -> resolve or drop) |
| `house_colors.thumbnail` | `house-colors/{id}.png` | |
| `houses.image` | `houses/{id}.png` | |
| `users.logo` | `logos/{user_id}.png` | |
| dir `images/doors/{code}/*` | `doors/{code}/*` | door part-assets (not in DB) |
| dir `images/frame/*` | `frame/*` | |
| dir `images/glass/*` | `glass/*` | |
| dir `images/sideglass/*` | `sideglass/*` | |

## File resolution (handles the mess)
For each DB path, the migrator locates the ACTUAL file by trying candidates in order:
1. `storage/app/public/<path with leading 'storage/' stripped>`
2. same but swapping `images/` <-> `thumbnails/` (the wrong-folder cases, e.g. handrails)
3. `storage/app/public/equipments/<...>` (the alt root)
4. by basename search under `storage/app/public` (last resort)
If none found -> logged as MISSING (the asset genuinely doesn't exist; row keeps null path).

## Execution
`migrate/reorg.mjs` runs against the droplet (DB + files). It:
1. reads every path column,
2. resolves the source file, copies it to a staging tree under the NEW key,
3. emits `migrate/out/paths.sql` (D1 UPDATEs to the clean keys) + a `MISSING.txt` report.
The staging tree is then synced to R2 (rclone/S3) — local for dev, prod when the CF account is ready.
