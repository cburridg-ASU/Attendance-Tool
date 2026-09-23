import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 10000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || '*';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const memorySessions = new Map();

app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(process.cwd(), { index: 'index.html' }));

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sessionView(session) {
  return {
    code: session.code,
    className: session.className,
    room: session.room,
    radius: session.radius,
    active: session.active,
    checkins: session.checkins || []
  };
}

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      code VARCHAR(6) PRIMARY KEY,
      class_name TEXT NOT NULL,
      room TEXT NOT NULL,
      radius INTEGER NOT NULL,
      roster JSONB NOT NULL DEFAULT '[]'::jsonb,
      require_roster_match BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS attendance_checkins (
      id UUID PRIMARY KEY,
      session_code VARCHAR(6) NOT NULL REFERENCES attendance_sessions(code) ON DELETE CASCADE,
      student_name TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      distance INTEGER NOT NULL,
      status TEXT NOT NULL,
      device_token TEXT NOT NULL,
      UNIQUE (session_code, student_name),
      UNIQUE (session_code, device_token)
    );
  `);
}

async function getSession(code) {
  if (!pool) return memorySessions.get(code) || null;
  const result = await pool.query('SELECT * FROM attendance_sessions WHERE code = $1', [code]);
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const checkins = await pool.query('SELECT student_name AS name, submitted_at AS time, distance, status FROM attendance_checkins WHERE session_code = $1 ORDER BY submitted_at DESC', [code]);
  return { code: row.code, className: row.class_name, room: row.room, radius: row.radius, roster: row.roster || [], requireRosterMatch: row.require_roster_match, active: row.active, checkins: checkins.rows.map(checkin => ({ ...checkin, time: new Date(checkin.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), distance: `${checkin.distance} m` })) };
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/sessions', async (req, res) => {
  const className = cleanText(req.body.className, 120);
  const room = cleanText(req.body.room, 80);
  const radius = Number(req.body.radius);
  const roster = Array.isArray(req.body.roster) ? req.body.roster.map(name => cleanText(name, 120)).filter(Boolean).slice(0, 500) : [];
  const requireRosterMatch = Boolean(req.body.requireRosterMatch);
  if (!className || !room || !Number.isFinite(radius) || radius < 1) return res.status(400).json({ error: 'Class, room, and radius are required.' });
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (pool ? false : memorySessions.has(code));
  const session = { code, className, room, radius, roster, requireRosterMatch, active: true, checkins: [] };
  if (pool) await pool.query('INSERT INTO attendance_sessions (code, class_name, room, radius, roster, require_roster_match) VALUES ($1, $2, $3, $4, $5, $6)', [code, className, room, radius, JSON.stringify(roster), requireRosterMatch]);
  else memorySessions.set(code, session);
  res.status(201).json(sessionView(session));
});

app.get('/api/sessions/:code', async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  const session = await getSession(code);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  res.json(sessionView(session));
});

app.post('/api/sessions/:code/checkins', async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  const session = await getSession(code);
  if (!session || !session.active) return res.status(404).json({ error: 'This attendance session is not active.' });
  const studentName = cleanText(req.body.name, 120);
  const deviceToken = cleanText(req.body.deviceToken, 120);
  const distance = Math.max(0, Math.round(Number(req.body.distance) || 0));
  if (!studentName || !deviceToken) return res.status(400).json({ error: 'Student name and device token are required.' });
  if (session.requireRosterMatch && !session.roster.some(name => name.toLowerCase() === studentName.toLowerCase())) return res.status(403).json({ error: 'That name is not on the class roster.' });
  if (session.checkins.some(checkin => checkin.name.toLowerCase() === studentName.toLowerCase())) return res.status(409).json({ error: 'This name has already been recorded for this session.' });
  if (session.checkins.some(checkin => checkin.deviceToken === deviceToken)) return res.status(409).json({ error: 'This device has already submitted attendance for this session.' });
  const status = distance <= session.radius ? 'Present' : 'Flagged';
  const submittedAt = new Date();
  const checkin = { name: studentName, time: submittedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), distance: `${distance} m`, status, deviceToken };
  if (pool) {
    try {
      await pool.query('INSERT INTO attendance_checkins (id, session_code, student_name, distance, status, device_token) VALUES ($1, $2, $3, $4, $5, $6)', [crypto.randomUUID(), code, studentName, distance, status, deviceToken]);
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This student or device already checked in.' });
      throw error;
    }
  } else session.checkins.unshift(checkin);
  res.status(201).json({ ...checkin, deviceToken: undefined });
});

app.post('/api/sessions/:code/end', async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  if (pool) await pool.query('UPDATE attendance_sessions SET active = false WHERE code = $1', [code]);
  else if (memorySessions.has(code)) memorySessions.get(code).active = false;
  res.json({ ok: true });
});

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'The attendance service encountered an error.' }); });

initializeDatabase().then(() => app.listen(port, () => console.log(`Attendance API listening on ${port}`))).catch(error => { console.error(error); process.exit(1); });
