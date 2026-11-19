/**
 * Renders Hubie through the real AnimationDirector: every expression and every
 * combo (at a representative moment) next to the reference image.
 * Usage: npm run render:rig  → docs/rig-sheet.png + docs/combo-sheet.png
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { HubieSvg } from '../apps/avatar/src/rig/HubieSvg.tsx';
import { Animator } from '../apps/avatar/src/rig/animator.ts';
import { COMBO_DEFS } from '../apps/avatar/src/rig/combos.ts';
import { EXPRESSIONS, type Combo, type Expression } from '../packages/shared/src/protocol.ts';
import { ROOT } from '../packages/shared/src/node.ts';

const ref = fs.readFileSync(path.join(ROOT, 'assets/hubie/hubie-reference.png')).toString('base64');

function frame(setup: (a: Animator) => void, seconds: number, speak = 0): string {
  const a = new Animator();
  (a as any).nextBlink = 1e9; (a as any).nextIdle = 1e9; // deterministic: no blinks/idle actions
  setup(a);
  for (let t = 0; t < seconds; t += 1 / 60) {
    if (speak) { a.speaking = true; a.mouth = { open: speak, wide: 0.3, round: 0 }; }
    a.tick(1 / 60);
  }
  return renderToStaticMarkup(<HubieSvg p={a.output} t={a.time} width={280} height={280} showBg />);
}

function sheet(cells: Array<{ label: string; svg: string }>, file: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#111;font:14px sans-serif;color:#eee">
<style>.g{display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:1480px}.c{text-align:center}.s{width:280px;height:280px;overflow:hidden;border-radius:8px}</style>
<div class="g"><div class="c"><img src="data:image/png;base64,${ref}" width=280 height=280 style="border-radius:8px"><br><b>reference</b></div>
${cells.map((c) => `<div class="c"><div class="s">${c.svg}</div><b>${c.label}</b></div>`).join('')}</div></body></html>`;
  return { html, file };
}

const exprCells = EXPRESSIONS.map((e: Expression) => ({ label: e, svg: frame((a) => a.setExpression(e), 1.6, e === 'speaking' ? 0.6 : 0) }));
const comboAt: Partial<Record<Combo, number>> = { big_win: 1.2, bad_result: 1.2, celebration: 1.0, welcome_wave: 0.9, chat_interaction: 1.1, facepalm: 1.0, shrug: 0.9, sleepy: 1.5, surprise: 0.6 };
const comboCells = (Object.keys(COMBO_DEFS) as Combo[]).map((c) => ({ label: c, svg: frame((a) => a.playCombo(c), comboAt[c] ?? 0.8) }));

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
for (const { html, file } of [sheet(exprCells, 'docs/rig-sheet.png'), sheet(comboCells, 'docs/combo-sheet.png')]) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.setContent(html);
  await page.screenshot({ path: path.join(ROOT, file), fullPage: true });
  console.log('wrote', file);
}
await browser.close();
