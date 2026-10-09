// Same-origin portal API client (see portal/CONTRACT.md). Session cookie is HttpOnly; no tokens in JS.
import type { Account, BillingSummary, Hub, Interval, Invoice, Me, Order, PairStart, PlanId, Release, Session, SignIn } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** Mock mode: `astro dev` only. `import.meta.env.DEV` is false in prod so this whole branch is dead-code-eliminated. */
export const MOCK: boolean = import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1';

type Handler = (method: string, path: string, body: unknown) => unknown;
let mockHandler: Handler | undefined;
async function mock(): Promise<Handler> {
  if (!import.meta.env.DEV) throw new Error('mock disabled');
  return (mockHandler ??= (await import('./mock')).handle);
}

export function goLogin() {
  if (location.pathname !== '/login') location.assign('/login');
}

export async function req<T>(method: string, path: string, body?: unknown, opts: { noRedirect?: boolean } = {}): Promise<T> {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 90));
    return (await mock())(method, path, body) as T;
  }
  const headers = new Headers({ Accept: 'application/json' });
  if (method !== 'GET') headers.set('X-Requested-With', 'albena-portal');
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !opts.noRedirect) { goLogin(); throw new ApiError(401, 'unauthorized'); }
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, String((data as { error?: string }).error ?? 'error'));
  return data as T;
}
const get = <T>(p: string) => req<T>('GET', p);
/** Endpoints not yet in the contract: a 404 yields the fallback instead of an error. */
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return fallback; throw e; }
}
const list = <T>(r: T[] | { items: T[] }): T[] => (Array.isArray(r) ? r : r.items);

export const api = {
  me: () => get<Me>('/api/me'),
  logout: () => req<unknown>('POST', '/api/auth/logout', {}),
  magicStart: (email: string, turnstileToken: string) => req<unknown>('POST', '/api/auth/magic/start', { email, turnstileToken }, { noRedirect: true }),
  passkeyLoginOptions: () => req<Record<string, unknown>>('POST', '/api/auth/passkey/login/options', {}, { noRedirect: true }),
  passkeyLoginVerify: (b: unknown) => req<unknown>('POST', '/api/auth/passkey/login/verify', b, { noRedirect: true }),
  passkeyRegisterOptions: () => req<Record<string, unknown>>('POST', '/api/auth/passkey/register/options', {}),
  passkeyRegisterVerify: (b: unknown) => req<unknown>('POST', '/api/auth/passkey/register/verify', b),
  /** Assumed (not in contract yet): DELETE /api/security/passkeys/:id */
  passkeyRemove: (id: string) => req<unknown>('DELETE', `/api/security/passkeys/${encodeURIComponent(id)}`),
  sessions: async () => list(await get<Session[] | { items: Session[] }>('/api/security/sessions')),
  revokeSession: (id: string) => req<unknown>('DELETE', `/api/security/sessions/${encodeURIComponent(id)}`),
  /** Assumed: GET /api/security/history */
  history: async () => list(await soft(get<SignIn[] | { items: SignIn[] }>('/api/security/history'), [])),
  billing: () => get<BillingSummary>('/api/billing/summary'),
  invoices: async () => list(await get<Invoice[] | { items: Invoice[] }>('/api/billing/invoices')),
  checkout: (plan: PlanId, interval: Interval) => req<{ url: string }>('POST', '/api/billing/checkout', { plan, interval }),
  portal: () => req<{ url: string }>('POST', '/api/billing/portal', {}),
  hubs: async () => list(await get<Hub[] | { items: Hub[] }>('/api/hubs')),
  pairStart: () => req<PairStart>('POST', '/api/hubs/pair/start', {}),
  hubPatch: (id: string, patch: Partial<Pick<Hub, 'name' | 'updateChannel' | 'remoteAccess'>>) => req<Hub>('PATCH', `/api/hubs/${encodeURIComponent(id)}`, patch),
  hubDelete: (id: string) => req<unknown>('DELETE', `/api/hubs/${encodeURIComponent(id)}`),
  release: (edition: string) => get<Release>(`/api/releases/latest?edition=${encodeURIComponent(edition)}`),
  account: () => get<Account>('/api/account'),
  invite: (email: string) => req<unknown>('POST', '/api/account/members/invite', { email }),
  exportData: () => get<unknown>('/api/account/export'),
  deleteAccount: (confirm: string) => req<unknown>('POST', '/api/account/delete', { confirm }),
  /** Assumed: GET /api/billing/orders */
  orders: async () => list(await soft(get<Order[] | { items: Order[] }>('/api/billing/orders'), [])),
};

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (e.status >= 500) return 'The service had a problem. Try again shortly.';
    return e.code === 'error' ? 'Something went wrong.' : e.code.replace(/_/g, ' ');
  }
  return 'Network problem. Check your connection and try again.';
}
