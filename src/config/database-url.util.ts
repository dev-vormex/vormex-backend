export interface DatabaseUrlOptions {
  connectionLimit?: string;
  pgbouncer?: 'true' | 'false' | 'auto';
}

export interface DatabasePoolConfig {
  url: string | undefined;
  isConfigured: boolean;
  isLikelyPooled: boolean;
  connectionLimit: string;
  pgbouncerEnabled: boolean;
  warnings: string[];
}

const DEFAULT_CONNECTION_LIMIT = '3';
const DEFAULT_READ_CONNECTION_LIMIT = '3';

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export function isLikelyPooledPostgresUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.searchParams.get('pgbouncer') === 'true' ||
      url.searchParams.get('pool_timeout') !== null ||
      host.includes('pooler') ||
      host.includes('pgbouncer') ||
      url.port === '6543'
    );
  } catch {
    return false;
  }
}

export function withPrismaPoolParams(
  value: string | undefined,
  options: DatabaseUrlOptions = {}
): string | undefined {
  if (!value) return value;

  try {
    const url = new URL(value);
    const connectionLimit = options.connectionLimit || DEFAULT_CONNECTION_LIMIT;
    const shouldSetPgBouncer =
      options.pgbouncer === 'true' ||
      (options.pgbouncer !== 'false' && isLikelyPooledPostgresUrl(value));

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', connectionLimit);
    }
    if (shouldSetPgBouncer && !url.searchParams.has('pgbouncer')) {
      url.searchParams.set('pgbouncer', 'true');
    }

    return url.toString();
  } catch {
    return value;
  }
}

export function buildDatabasePoolConfig(params: {
  env: NodeJS.ProcessEnv;
  role: 'write' | 'read';
}): DatabasePoolConfig {
  const { env, role } = params;
  const isRead = role === 'read';
  const rawUrl = isRead ? env.READ_DATABASE_URL : env.DATABASE_URL;
  const connectionLimit =
    (isRead ? env.PRISMA_READ_CONNECTION_LIMIT : env.PRISMA_CONNECTION_LIMIT) ||
    (isRead ? DEFAULT_READ_CONNECTION_LIMIT : DEFAULT_CONNECTION_LIMIT);
  const pgbouncerMode = (env.PRISMA_PGBOUNCER || 'auto') as DatabaseUrlOptions['pgbouncer'];
  const url = withPrismaPoolParams(rawUrl, {
    connectionLimit,
    pgbouncer: pgbouncerMode,
  });
  const isLikelyPooled = isLikelyPooledPostgresUrl(url);
  const poolerRequired = boolEnv(env.DB_POOLER_REQUIRED, env.NODE_ENV === 'production');
  const warnings: string[] = [];

  if (rawUrl && poolerRequired && !isLikelyPooled) {
    warnings.push(`${role} database URL does not look like a transaction-pooler URL`);
  }
  if (!isRead && env.NODE_ENV === 'production' && !env.DIRECT_URL) {
    warnings.push('DIRECT_URL is missing; Prisma migrations should use a direct Postgres connection');
  }

  let pgbouncerEnabled = false;
  if (url) {
    try {
      pgbouncerEnabled = new URL(url).searchParams.get('pgbouncer') === 'true';
    } catch {
      pgbouncerEnabled = false;
    }
  }

  return {
    url,
    isConfigured: Boolean(rawUrl),
    isLikelyPooled,
    connectionLimit,
    pgbouncerEnabled,
    warnings,
  };
}

export function assertDatabasePoolConfig(configs: DatabasePoolConfig[], env: NodeJS.ProcessEnv): void {
  const poolerRequired = boolEnv(env.DB_POOLER_REQUIRED, env.NODE_ENV === 'production');
  if (!poolerRequired) return;

  const warnings = configs.flatMap((config) => config.warnings);
  if (warnings.length > 0) {
    throw new Error(`Database pooler configuration is invalid: ${warnings.join('; ')}`);
  }
}
