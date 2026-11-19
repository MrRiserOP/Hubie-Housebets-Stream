import type { Page } from 'playwright';
import type { RoundResult } from '../../shared/src/protocol.ts';

export interface AdapterContext {
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  executablePath?: string;
  headless: boolean;
  baseUrl: string; // controller base URL (serves the local demo game)
}

export interface GameAdapter {
  /** adapter id, e.g. "housebets-limbo" */
  readonly name: string;
  /** human-readable game name shown on stream */
  readonly game: string;
  /** true for anything that is NOT the real Housebets game (simulated or local test game) */
  readonly simulated: boolean;
  start(ctx: AdapterContext): Promise<void>;
  /** Start one round with permitted demo controls and resolve with the observed outcome. */
  playRound(): Promise<RoundResult & { bonus?: boolean }>;
  /** Cheap liveness probe. */
  healthy(): Promise<boolean>;
  stop(): Promise<void>;
  /** Present for browser-based adapters (used for screencast frames). */
  page?: Page;
  /** For non-browser adapters: an SVG/PNG frame describing current state. */
  renderFrame?(): { mime: string; data: string } | null;
}

export class LoginWallError extends Error {
  constructor(msg = 'Demo requires login — not permitted by policy') { super(msg); this.name = 'LoginWallError'; }
}
