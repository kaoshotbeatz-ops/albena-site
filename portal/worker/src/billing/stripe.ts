import type { Bindings } from "../_stubs";

export class StripeError extends Error {
  constructor(public status: number, public body: unknown) { super(`stripe_${status}`); }
}

/** Stripe form encoding: nested objects/arrays as a[b][0]=c. */
export function encodeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export async function stripe<T = any>(
  env: Bindings, method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string,
): Promise<T> {
  const qs = encodeForm(params);
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": "2025-09-30.clover" };
  let url = `https://api.stripe.com/v1${path}`;
  let body: string | undefined;
  if (method === "GET") { if (qs) url += `?${qs}`; }
  else { body = qs; headers["Content-Type"] = "application/x-www-form-urlencoded"; if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey; }
  const res = await fetch(url, { method, headers, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(res.status, json);
  return json as T;
}
