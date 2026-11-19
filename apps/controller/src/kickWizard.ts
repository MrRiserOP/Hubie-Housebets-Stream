/**
 * "Connect Kick Chat" wizard state + the rule for when Kick may be called CONNECTED.
 *
 * Connected means MEASURED, never assumed:
 *   - send:    Kick accepted a message that Hubie posted (HTTP 200, is_sent) — recorded when it happens.
 *   - receive: Kick delivered a real, signature-checked chat webhook to the CURRENT public address.
 *   - reply:   Hubie posted an answer to a viewer message after receiving it.
 * A saved account, an enabled toggle or a running tunnel alone are never "Connected".
 */
import fs from 'node:fs';
import path from 'node:path';
import { KICK_REQUIRED_SCOPES, SCOPE_LABEL } from '../../../packages/shared/src/kick.ts';
import type { HubMessage } from '../../../packages/shared/src/protocol.ts';
import type { TunnelStatus } from './tunnel.ts';

type Activity = Omit<Extract<HubMessage, { type: 'kick_activity' }>, 'type'>;
export interface Verified { sendAt?: number; receiveAt?: number; receiveFrom?: string; receiveUser?: string; replyAt?: number; address?: string }

export class KickVerifier {
  v: Verified = {};
  private file: string;
  private seenIn?: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'kick-verified.json');
    try { this.v = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* none yet */ }
  }
  private save() { try { fs.writeFileSync(this.file, JSON.stringify(this.v), { mode: 0o600 }); } catch { /* ignore */ } }
  /** Called for every activity report from the Kick agent; `address` is the public webhook address in use right now. */
  observe(a: Activity, address: string) {
    let changed = false;
    const o = a.lastOut;
    if (o?.ok && o.test && o.at !== this.v.sendAt) { this.v.sendAt = o.at; changed = true; }
    if (a.lastIn?.id && a.lastIn.id !== this.seenIn) {
      this.seenIn = a.lastIn.id;
      this.v.receiveAt = a.lastIn.at; this.v.receiveUser = a.lastIn.user; this.v.address = address; this.v.replyAt = undefined; changed = true;
    }
    if (o?.ok && !o.test && this.v.receiveAt && o.at >= this.v.receiveAt && o.at !== this.v.replyAt) { this.v.replyAt = o.at; changed = true; }
    if (changed) this.save();
  }
  /** Receive proof only counts for the address it arrived on. */
  receiveOk(address: string) { return !!this.v.receiveAt && (!address || this.v.address === address); }
  reset() { this.v = {}; this.seenIn = undefined; this.save(); }
}

export type StepState = 'done' | 'todo' | 'working' | 'error';
export interface WizardStep { id: string; title: string; state: StepState; detail: string; fix?: string }
export interface WizardInput {
  env: NodeJS.ProcessEnv;
  accounts: { broadcaster: { username: string; scopes: string[] } | null; bot: { username: string; scopes: string[] } | null };
  activity: Activity; agentOnline: boolean; tunnel: TunnelStatus; verified: Verified; address: string; now: number;
  testStartedAt?: number;
}
const ago = (t?: number, now = Date.now()) => (t ? `${Math.max(0, Math.round((now - t) / 1000))} s ago` : '');

