/**
 * Persistent memory on SQLite (Node's built-in node:sqlite, zero native deps).
 * Stores: show state (kv), viewers (returning-viewer recognition),
 * recently used lines (anti-repetition), game rounds log, event log.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface Viewer {
  user_id: string;
  login: string;
  first_seen: number;
  last_seen: number;
  messages: number;
  last_greeted: number;
  notes: string;
}

export class Memory {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS viewers (
        user_id TEXT PRIMARY KEY, login TEXT NOT NULL, first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, messages INTEGER NOT NULL DEFAULT 0,
        last_greeted INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lines (hash TEXT PRIMARY KEY, text TEXT NOT NULL, used_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (
        id TEXT PRIMARY KEY, game TEXT, outcome TEXT, multiplier REAL, payout REAL, stake REAL,
        simulated INTEGER, at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, data TEXT);
    `);
  }

  get<T>(k: string, fallback: T): T {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.v) as T; } catch { return fallback; }
  }

  set(k: string, v: unknown) {
    this.db.prepare('INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated')
      .run(k, JSON.stringify(v), Date.now());
  }

  /** Records a chat message; returns viewer row + whether returning after a gap. */
  touchViewer(userId: string, login: string, now = Date.now()): { viewer: Viewer; isNew: boolean; isReturning: boolean } {
    const existing = this.db.prepare('SELECT * FROM viewers WHERE user_id = ?').get(userId) as Viewer | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO viewers (user_id, login, first_seen, last_seen, messages) VALUES (?, ?, ?, ?, 1)')
        .run(userId, login, now, now);
      return { viewer: { user_id: userId, login, first_seen: now, last_seen: now, messages: 1, last_greeted: 0, notes: '' }, isNew: true, isReturning: false };
    }
    const isReturning = now - existing.last_seen > 30 * 60_000; // gone > 30 min
    this.db.prepare('UPDATE viewers SET login = ?, last_seen = ?, messages = messages + 1 WHERE user_id = ?').run(login, now, userId);
    return { viewer: { ...existing, login, last_seen: now, messages: existing.messages + 1 }, isNew: false, isReturning };
  }

  markGreeted(userId: string, now = Date.now()) {
    this.db.prepare('UPDATE viewers SET last_greeted = ? WHERE user_id = ?').run(now, userId);
  }

  addViewerNote(userId: string, note: string) {
    const v = this.db.prepare('SELECT notes FROM viewers WHERE user_id = ?').get(userId) as { notes: string } | undefined;
    if (!v) return;
    const notes = (v.notes ? v.notes + ' | ' : '') + note.slice(0, 80);
    this.db.prepare('UPDATE viewers SET notes = ? WHERE user_id = ?').run(notes.slice(-400), userId);
  }

  /** Anti-repetition: has a (normalized) line been used in the window? */
  wasUsedRecently(text: string, windowMs = 6 * 3600_000): boolean {
    const row = this.db.prepare('SELECT used_at FROM lines WHERE hash = ?').get(lineHash(text)) as { used_at: number } | undefined;
    return !!row && Date.now() - row.used_at < windowMs;
  }

  markUsed(text: string) {
    this.db.prepare('INSERT INTO lines (hash, text, used_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET used_at=excluded.used_at')
      .run(lineHash(text), text.slice(0, 300), Date.now());
  }

  recentLines(n = 12): string[] {
    return (this.db.prepare('SELECT text FROM lines ORDER BY used_at DESC LIMIT ?').all(n) as Array<{ text: string }>).map((r) => r.text);
  }

  logRound(r: { id: string; game: string; outcome: string; multiplier?: number; payout?: number; stake?: number; simulated: boolean }) {
    this.db.prepare('INSERT OR IGNORE INTO rounds (id, game, outcome, multiplier, payout, stake, simulated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.game, r.outcome, r.multiplier ?? null, r.payout ?? null, r.stake ?? null, r.simulated ? 1 : 0, Date.now());
  }

  hasRound(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(id);
  }

  logEvent(kind: string, data: unknown) {
    this.db.prepare('INSERT INTO events (at, kind, data) VALUES (?, ?, ?)').run(Date.now(), kind, JSON.stringify(data).slice(0, 2000));
    // keep table bounded
    if (Math.random() < 0.01) this.db.exec('DELETE FROM events WHERE id < (SELECT MAX(id) - 20000 FROM events)');
  }

  close() { this.db.close(); }
}

export function lineHash(text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) { h ^= norm.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + norm.length;
}
