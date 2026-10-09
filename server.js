import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 10000;
const frontendOrigin = process.env.FRONTEND_ORIGIN || '*';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const memorySessions = new Map();
const diagnosticsPath = path.join(process.cwd(), 'server-logs', 'attendance-diagnostics.log');
const diagnosticsUsagePath = path.join(process.cwd(), 'server-logs', 'attendance-uses.json');
const devPassword = process.env.DEV_LOG_PASSWORD || 'DevDimeLab';
const failedDevLogAttempts = new Map();
const diagnosticReportAttempts = new Map();
let attendanceUses = 0;
let diagnosticsQueue = Promise.resolve();

app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '32kb' }));
app.use('/server-logs', (req, res) => res.sendStatus(404));
app.use(express.static(process.cwd(), { index: 'index.html' }));

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function withAsyncErrors(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function enqueueDiagnostics(task) {
  const pending = diagnosticsQueue.then(task);
  diagnosticsQueue = pending.catch(error => console.error('Diagnostics write failed:', error.message));
  return pending;
}

function appendDiagnostic(level, event, details = {}) {
  return enqueueDiagnostics(async () => {
    await fs.mkdir(path.dirname(diagnosticsPath), { recursive: true });
    const timestamp = new Date().toISOString();
    const detailText = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    await fs.appendFile(diagnosticsPath, `${timestamp} | ${level} | ${event}${detailText ? ` | ${detailText}` : ''}\n`, 'utf8');
  }).catch(error => console.error('Diagnostics write failed:', error.message));
}

function recordAttendanceUse() {
  return enqueueDiagnostics(async () => {
    await fs.mkdir(path.dirname(diagnosticsPath), { recursive: true });
    attendanceUses += 1;
    if (attendanceUses >= 15) {
      attendanceUses = 0;
      await fs.writeFile(diagnosticsPath, '', 'utf8');
      await fs.writeFile(diagnosticsUsagePath, JSON.stringify({ uses: 0 }), 'utf8');
      const timestamp = new Date().toISOString();
      await fs.appendFile(diagnosticsPath, `${timestamp} | INFO | Log reset after 15 attendance sessions\n`, 'utf8');
      return;
    }
    await fs.writeFile(diagnosticsUsagePath, JSON.stringify({ uses: attendanceUses }), 'utf8');
  }).catch(error => console.error('Attendance usage counter update failed:', error.message));
}

function passwordMatches(candidate) {
  const expected = Buffer.from(devPassword);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
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

app.post('/api/diagnostics', withAsyncErrors(async (req, res) => {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const attempts = diagnosticReportAttempts.get(address) || { count: 0, startedAt: Date.now() };
  if (Date.now() - attempts.startedAt >= 60_000) {
    attempts.count = 0;
    attempts.startedAt = Date.now();
  }
  attempts.count += 1;
  diagnosticReportAttempts.set(address, attempts);
  if (attempts.count > 30) return res.status(429).json({ error: 'Diagnostic reporting limit reached.' });
  const event = cleanText(req.body.event, 80).replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (!event) return res.status(400).json({ error: 'A diagnostic event is required.' });
  await appendDiagnostic('CLIENT', event, {
    message: cleanText(req.body.message, 240).replace(/[\r\n\u0000-\u001f]/g, ' '),
    path: cleanText(req.body.path, 120),
    session: cleanText(req.body.sessionCode, 6).toUpperCase(),
    status: Number.isInteger(req.body.status) ? req.body.status : undefined,
    browser: cleanText(req.body.browser, 180),
    secureContext: typeof req.body.secureContext === 'boolean' ? req.body.secureContext : undefined,
    geolocation: typeof req.body.geolocation === 'boolean' ? req.body.geolocation : undefined
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/dev/diagnostics', withAsyncErrors(async (req, res) => {
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const failures = failedDevLogAttempts.get(address) || { count: 0, blockedUntil: 0 };
  if (Date.now() < failures.blockedUntil) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const candidate = cleanText(req.get('x-dev-password'), 200);
  if (!passwordMatches(candidate)) {
    failures.count += 1;
    if (failures.count >= 5) failures.blockedUntil = Date.now() + 5 * 60 * 1000;
    failedDevLogAttempts.set(address, failures);
    return res.status(401).json({ error: 'Developer password is incorrect.' });
  }
  failedDevLogAttempts.delete(address);
  let content = '';
  try { content = await fs.readFile(diagnosticsPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  res.type('text/plain').send(content || 'No diagnostics have been recorded.');
}));

app.post('/api/sessions', withAsyncErrors(async (req, res) => {
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
  await recordAttendanceUse();
  res.status(201).json(sessionView(session));
}));

app.get('/api/sessions/:code', withAsyncErrors(async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  const session = await getSession(code);
  if (!session) {
    await appendDiagnostic('WARN', 'session_lookup_not_found', { session: code });
    return res.status(404).json({ error: 'Session not found.' });
  }
  res.json(sessionView(session));
}));

app.post('/api/sessions/:code/checkins', withAsyncErrors(async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  const session = await getSession(code);
  if (!session || !session.active) {
    await appendDiagnostic('WARN', 'checkin_session_inactive_or_missing', { session: code });
    return res.status(404).json({ error: 'This attendance session is not active.' });
  }
  const studentName = cleanText(req.body.name, 120);
  const deviceToken = cleanText(req.body.deviceToken, 120);
  const distance = Math.max(0, Math.round(Number(req.body.distance) || 0));
  if (!studentName || !deviceToken) {
    await appendDiagnostic('WARN', 'checkin_missing_fields', { session: code });
    return res.status(400).json({ error: 'Student name and device token are required.' });
  }
  if (session.requireRosterMatch && !session.roster.some(name => name.toLowerCase() === studentName.toLowerCase())) {
    await appendDiagnostic('WARN', 'checkin_roster_mismatch', { session: code });
    return res.status(403).json({ error: 'That name is not on the class roster.' });
  }
  if (session.checkins.some(checkin => checkin.name.toLowerCase() === studentName.toLowerCase())) {
    await appendDiagnostic('WARN', 'checkin_duplicate_student', { session: code });
    return res.status(409).json({ error: 'This name has already been recorded for this session.' });
  }
  if (session.checkins.some(checkin => checkin.deviceToken === deviceToken)) {
    await appendDiagnostic('WARN', 'checkin_duplicate_device', { session: code });
    return res.status(409).json({ error: 'This device has already submitted attendance for this session.' });
  }
  const status = distance <= session.radius ? 'Present' : 'Flagged';
  const submittedAt = new Date();
  const checkin = { name: studentName, time: submittedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), distance: `${distance} m`, status, deviceToken };
  if (pool) {
    try {
      await pool.query('INSERT INTO attendance_checkins (id, session_code, student_name, distance, status, device_token) VALUES ($1, $2, $3, $4, $5, $6)', [crypto.randomUUID(), code, studentName, distance, status, deviceToken]);
    } catch (error) {
      if (error.code === '23505') {
        await appendDiagnostic('WARN', 'checkin_duplicate_database_constraint', { session: code });
        return res.status(409).json({ error: 'This student or device already checked in.' });
      }
      throw error;
    }
  } else session.checkins.unshift(checkin);
  res.status(201).json({ ...checkin, deviceToken: undefined });
}));

app.post('/api/sessions/:code/end', withAsyncErrors(async (req, res) => {
  const code = cleanText(req.params.code, 6).toUpperCase();
  if (pool) await pool.query('UPDATE attendance_sessions SET active = false WHERE code = $1', [code]);
  else if (memorySessions.has(code)) memorySessions.get(code).active = false;
  res.json({ ok: true });
}));

app.use((error, req, res, next) => {
  console.error(error);
  void appendDiagnostic('ERROR', 'server_request_error', {
    method: req.method,
    path: req.path,
    code: cleanText(error.code, 40),
    message: cleanText(error.message, 240).replace(/[\r\n\u0000-\u001f]/g, ' ')
  }).catch(logError => console.error('Unable to write server error log:', logError.message));
  res.status(500).json({ error: 'The attendance service encountered an error.' });
});

initializeDatabase().then(async () => {
  try {
    const usage = JSON.parse(await fs.readFile(diagnosticsUsagePath, 'utf8'));
    attendanceUses = Number.isInteger(usage.uses) ? Math.min(14, Math.max(0, usage.uses)) : 0;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  app.listen(port, () => console.log(`Attendance API listening on ${port}`));
}).catch(async error => {
  console.error(error);
  await appendDiagnostic('ERROR', 'server_startup_error', { message: cleanText(error.message, 240) }).catch(() => {});
  process.exit(1);
});