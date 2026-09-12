/**
 * Runtime configuration. The deployment writes `/config.json` next to the
 * built app so one artefact serves every environment. In development the
 * `VITE_*` variables stand in when the file is absent.
 */
export interface AppleSignInConfig {
  /** Cognito hosted-UI domain, e.g. `auth.gede.1cloudhub.com`. */
  domain: string;
}

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
  wsUrl: string;
  /** `false` hides the Apple button; an object enables the federated flow. */
  appleSignIn: false | AppleSignInConfig;
  /** Public status page linked from the 503 page; `null` disables the link. */
  statusUrl: string | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Hand-written guard: exact keys, exact shapes, no library. */
export function parseConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) throw new ConfigError('config.json must be a JSON object');
  const required = ['region', 'userPoolId', 'userPoolClientId', 'apiUrl', 'wsUrl'] as const;
  for (const key of required) {
    if (!isNonEmptyString(raw[key]))
      throw new ConfigError(`config.json: "${key}" must be a non-empty string`);
  }
  const apple = raw.appleSignIn;
  let appleSignIn: AppConfig['appleSignIn'];
  if (apple === false || apple === undefined || apple === null) {
    appleSignIn = false;
  } else if (isRecord(apple) && isNonEmptyString(apple.domain)) {
    appleSignIn = { domain: apple.domain };
  } else {
    throw new ConfigError('config.json: "appleSignIn" must be false or { domain: string }');
  }
  const status = raw.statusUrl;
  if (status !== undefined && status !== null && !isNonEmptyString(status)) {
    throw new ConfigError('config.json: "statusUrl" must be a string or null');
  }
  return {
    region: raw.region as string,
    userPoolId: raw.userPoolId as string,
    userPoolClientId: raw.userPoolClientId as string,
    apiUrl: (raw.apiUrl as string).replace(/\/+$/, ''),
    wsUrl: raw.wsUrl as string,
    appleSignIn,
    statusUrl: isNonEmptyString(status) ? status : null,
  };
}

/** Development fallback from `VITE_*`; returns null when nothing is set. */
export function configFromEnv(env: ImportMetaEnv): unknown {
  if (!isNonEmptyString(env.VITE_USER_POOL_ID)) return null;
  return {
    region: env.VITE_REGION,
    userPoolId: env.VITE_USER_POOL_ID,
    userPoolClientId: env.VITE_USER_POOL_CLIENT_ID,
    apiUrl: env.VITE_API_URL ?? '/api',
    wsUrl: env.VITE_WS_URL ?? '/ws',
    appleSignIn: isNonEmptyString(env.VITE_APPLE_DOMAIN)
      ? { domain: env.VITE_APPLE_DOMAIN }
      : false,
    statusUrl: env.VITE_STATUS_URL ?? null,
  };
}

let cached: AppConfig | null = null;
let inflight: Promise<AppConfig> | null = null;

export interface LoadConfigOptions {
  fetchImpl?: typeof fetch | undefined;
  env?: ImportMetaEnv | undefined;
  dev?: boolean | undefined;
}

/** Fetch `/config.json` once and cache it for the life of the page. */
export function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  if (cached) return Promise.resolve(cached);
  inflight ??= (async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const env = options.env ?? import.meta.env;
    const dev = options.dev ?? import.meta.env.DEV;
    let raw: unknown = null;
    let res: Response | null = null;
    try {
      res = await fetchImpl('/config.json', { cache: 'no-store' });
    } catch {
      res = null;
    }
    if (res?.ok) {
      raw = await res.json();
    } else if (dev) {
      raw = configFromEnv(env);
      if (raw === null) {
        throw new ConfigError(
          '/config.json is missing. Copy public/config.example.json to public/config.json or set VITE_USER_POOL_ID and friends.',
        );
      }
    } else {
      throw new ConfigError(
        `/config.json is missing (${res ? String(res.status) : 'network error'}).`,
      );
    }
    cached = parseConfig(raw);
    return cached;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Synchronous access after boot. */
export function getConfig(): AppConfig {
  if (!cached) throw new ConfigError('getConfig() called before loadConfig() resolved');
  return cached;
}

/** Test seam: install a config without fetching. */
export function setConfigForTests(config: AppConfig | null): void {
  cached = config;
  inflight = null;
}
