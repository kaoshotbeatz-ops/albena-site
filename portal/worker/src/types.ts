export interface User { id: string; email: string; role: "owner" | "member"; accountId: string }
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  PORTAL_SECRETS: string;
  TURNSTILE_SECRET_KEY: string;
  AUTH_IP_LIMITER: RateLimit;
  AUTH_EMAIL_LIMITER: RateLimit;
  ENVIRONMENT: "production" | "development" | "test";
  PORTAL_ORIGIN: string;
  RP_ID: string;
  MAIL_FROM: string;
  MAIL_PROVIDER: "cloudflare" | "dev";
  EMAIL?: SendEmail;
  // Billing (Stripe test mode until launch). Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // Stripe Price IDs (vars). Empty = plan not configured (checkout answers 503).
  PRICE_BYO_MONTHLY?: string; PRICE_BYO_ANNUAL?: string;
  PRICE_HUB_MAC_MONTHLY?: string; PRICE_HUB_MAC_ANNUAL?: string; PRICE_HUB_MAC_HARDWARE?: string;
  PRICE_HUB_NVIDIA_MONTHLY?: string; PRICE_HUB_NVIDIA_ANNUAL?: string; PRICE_HUB_NVIDIA_HARDWARE?: string;
}
export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: User; requestId: string; sessionId: string };
};
