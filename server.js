const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function today() {
  const d = new Date();
  d.setHours(d.getHours() - 5); // Colombia UTC-5
  return d.toISOString().split('T')[0];
}

// ─── INIT DB ─────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      pillar TEXT NOT NULL CHECK(pillar IN ('gym','trabajo','espiritu')),
      date TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(member_id, pillar, date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB initialized');
}

initDb().catch(e => { console.error('DB init failed:', e); process.exit(1); });

// ─── REGISTER / LOGIN ────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Nombre requerido' });
  const clean = name.trim().toLowerCase();
  try {
    await pool.query('INSERT INTO members (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [clean]);
    const { rows } = await pool.query('SELECT * FROM members WHERE name = $1', [clean]);
    res.json({ id: rows[0].id, name: rows[0].name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const { rows } = await pool.query('SELECT * FROM members WHERE name = $1', [name.trim().toLowerCase()]);
    if (!rows.length) return res.status(404).json({ error: 'No registrado. Usa Registrarse primero.' });
    res.json({ id: rows[0].id, name: rows[0].name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CHECK-INS ───────────────────────────────────────
app.post('/api/checkin', async (req, res) => {
  const { member_id, pillar } = req.body;
  if (!member_id || !pillar) return res.status(400).json({ error: 'member_id y pillar requeridos' });
  if (!['gym','trabajo','espiritu'].includes(pillar)) return res.status(400).json({ error: 'Pillar inválido' });
  const date = today();
  try {
    await pool.query(
      'INSERT INTO checkins (member_id, pillar, date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [member_id, pillar, date]
    );
    res.json({ ok: true, pillar, date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/checkin', async (req, res) => {
  const { member_id, pillar } = req.body;
  if (!member_id || !pillar) return res.status(400).json({ error: 'member_id y pillar requeridos' });
  const date = today();
  try {
    await pool.query('DELETE FROM checkins WHERE member_id = $1 AND pillar = $2 AND date = $3', [member_id, pillar, date]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BOARD ───────────────────────────────────────────
app.get('/api/board', async (req, res) => {
  const date = today();
  try {
    const { rows: members } = await pool.query('SELECT * FROM members ORDER BY name');
    const { rows: todayCheckins } = await pool.query('SELECT * FROM checkins WHERE date = $1', [date]);

    const board = members.map(m => {
      const checks = todayCheckins.filter(c => c.member_id === m.id);
      return {
        id: m.id,
        name: m.name,
        avatar: m.name.charAt(0).toUpperCase(),
        gym: checks.some(c => c.pillar === 'gym'),
        trabajo: checks.some(c => c.pillar === 'trabajo'),
        espiritu: checks.some(c => c.pillar === 'espiritu'),
        score: checks.length,
      };
    });
    board.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const stats = {
      gym: board.filter(m => m.gym).length,
      trabajo: board.filter(m => m.trabajo).length,
      espiritu: board.filter(m => m.espiritu).length,
      total: members.length,
    };
    res.json({ board, stats, date, members: members.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STREAKS ─────────────────────────────────────────
app.get('/api/streaks', async (req, res) => {
  try {
    const { rows: members } = await pool.query('SELECT * FROM members ORDER BY name');
    const streaks = [];
    for (const m of members) {
      let streak = 0;
      const d = new Date();
      d.setHours(d.getHours() - 5);
      while (true) {
        const dateStr = d.toISOString().split('T')[0];
        const { rows } = await pool.query(
          'SELECT COUNT(*) as cnt FROM checkins WHERE member_id = $1 AND date = $2',
          [m.id, dateStr]
        );
        if (parseInt(rows[0].cnt) < 2) break;
        streak++;
        d.setDate(d.getDate() - 1);
      }
      streaks.push({ id: m.id, name: m.name, avatar: m.name.charAt(0).toUpperCase(), streak });
    }
    streaks.sort((a, b) => b.streak - a.streak);
    res.json(streaks);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PROJECTS ────────────────────────────────────────
app.post('/api/projects', async (req, res) => {
  const { member_id, description } = req.body;
  if (!member_id || !description) return res.status(400).json({ error: 'member_id y description requeridos' });
  const date = today();
  try {
    await pool.query('INSERT INTO projects (member_id, description, date) VALUES ($1, $2, $3)', [member_id, description, date]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects', async (req, res) => {
  const date = today();
  try {
    const { rows } = await pool.query(`
      SELECT p.*, m.name as member_name
      FROM projects p
      JOIN members m ON m.id = p.member_id
      WHERE p.date = $1
      ORDER BY p.created_at DESC
    `, [date]);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── HISTORY ─────────────────────────────────────────
app.get('/api/history/:days', async (req, res) => {
  const days = Math.min(parseInt(req.params.days) || 7, 30);
  try {
    const { rows: members } = await pool.query('SELECT * FROM members ORDER BY name');
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setHours(d.getHours() - 5);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const history = [];
    for (const date of dates) {
      const { rows: checkins } = await pool.query('SELECT * FROM checkins WHERE date = $1', [date]);
      const entries = members.map(m => {
        const checks = checkins.filter(c => c.member_id === m.id);
        return {
          member_id: m.id,
          name: m.name,
          score: checks.length,
          gym: checks.some(c => c.pillar === 'gym'),
          trabajo: checks.some(c => c.pillar === 'trabajo'),
          espiritu: checks.some(c => c.pillar === 'espiritu'),
        };
      });
      history.push({ date, entries });
    }
    res.json({ history, members });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SERVE FRONTEND ─────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('🔥 Forja Grupo corriendo en puerto ' + PORT);
});
