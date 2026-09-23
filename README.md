# AttendanceRabbit

## Render setup

Deploy this repository as a Render Web Service using the included `render.yaml`.

Set these environment variables in Render:

- `DATABASE_URL`: the Internal Database URL from a Render PostgreSQL database. The API uses temporary in-memory storage when this is omitted, which is only suitable for local testing.
- `FRONTEND_ORIGIN`: the exact GitHub Pages origin, for example `https://your-user.github.io`.

The service health check is `GET /health`.