export function buildWizard(i: WizardInput) {
  const { env: e, activity: a, tunnel: t, verified: v, now } = i;
  const steps: WizardStep[] = [];
  const hasCreds = !!(e.KICK_CLIENT_ID && e.KICK_CLIENT_SECRET && e.KICK_CHANNEL);
  const on = e.KICK_ENABLED === 'true';
  steps.push({ id: 'app', title: 'Kick app details',
    state: hasCreds && on ? 'done' : 'todo',
    detail: hasCreds ? (on ? `Channel “${e.KICK_CHANNEL}”, Client ID and Secret saved, Kick turned on.` : 'Saved — Kick is still turned off.') : `Missing: ${[!e.KICK_CHANNEL && 'channel name', !e.KICK_CLIENT_ID && 'Client ID', !e.KICK_CLIENT_SECRET && 'Client Secret'].filter(Boolean).join(', ')}.`,
    fix: hasCreds ? undefined : 'Create the app at kick.com/settings/developer and enter the three values.' });

  const acc = i.accounts.broadcaster ?? i.accounts.bot;
  const granted = new Set([...(i.accounts.broadcaster?.scopes ?? [])]);
  const chatGranted = new Set([...(i.accounts.bot?.scopes ?? []), ...granted]);
  const missing = acc ? KICK_REQUIRED_SCOPES.filter((s) => !(s === 'events:subscribe' ? granted.has(s) : chatGranted.has(s))) : [];
  const perms = acc ? `Permissions granted: ${[...(i.accounts.broadcaster?.scopes ?? [])].map((s) => SCOPE_LABEL[s] ?? s).join(', ') || 'none'}.` : '';
  steps.push({ id: 'account', title: 'Kick login and permissions',
    state: a.authError ? 'error' : !acc ? 'todo' : missing.length ? 'error' : 'done',
    detail: a.authError ?? (!acc ? 'Not signed in yet.' : missing.length ? `Signed in as ${acc.username}, but Kick did not grant: ${missing.map((s) => SCOPE_LABEL[s] ?? s).join(', ')}.` : `Signed in as ${acc.username}. ${perms}`),
    fix: a.authError || missing.length ? 'Press Reconnect and leave every permission ticked on Kick’s page.' : !acc ? 'Press “Connect Kick account”.' : undefined });

  const manual = !!e.KICK_WEBHOOK_URL && e.KICK_TUNNEL !== 'cloudflared';
  steps.push({ id: 'tunnel', title: 'Public address for Kick',
    state: manual ? 'done' : t.state === 'running' && t.reachable ? 'done' : t.state === 'error' ? 'error' : t.state === 'off' ? 'todo' : 'working',
    detail: manual ? 'Using the fixed address you saved (not measured from here).'
      : t.state === 'running' ? (t.reachable ? 'Cloudflare tunnel is up and answers from the internet.' : t.reachable === false ? `Tunnel started but is not answering: ${t.reachableError}` : 'Tunnel started — checking that it answers (can take up to 2 minutes)…')
      : t.detail,
    fix: t.state === 'off' && !manual ? 'Press “Start public address” (installs Cloudflare’s free cloudflared if needed).' : undefined });
  if (steps[2].state === 'working' && t.reachable === false) steps[2].state = 'error';

  const changed = !!t.changedFrom && !i.verified.address?.includes(t.url ?? '~');
  steps.push({ id: 'webhook', title: 'Paste the address into your Kick app',
    state: i.address && i.verified.receiveAt && v.address === i.address ? 'done' : 'todo',
    detail: !i.address ? 'Waiting for the public address.' : v.address === i.address && v.receiveAt ? `Confirmed — Kick delivered a chat message to this address ${ago(v.receiveAt, now)}.` : changed ? 'The address CHANGED because the tunnel restarted — paste the new one into your Kick app again.' : 'Not confirmed yet. Paste it into kick.com/settings/developer → your app → Webhooks (enable them), Save. This step turns green when Kick really delivers a message (step 7).',
    fix: undefined });

  const subs = a.subscriptions ?? [];
  steps.push({ id: 'subs', title: 'Chat event subscription',
    state: subs.includes('chat.message.sent') ? 'done' : a.subError ? 'error' : !i.agentOnline || !hasCreds ? 'todo' : 'working',
    detail: subs.includes('chat.message.sent') ? `Kick lists the chat subscription for ${e.KICK_CHANNEL} (checked ${ago(a.subCheckedAt, now)}).` : a.subError ?? 'Waiting for the Kick agent to subscribe.',
    fix: a.subError ? 'Check that webhooks are enabled in your Kick app, then press “Re-check subscription”.' : undefined });

  const sendOk = !!v.sendAt && !(a.lastOut && !a.lastOut.ok && a.lastOut.at > v.sendAt);
  steps.push({ id: 'send', title: 'Hubie can post in your chat',
    state: sendOk ? 'done' : a.lastOut && !a.lastOut.ok ? 'error' : 'todo',
    detail: sendOk ? `Test message delivered ${ago(v.sendAt, now)}.` : a.lastOut && !a.lastOut.ok ? `Kick refused the message: ${a.lastOut.error}` : 'Not tested yet.',
    fix: a.lastOut && !a.lastOut.ok ? 'Reconnect your Kick account (permission “send chat messages”) and test again.' : 'Press “Test Kick Chat”.' });

  const recvOk = i.address ? !!v.receiveAt && v.address === i.address : !!v.receiveAt;
  const replied = recvOk && !!v.replyAt;
  const waiting = !!i.testStartedAt && now - i.testStartedAt < 180_000 && !recvOk;
  steps.push({ id: 'receive', title: 'Hubie hears you and answers',
    state: replied ? 'done' : recvOk ? 'working' : waiting ? 'working' : 'todo',
    detail: replied ? `Heard “${a.lastIn?.text ?? v.receiveUser}” from ${v.receiveUser} and replied ${ago(v.replyAt, now)}.` : recvOk ? `Heard ${v.receiveUser} ${ago(v.receiveAt, now)} — waiting for Hubie’s reply…` : waiting ? 'Waiting — type  hi Hubie  in your Kick chat now.' : 'Type  hi Hubie  in your Kick chat after pressing “Test Kick Chat”.',
    fix: a.webhook && a.webhook.rejected > 0 && !recvOk ? `Kick requests were rejected (${a.webhook.lastError}).` : undefined });

  const connected = steps.every((s) => s.id === 'webhook' ? true : s.state === 'done') && recvOk && sendOk && replied && subs.includes('chat.message.sent') && !a.authError;
  const first = steps.find((s) => s.state === 'error') ?? steps.find((s) => s.state !== 'done');
  return {
    connected, steps,
    next: connected ? 'Everything tested — Kick chat works.' : first ? `${first.title}: ${first.fix ?? first.detail}` : '',
    panel: {
      account: acc ? acc.username : null, channel: e.KICK_CHANNEL ?? '',
      oauth: a.authError ? 'expired' : acc ? (missing.length ? 'missing permissions' : 'ok') : 'not connected',
      receiving: recvOk ? 'confirmed' : a.webhook?.received ? 'events arriving' : 'not confirmed',
      sending: sendOk ? 'confirmed' : a.lastOut && !a.lastOut.ok ? 'failing' : 'not tested',
      webhook: t.webhookUrl ?? e.KICK_WEBHOOK_URL ?? '',
      webhookState: manual ? 'fixed address' : t.state, tunnelChanged: changed,
      lastReceived: a.lastIn ? { user: a.lastIn.user, text: a.lastIn.text, at: a.lastIn.at } : null,
      lastSent: a.lastOut ? { text: a.lastOut.text, at: a.lastOut.at, ok: a.lastOut.ok, error: a.lastOut.error } : null,
      errors: [a.authError, a.subError, t.state === 'error' ? t.detail : '', a.lastOut && !a.lastOut.ok ? `Send failed: ${a.lastOut.error}` : '', a.webhook?.rejected ? `${a.webhook.rejected} Kick request(s) rejected: ${a.webhook.lastError}` : ''].filter(Boolean) as string[],
    },
  };
}
