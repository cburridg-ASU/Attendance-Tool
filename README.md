# AttendanceRabbit

## Render setup

Deploy this repository as a Render Web Service using the included `render.yaml`.

Set these environment variables in Render:

- `DATABASE_URL`: the Internal Database URL from a Render PostgreSQL database. The API uses temporary in-memory storage when this is omitted, which is only suitable for local testing.
- `FRONTEND_ORIGIN`: the exact GitHub Pages origin, for example `https://your-user.github.io`.

The service health check is `GET /health`.

## Developer diagnostics

The developer log records server events and separate per-device traces. When
PostgreSQL is configured, device events are stored in the database and remain
available across server restarts; text log files are also written under
`server-logs/device-diagnostics/`. Open Developer diagnostics and select a
device from the saved-device list to view or download its trace. The list shows
session details, last activity, and event count. Device traces include the
attempted attendance session, app actions, and input field metadata; input
values and location coordinates are not recorded. After a student attempts
check-in, their entered name is associated with that device trace so it can be
found in the developer device list.

Geolocation diagnostic events include the browser-reported permission state
when available, native error code/name/message, page visibility, and whether
the request began during a user gesture. Coordinates are never recorded.

The server and per-device diagnostic files are cleared after 15 attendance
sessions, matching the existing server log retention behavior.

If a student's device cannot access location during check-in, the check-in can
still be submitted. It is marked `Flagged`, its distance is stored/exported as
`Unknown`, and the attendance table and CSV identify the `Device login error`.

Instructor session creation prepares and loads the official QR image before
activating the session. The countdown begins only after that QR is ready; no
placeholder or inactive-session QR is displayed.
