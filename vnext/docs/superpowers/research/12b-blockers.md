# Spec 12b Blockers

## B1 (Plan A, Task 1, Step 1) — vNext docker missing admin user seed

`docker-compose.vnext.yml` only sets `VNEXT_DEV_*` envs; no seed row for `test@local.dev` is created on container start. Root auto-seeds via `src/local.ts:347`.

**Resolution path adopted:** `seed-admin-session.ts` (this task) inserts the admin user row directly into the vnext sqlite file when it does its session insert, so we do NOT need to rebuild the docker image. Future cleanup: fold this into the vnext docker entrypoint when convenient.
