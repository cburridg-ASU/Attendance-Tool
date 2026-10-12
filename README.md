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
values, student names, and location coordinates are not recorded.

The server and per-device diagnostic files are cleared after 15 attendance
sessions, matching the existing server log retention behavior.

If a student's device cannot access location during check-in, the check-in can
still be submitted. It is marked `Flagged`, its distance is stored/exported as
`Unknown`, and the attendance table and CSV identify the `Device login error`.
