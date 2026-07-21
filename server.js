const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
const db = new Database(process.env.NODE_ENV === 'production' ? '/tmp/forja.db' : path.join(__dirname, 'forja.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    pillar TEXT NOT NULL CHECK(pillar IN ('gym','trabajo','espiritu')),
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(member_id, pillar, date),
    FOREIGN KEY(member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(member_id) REFERENCES members(id)
  );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get today's date in local time (Colombia UTC-5)
function today() {
  const d = new Date();
  d.setHours(d.getHours() - 5); // Adjust to Colombia time
  return d.toISOString().split('T')[0];
}

// ─── REGISTER / LOGIN ───────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Nombre requerido' });
  const clean = name.trim().toLowerCase();
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO members (name) VALUES (?)');
    stmt.run(clean);
    const member = db.prepare('SELECT * FROM members WHERE name = ?').get(clean);
    res.json({ id: member.id, name: member.name });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const member = db.prepare('SELECT * FROM members WHERE name = ?').get(name.trim().toLowerCase());
  if (!member) return res.status(404).json({ error: 'No registrado. Usa Registrarse primero.' });
  res.json({ id: member.id, name: member.name });
});

// ─── CHECK-INS ──────────────────────────────────────────────────────
app.post('/api/checkin', (req, res) => {
  const { member_id, pillar } = req.body;
  if (!member_id || !pillar) return res.status(400).json({ error: 'member_id y pillar requeridos' });
  if (!['gym','trabajo','espiritu'].includes(pillar)) return res.status(400).json({ error: 'Pillar inválido' });

  const date = today();
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO checkins (member_id, pillar, date) VALUES (?, ?, ?)');
    const result = stmt.run(member_id, pillar, date);
    const isNew = result.changes > 0;
    res.json({ ok: true, isNew, pillar, date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/checkin', (req, res) => {
  const { member_id, pillar } = req.body;
  if (!member_id || !pillar) return res.status(400).json({ error: 'member_id y pillar requeridos' });

  const date = today();
  db.prepare('DELETE FROM checkins WHERE member_id = ? AND pillar = ? AND date = ?')
    .run(member_id, pillar, date);
  res.json({ ok: true });
});

// ─── BOARD (today's status) ─────────────────────────────────────────
app.get('/api/board', (req, res) => {
  const date = today();
  const members = db.prepare('SELECT * FROM members ORDER BY name').all();
  const todayCheckins = db.prepare('SELECT * FROM checkins WHERE date = ?').all(date);

  const board = members.map(m => {
    const checks = todayCheckins.filter(c => c.member_id === m.id);
    const score = checks.length;
    return {
      id: m.id,
      name: m.name,
      avatar: m.name.charAt(0).toUpperCase(),
      gym: checks.some(c => c.pillar === 'gym'),
      trabajo: checks.some(c => c.pillar === 'trabajo'),
      espiritu: checks.some(c => c.pillar === 'espiritu'),
      score,
    };
  });

  // Sort by score desc, then by name
  board.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // Stats
  const stats = {
    gym: board.filter(m => m.gym).length,
    trabajo: board.filter(m => m.trabajo).length,
    espiritu: board.filter(m => m.espiritu).length,
    total: members.length,
  };

  res.json({ board, stats, date, members: members.length });
});

// ─── STREAKS ────────────────────────────────────────────────────────
app.get('/api/streaks', (req, res) => {
  const members = db.prepare('SELECT * FROM members ORDER BY name').all();
  const streaks = members.map(m => {
    let streak = 0;
    const d = new Date();
    d.setHours(d.getHours() - 5); // Colombia time

    while (true) {
      const dateStr = d.toISOString().split('T')[0];
      const count = db.prepare(
        'SELECT COUNT(*) as cnt FROM checkins WHERE member_id = ? AND date = ?'
      ).get(m.id, dateStr);
      if (count.cnt < 2) break; // need at least 2/3 to count as streak day
      streak++;
      d.setDate(d.getDate() - 1);
    }

    return {
      id: m.id,
      name: m.name,
      avatar: m.name.charAt(0).toUpperCase(),
      streak,
    };
  });

  streaks.sort((a, b) => b.streak - a.streak);
  res.json(streaks);
});

// ─── PROJECTS ───────────────────────────────────────────────────────
app.post('/api/projects', (req, res) => {
  const { member_id, description } = req.body;
  if (!member_id || !description) return res.status(400).json({ error: 'member_id y description requeridos' });

  const date = today();
  db.prepare('INSERT INTO projects (member_id, description, date) VALUES (?, ?, ?)')
    .run(member_id, description, date);
  res.json({ ok: true });
});

app.get('/api/projects', (req, res) => {
  const date = today();
  const projects = db.prepare(`
    SELECT p.*, m.name as member_name
    FROM projects p
    JOIN members m ON m.id = p.member_id
    WHERE p.date = ?
    ORDER BY p.created_at DESC
  `).all(date);
  res.json(projects);
});

// ─── HISTORY (for weekly view) ──────────────────────────────────────
app.get('/api/history/:days', (req, res) => {
  const days = Math.min(parseInt(req.params.days) || 7, 30);
  const members = db.prepare('SELECT * FROM members ORDER BY name').all();

  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(d.getHours() - 5);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const history = dates.map(date => {
    const checkins = db.prepare('SELECT * FROM checkins WHERE date = ?').all(date);
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
    return { date, entries };
  });

  res.json({ history, members });
});

// ─── SERVE FRONTEND (SPA fallback) ─────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🔥 Forja Grupo corriendo en puerto ${PORT}`);
});
