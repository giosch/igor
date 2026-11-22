import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { check } from '../core.js';

export const terminal = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
export const states = ['queued', 'preparing', 'running', 'finalizing', ...terminal];
export function exclusive(file, timeout = 0) {
  const db = new DatabaseSync(file, { timeout });
  try {
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (err) {
    db.close();
    if ([5, 6].includes(err.errcode)) return null;
    throw err;
  }
}
export class Store {
  constructor(home) {
    const lock = exclusive(path.join(home, 'runtime', 'schema.lock'), 5000);
    check(lock, 'Database initialization is busy');
    try {
      this.db = new DatabaseSync(path.join(home, 'jobs.db'), { timeout: 5000 });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      check(version === 0 || version === 1, 'Unsupported jobs.db version');
      if (version === 1) return;
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL,
        spec TEXT NOT NULL, created TEXT NOT NULL, started TEXT, finished TEXT,
        cancel INTEGER NOT NULL DEFAULT 0, exitCode INTEGER, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS active_job ON jobs((1))
        WHERE status IN ('preparing','running','finalizing');
      CREATE TABLE IF NOT EXISTS transitions (seq INTEGER PRIMARY KEY, id TEXT NOT NULL
        REFERENCES jobs(id) ON DELETE CASCADE, status TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        owner TEXT, pid INTEGER, state TEXT NOT NULL, model TEXT, stop INTEGER DEFAULT 0,
        request TEXT, response TEXT);
      INSERT OR IGNORE INTO service(singleton,state) VALUES(1,'stopped');
      PRAGMA user_version=1;
    `)
      );
    } catch (err) {
      this.db?.close();
      throw err;
    } finally {
      lock.close();
    }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  submit(spec) {
    const id = 'job_' + randomUUID().replaceAll('-', ''),
      at = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO jobs(id,status,spec,created) VALUES(?,'queued',?,?)")
        .run(id, JSON.stringify(spec), at);
      this.event(id, 'queued', at);
    });
    return id;
  }
  event(id, status, at) {
    this.db.prepare('INSERT INTO transitions(id,status,at) VALUES(?,?,?)').run(id, status, at);
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    check(row, 'Unknown job: ' + id);
    return row;
  }
  list(status) {
    if (status) check(states.includes(status), 'Invalid job status: ' + status);
    return this.db
      .prepare(
        'SELECT id AS jobId,status,created,started,finished,exitCode,error FROM jobs WHERE (? IS NULL OR status=?) ORDER BY seq'
      )
      .all(status ?? null, status ?? null);
  }
  claim() {
    return this.transaction(() => {
      const active = this.active();
      if (active) return null;
      const next = this.db
        .prepare("SELECT id FROM jobs WHERE status='queued' AND cancel=0 ORDER BY seq LIMIT 1")
        .get();
      if (!next) return null;
      this.move(next.id, 'preparing');
      return this.row(next.id);
    });
  }
  active() {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('preparing','running','finalizing')").get();
  }
  move(id, next, exitCode = null, error = null) {
    const from = this.row(id).status;
    const allowed = {
      queued: ['preparing'],
      preparing: ['running'],
      running: ['finalizing'],
      finalizing: ['completed'],
    };
    check(
      allowed[from] && (allowed[from].includes(next) || terminal.slice(1).includes(next)),
      'Invalid transition ' + from + ' to ' + next
    );
    const at = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status=?,started=CASE WHEN ?='preparing' THEN ? ELSE started END,
      finished=?,exitCode=?,error=? WHERE id=?`
      )
      .run(next, next, at, terminal.includes(next) ? at : null, exitCode, error, id);
    this.event(id, next, at);
  }
  transition(...args) {
    this.transaction(() => this.move(...args));
  }
  cancel(id) {
    return this.transaction(() => {
      const row = this.row(id);
      if (['queued', 'preparing', 'running'].includes(row.status))
        this.db.prepare('UPDATE jobs SET cancel=1 WHERE id=?').run(id);
      return this.row(id);
    });
  }
  history(id) {
    return this.db.prepare('SELECT status,at FROM transitions WHERE id=? ORDER BY seq').all(id);
  }
  service() {
    return this.db.prepare('SELECT * FROM service WHERE singleton=1').get();
  }
  close() {
    this.db.close();
  }
}
