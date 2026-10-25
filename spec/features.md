# What every team builds

One habit tracker, built once per stack. Clients and backends are separate teams and meet only at
`openapi.yaml`, so every client must work with every backend.

## Features

1. Create, edit and archive habits: name, icon, colour, rhythm (daily, x times a week, specific
   weekdays), reminder time.
2. Today: check habits off, also several times a day (for example 3 of 8 glasses of water).
3. Streaks: current and longest.
4. History as a calendar heatmap over 12 months.
5. Charts: completion rate per week and per month (line), comparison of all habits (bars).
6. Local reminders at the reminder time. iOS, Android, macOS and Windows schedule them through the
   system, so they also arrive while the app is closed. On Linux the app may keep running in the
   tray with autostart for this. On the web reminders only fire while the app is open.
7. Offline first: everything works without a connection and syncs with the server once it is back.
   Conflicts resolve last-write-wins per record (`openapi.yaml`).
8. Sign-in with email and password; two devices of the same account stay in sync.
9. Export and import as JSON and CSV through the platform's file dialog (`export.md`).
10. German and English, switchable; light and dark following the system.

How due days, streaks and rates are computed is fixed in `rules.md`. Look, layout and test IDs come
from the mockup (`mockup/index.html`, direction A) and `test-ids.json`.

Bonus, not required: home screen widget (iOS, Android) or tray / menu bar (desktop), deep link
`stackarena://habit/<id>`, haptics when checking off (mobile), Web Push for reminders while the
browser tab is closed.

## Client targets

One codebase for macOS (Intel and Apple Silicon), Linux, Windows, Android, iOS and Web. Platform
code (Swift, Kotlin, Dart, JNI and so on) is allowed inside the team folder where the stack lacks a
platform feature.

## Deliverables

### Backend team, folder `backends/<team>/`

- Implements `openapi.yaml` on Postgres. Connection string from `DATABASE_URL`, port from `PORT`
  (default 8080). The server creates or migrates its schema on start.
- `start.sh` installs what is missing and starts the server in the foreground.
- `Dockerfile` builds a production image that takes the same environment variables.
- `STATUS.md` says what works and what does not.

### Client team, folder `clients/<team>/`

- Backend address from `STACKARENA_API_URL` at build time, default `http://localhost:8080`.
- `serve-web.sh` builds the web target and serves it on port 5173 in the foreground.
- Build setup for all seven targets.
- `STATUS.md` lists per target what builds, what runs and what was verified.
- A team whose stack includes a CLI follows `cli.md`.

## Checks

From `harness/` after `bun install`:

- Backend: `BASE_URL=http://localhost:8080 bun test api/`
- Client (web): `TARGET=web CLIENT_URL=http://localhost:5173 BASE_URL=<backend url> bunx playwright test`

The organisers additionally run the contract and load tests, the native E2E runs and the
performance measurements. Scenarios that are skipped against the mockup (offline sync, second
device, export, import) count fully for real clients.

## Rules

- Change files only inside your team folder. `spec/` and `harness/` are read-only.
- Nobody answers questions during a run. Decide yourself and note open points in `STATUS.md`.
