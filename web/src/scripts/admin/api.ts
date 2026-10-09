// Same-origin admin API client. Credentials ride on the Cloudflare Access cookie; no tokens in JS.
export class SessionError extends Error {
  constructor() { super('session'); }
}
export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export const MOCK = import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1';

type Handler = (path: string, init: RequestInit) => unknown;
let mockHandler: Handler | undefined;
async function mock(): Promise<Handler> {
  if (!import.meta.env.DEV) throw new Error('mock disabled');
  return (mockHandler ??= (await import('./mock')).handle);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 120));
    return (await mock())(path, init) as T;
  }
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if ((init.method ?? 'GET') !== 'GET') headers.set('X-Requested-With', 'albena-admin');
  let res: Response;
  try {
    // redirect:manual => an Access login redirect shows up as opaqueredirect instead of a CORS failure.
    res = await fetch(path, { ...init, headers, credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  } catch {
    throw new SessionError();
  }
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new SessionError();
  if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) throw new SessionError();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, String((body as { error?: string }).error ?? 'error'));
  return body as T;
}

export interface Page<T> { items: T[]; limit: number; offset: number }

/** Pages through a limit/offset list endpoint. `truncated` is true if the cap was hit. */
export async function fetchAll<T>(path: string, maxPages = 10): Promise<{ items: T[]; truncated: boolean }> {
  const out: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let i = 0; i < maxPages; i++) {
    const p = await api<Page<T>>(`${path}${sep}limit=500&offset=${i * 500}`);
    out.push(...p.items);
    if (p.items.length < 500) return { items: out, truncated: false };
  }
  return { items: out, truncated: true };
}

export interface WaitlistRow { id: number; email: string; name: string | null; interest: string | null; created_at: string }
export interface TicketRow { ticket_id: string; name: string; email: string; topic: string; message: string; status: TicketStatus; created_at: string; updated_at: string }
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export const STATUSES: TicketStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
export interface AuditRow { id: number; ts: string; actor: string; action: string; target: string | null; request_id: string; hash_prefix: string | null }
export interface AuditPage { items: AuditRow[]; limit: number; next_before: number | null }
export interface Integrity {
  chain: { ok: boolean; rows: number; sealed: number; unsealed: number; headHash: string | null; brokenAtId?: number; reason?: string };
  lastBackupOk: boolean; lastBackupAt: string | null; lastVerifiedAt: string | null;
}
