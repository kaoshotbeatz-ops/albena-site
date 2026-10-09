export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BACKUPS: R2Bucket;
  /** R2 key prefix; "" in production, "staging/" in staging. */
  BACKUP_PREFIX?: string;
  POST_LIMITER: RateLimit;
  MAIL?: SendEmail;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  IP_SALT: string;
  ADMIN_AUD: string;
  TEAM_DOMAIN: string;
  NOTIFY_FROM?: string;
  ENVIRONMENT?: string;
  EXTRA_TURNSTILE_HOSTS?: string;
}

export type Vars = {
  requestId: string;
  ipHash: string;
  actor: string;
  body: Record<string, unknown>;
};

export type AppEnv = { Bindings: Env; Variables: Vars };
