# AttendanceRabbit

## Render setup

Deploy this repository as a Render Web Service using the included `render.yaml`.

Set these environment variables in Render:

- `DATABASE_URL`: the Internal Database URL from a Render PostgreSQL database. The API uses temporary in-memory storage when this is omitted, which is only suitable for local testing.
- `FRONTEND_ORIGIN`: the exact GitHub Pages origin, for example `https://your-user.github.io`.

The service health check is `GET /health`.

## Developer diagnostics

The developer log records server events and separate per-device traces in
`server-logs/device-diagnostics/`. Each trace is identified by a hashed device
ID shown as `deviceId=...` in the server log. Enter that ID in the Developer
diagnostics panel to view or download the device trace. Device traces include
the attempted attendance session, app actions, and input field metadata; input
values, student names, and location coordinates are not recorded.

The server and per-device diagnostic files are cleared after 15 attendance
sessions, matching the existing server log retention behavior.
