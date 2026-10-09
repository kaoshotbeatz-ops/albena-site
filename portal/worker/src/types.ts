export interface User { id: string; email: string; role: "owner" | "member"; accountId: string }
export interface Bindings {
  DB: D1Database;
  PORTAL_SECRETS: string;
  TURNSTILE_SECRET_KEY: string;
  AUTH_IP_LIMITER: RateLimit;
  AUTH_EMAIL_LIMITER: RateLimit;
  ENVIRONMENT: "production" | "development" | "test";
  PORTAL_ORIGIN: string;
  RP_ID: string;
  MAIL_FROM: string;
  MAIL_PROVIDER: "cloudflare" | "mailchannels" | "dev";
  EMAIL?: SendEmail;
  MAILCHANNELS_API_KEY?: string;
}
export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: User; requestId: string; sessionId: string };
};
