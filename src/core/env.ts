export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  IMG?: ImagesBinding;
  RL_SUBMIT_USER?: RateLimitBinding;
  RL_SUBMIT_IP?: RateLimitBinding;
  RL_READ_USER?: RateLimitBinding;
  RL_UPLOAD_USER?: RateLimitBinding;
  STATUS_LIST: string;
  TRUST_X_FORWARDED_FOR?: string;
  READ_IP_BACKSTOP?: string;
  CONTROLLER_NAME: string;
  ADMIN_URL: string;
  IMAGES_URL: string;
  ADMIN_BOOTSTRAP_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  IMAGE_URL_SECRET?: string;
  NOTIFIER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export function statusList(env: Env): string[] {
  return env.STATUS_LIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
