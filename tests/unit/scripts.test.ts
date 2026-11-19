/**
 * Launcher / deployment scripts.
 * Windows: there is no Windows machine in the build environment, so START-HUBIE.bat is
 * checked STATICALLY (line endings, required steps, friendly errors). The Linux scripts
 * are syntax-checked here; install-vps.sh was also executed for real on Ubuntu 24.04
 * (container) — see docs/TEST-RESULTS.md.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../../packages/shared/src/node.ts';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('START-HUBIE.bat (static checks)', () => {
  const bat = read('START-HUBIE.bat');
  it('uses CRLF line endings (required by cmd.exe)', () => {
    expect(bat.split('\n').length).toBeGreaterThan(20);
    expect(bat.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
  });
  it('checks Node.js presence and version, with a clear message and download page', () => {
    expect(bat).toMatch(/where node/);
    expect(bat).toMatch(/process\.versions\.node/);
    expect(bat).toMatch(/nodejs\.org/);
    expect(bat).toMatch(/Node\.js is not installed/);
  });
  it('installs dependencies, reports failures, starts Hubie and opens the setup page', () => {
    expect(bat).toMatch(/npm install/);
    expect(bat).toMatch(/Installing components failed/);
    expect(bat).toMatch(/npm start/);
    expect(bat).toMatch(/127\.0\.0\.1:8787\/setup/);
  });
  it('never fails silently: every error path pauses so the message stays on screen', () => {
    const errorBlocks = bat.split(/\r?\n/).filter((l) => /exit \/b 1/.test(l)).length;
    const pauses = bat.split(/\r?\n/).filter((l) => /^\s*pause\s*$/.test(l)).length;
    expect(pauses).toBeGreaterThanOrEqual(errorBlocks);
  });
  it('contains only ASCII (cmd.exe code pages mangle UTF-8)', () => {
    expect(/^[\x00-\x7F]*$/.test(bat)).toBe(true);
  });
});

describe('Linux / VPS scripts', () => {
  for (const f of ['start-hubie.sh', 'scripts/install-vps.sh', 'scripts/hubie', 'scripts/vps/run-obs.sh']) {
    it(`${f} is valid bash and executable`, () => {
      execFileSync('bash', ['-n', path.join(ROOT, f)]);
      expect(fs.statSync(path.join(ROOT, f)).mode & 0o111).toBeTruthy();
    });
  }
  it('VPS installer opens SSH before enabling the firewall and protects the .env', () => {
    const s = read('scripts/install-vps.sh');
    expect(s.indexOf('ufw allow 22/tcp')).toBeGreaterThan(0);
    expect(s.indexOf('ufw allow 22/tcp')).toBeLessThan(s.indexOf('ufw --force enable'));
    expect(s).toMatch(/chmod 600 "\$ENVF"/);
    expect(s).toMatch(/read -rs KEY/); // hidden key prompt
    expect(s).toMatch(/CONTROL_TOKEN/);
  });
});
