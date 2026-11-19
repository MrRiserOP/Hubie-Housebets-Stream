/**
 * Long continuous run: full stack + overlay in OpenAI mode (local fake), N minutes.
 * Reports repetition (exact + near-duplicate + fillers + openers), memory growth, errors.
 *   npm run test:soak -- 25
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { ROOT } from '../../packages/shared/src/node.ts';
import { startFakeOpenAI } from '../fakes/fakeOpenAI.ts';
import { startFakeElevenLabs } from '../fakes/fakeElevenLabs.ts';
import { mentionsHat } from '../../services/ai/src/personality.ts';
import { similarity, isBareFiller, opener } from '../../services/ai/src/variety.ts';
import { BASE, TMP, baseEnv, health, logTail, startProc, stopAll, waitFor, control } from './harness.ts';

const minutes = Number(process.argv[2] ?? 10);
// --anthropic: the REAL Claude brain (key from .env) + stand-in ElevenLabs voice
const useClaude = process.argv.includes('--anthropic');
const claudeKey = useClaude ? (dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'))).ANTHROPIC_API_KEY ?? '') : '';
if (useClaude && !claudeKey) { console.log('NOT TESTED: no ANTHROPIC_API_KEY in .env'); process.exit(2); }
const fake = await startFakeOpenAI();
const el = await startFakeElevenLabs();
const env = baseEnv({ OPENAI_API_KEY: 'sk-test-soak-0123456789abcdefghijklm', OPENAI_BASE_URL: fake.url, ELEVENLABS_API_KEY: 'sk_test_soak_0123456789abcdefg', ELEVENLABS_BASE_URL: el.url, ELEVENLABS_VOICE_ID: 'IKne3meq5aSn9XLyUdCD', TTS_PROVIDER: 'elevenlabs', ROUND_INTERVAL_SEC: '7', ...(useClaude ? { ANTHROPIC_API_KEY: claudeKey } : {}) });
startProc('controller', 'apps/controller/src/main.ts', env);
await waitFor('controller', () => health().then((h) => h.ok), 20_000);
startProc('game-agent', 'apps/game-agent/src/main.ts', env);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`${BASE}/overlay`);
await page.waitForTimeout(5000);
const heap = () => page.evaluate('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1') as Promise<number>;
const h0 = await health(); const heap0 = await heap();
const samples: Array<{ t: number; rss: number; heap: number }> = [];
const t0 = Date.now();
// a few clearly-labelled local test chat messages spread over the run (never fake viewers on a real stream)
const chats = ['hi hubie!', 'what game is this?', "I'm from Canada", 'tell me a joke', 'do you like your hat?', 'how are you?'];
let ci = 0;
while (Date.now() - t0 < minutes * 60_000) {
  await new Promise((r) => setTimeout(r, 30_000));
  const h = await health();
  samples.push({ t: Math.round((Date.now() - t0) / 60000), rss: h.memory.rssMB, heap: await heap() });
  if (ci < chats.length && Math.random() < 0.35) await control('test_chat', { user: `soak_tester_${ci}`, text: chats[ci++] });
}
const h = await health();
const spoken: string[] = await page.evaluate('window.__hubie.spoken');
const combos: string[] = await page.evaluate('window.__hubie.combos');
const captions: string[] = await page.evaluate('window.__hubie.captions');
const exprs: string[] = await page.evaluate('window.__hubie.expressions');
const unique = new Set(spoken).size;
let near = 0, openerRepeats = 0;
for (let i = 1; i < spoken.length; i++) {
  const win = spoken.slice(Math.max(0, i - 40), i);
  if (win.some((p) => similarity(spoken[i], p) >= 0.55)) near++;
  if (spoken.slice(Math.max(0, i - 6), i).some((p) => opener(p) === opener(spoken[i]) && opener(spoken[i]).split(' ').length >= 2)) openerRepeats++;
}
const fillers = spoken.filter(isBareFiller).length;
const hatLines = spoken.filter(mentionsHat).length;
const ctlLog = logTail('controller', 1_000_000);
const ctlErrors = ctlLog.split('\n').filter((l) => / ERROR /.test(l));
const agentErrors = logTail('game-agent', 1_000_000).split('\n').filter((l) => / ERROR /.test(l));
const segs = [...new Set(ctlLog.split('\n').filter((l) => l.includes('segment →')).map((l) => l.split('segment → ')[1]))];
const reqs = fake.requests;
const md = `## Soak test (${minutes} min, ${useClaude ? `REAL Anthropic brain (${h.llm.brain}) + stand-in ElevenLabs voice` : 'stand-in text brain + stand-in ElevenLabs voice'})\n\nRun at ${new Date().toISOString()}\n\n| Metric | Value |\n|---|---|\n` +
  `| Rounds played | ${h.stats.rounds} (W ${h.stats.wins} / L ${h.stats.losses}) |\n` +
  `| Lines spoken | ${spoken.length} — exact-unique ${unique} (${Math.round((unique / Math.max(1, spoken.length)) * 100)}%) |\n` +
  `| Near-duplicates (similarity ≥ 0.55 to any of previous 40) | ${near} (${Math.round((near / Math.max(1, spoken.length)) * 100)}%) |\n` +
  `| Lines mentioning the hat | ${hatLines} of ${spoken.length} (viewer hat mentions in test chat: ${chats.slice(0, ci).filter(mentionsHat).length}) |\n` +
  `| Bare filler lines ("Nope." etc.) | ${fillers} |\n| Reused openers within 6 lines | ${openerRepeats} |\n` +
  `| Variety guard: regenerated / dropped | ${h.speech.regenerated} / ${h.speech.dropped} |\n` +
  `| Captions shown | ${captions.length} (${new Set(captions).size} distinct) |\n| Combos played | ${combos.length} (${new Set(combos).size} distinct) |\n| Expressions used | ${new Set(exprs).size} distinct |\n` +
  `| Text-brain calls / ElevenLabs speech calls / OpenAI audio calls | ${reqs.filter((r) => r.path === '/v1/responses').length} / ${el.ttsRequests().length} / ${reqs.filter((r) => r.path.includes('/audio/')).length} (cached audio reused: ${h.speech.cachedAudio}) |\n` +
  `| Lines by provider | ${JSON.stringify(Object.fromEntries(Object.entries(h.llm.usage ?? {}).map(([k, v]: any) => [k, `${v.calls} calls, ${v.failures} errors, ${v.inputTokens}/${v.outputTokens} tok, avg ${v.avgMs} ms`])))} |\n` +
  `| Speech ack timeouts | ${h.speech.ackTimeouts} |\n| Segments visited | ${segs.join(', ')} |\n` +
  `| Controller RSS start → end | ${h0.memory.rssMB} MB → ${h.memory.rssMB} MB |\n| Overlay JS heap start → end | ${heap0} MB → ${await heap()} MB |\n` +
  `| Controller / game-agent ERROR lines | ${ctlErrors.length} / ${agentErrors.length} |\n| Overlay page JS errors | ${pageErrors.length} |\n` +
  `| Component states at end | ${h.components.map((c: any) => `${c.name}:${c.state}`).join(', ')} |\n\n` +
  `Memory samples (minute: controller RSS MB / overlay heap MB): ${samples.map((s) => `${s.t}: ${s.rss}/${s.heap}`).join(' · ')}\n\nLast 15 lines:\n${spoken.slice(-15).map((s) => `- ${s}`).join('\n')}\n`;
fs.writeFileSync(path.join(ROOT, 'docs', useClaude ? 'TEST-REPORT-soak-anthropic.md' : 'TEST-REPORT-soak.md'), md);
console.log(md);
console.log(`logs in ${TMP}`);
await browser.close(); stopAll(); await fake.close(); await el.close();
setTimeout(() => process.exit(0), 1500);
