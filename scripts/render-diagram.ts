/** Renders the mermaid diagram in docs/ARCHITECTURE.md to docs/architecture.png (offline). */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../packages/shared/src/node.ts';
const md = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
const src = md.match(/```mermaid\n([\s\S]*?)```/)![1];
const lib = fs.readFileSync(path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 1.5 });
await page.setContent(`<html><body style="margin:0;background:#fff"><pre class="mermaid">${src.replace(/</g, '&lt;')}</pre></body></html>`);
await page.addScriptTag({ content: lib });
await page.evaluate(async () => { (window as any).mermaid.initialize({ startOnLoad: false, theme: 'default', flowchart: { htmlLabels: true } }); await (window as any).mermaid.run(); });
const el = page.locator('svg').first();
await el.screenshot({ path: path.join(ROOT, 'docs/architecture.png') });
await browser.close();
console.log('wrote docs/architecture.png');
