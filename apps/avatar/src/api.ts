/** Small fetch helper for the setup wizard / control panel. Sends CONTROL_TOKEN if the page URL had one. */
const q = new URLSearchParams(location.search);
const urlToken = q.get('token');
if (urlToken) { try { sessionStorage.setItem('hubieToken', urlToken); } catch { /* ignore */ } }
export function token(): string { try { return urlToken ?? sessionStorage.getItem('hubieToken') ?? ''; } catch { return urlToken ?? ''; } }
export function withToken(path: string) { const t = token(); return t ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : path; }

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token() ? { 'x-control-token': token() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('This page needs the access link with ?token=… (shown when Hubie was installed).');
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json();
}
