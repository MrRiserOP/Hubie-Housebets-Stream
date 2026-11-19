/** Loads/saves the simulated Limbo settings: defaults in config/limbo-sim.json, your changes in data/limbo-settings.json. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from '../../shared/src/node.ts';
import { validateSettings, type LimboSettings } from './limboEngine.ts';

export const DEFAULTS_FILE = path.join(ROOT, 'config', 'limbo-sim.json');
export const OVERRIDES_FILE = path.join(DATA_DIR, 'limbo-settings.json');
export const STATE_FILE = path.join(DATA_DIR, 'limbo-state.json');

export function loadLimboSettings(): LimboSettings {
  const base = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  delete base._readme;
  let over: Partial<LimboSettings> = {};
  try { over = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch { /* none yet */ }
  const merged = { ...base, ...over } as LimboSettings;
  return validateSettings(merged).length ? base : merged; // a broken override never stops the show
}

export function saveLimboSettings(patch: Partial<LimboSettings>): { ok: boolean; errors: string[]; settings: LimboSettings } {
  const cur = loadLimboSettings();
  const next = { ...cur, ...patch } as LimboSettings;
  const errors = validateSettings(next);
  if (errors.length) return { ok: false, errors, settings: cur };
  fs.mkdirSync(path.dirname(OVERRIDES_FILE), { recursive: true });
  const { label, roundDelaySec, betAmount, targetMode, fixedTarget, outcomes, startingCredits, resultCap, currency } = next;
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ label, roundDelaySec, betAmount, targetMode, fixedTarget, outcomes, startingCredits, resultCap, currency }, null, 2));
  return { ok: true, errors: [], settings: next };
}

export function resetLimboSettings() { fs.rmSync(OVERRIDES_FILE, { force: true }); return loadLimboSettings(); }
