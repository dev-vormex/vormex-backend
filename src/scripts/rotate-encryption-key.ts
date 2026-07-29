import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hasPreviousEncryptionKey } from '../config/encryption-keyring';
import {
  inspectAdminTwoFactorSecret,
  inspectStoredSecret,
  reencryptAdminTwoFactorSecret,
  reencryptStoredSecret,
  StoredSecretInspection,
} from '../services/encryption-rotation.service';
import {
  listIdentityEvidenceStorageKeys,
  rotateEncryptedIdentityEvidence,
} from '../services/identity-evidence.service';

type Mode = 'dry-run' | 'apply' | 'verify';
type UserSecretField = 'githubAccessToken' | 'phoneEncrypted' | 'adminTwoFactorSecret';

interface CliOptions {
  batchSize: number;
  confirmation?: string;
  evidenceBackupDirectory?: string;
  mode: Mode;
}

interface RotationStats {
  conflicts: number;
  current: number;
  invalid: number;
  legacy: number;
  pending: number;
  plaintext: number;
  previous: number;
  rotated: number;
  scanned: number;
}

const APPLY_CONFIRMATION = 'dual-key-rotation';
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

class RotationOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RotationOperatorError';
  }
}

function emptyStats(): RotationStats {
  return {
    conflicts: 0,
    current: 0,
    invalid: 0,
    legacy: 0,
    pending: 0,
    plaintext: 0,
    previous: 0,
    rotated: 0,
    scanned: 0,
  };
}

function mergeStats(target: RotationStats, source: RotationStats): void {
  for (const key of Object.keys(target) as Array<keyof RotationStats>) {
    target[key] += source[key];
  }
}

function recordInspection(stats: RotationStats, inspection: StoredSecretInspection): void {
  stats.scanned += 1;
  if (inspection.keySource === 'current') stats.current += 1;
  if (inspection.keySource === 'previous') stats.previous += 1;
  if (inspection.format === 'legacy') stats.legacy += 1;
  if (inspection.format === 'plaintext') stats.plaintext += 1;
  if (inspection.needsRotation) stats.pending += 1;
}

function printStats(label: string, stats: RotationStats): void {
  console.log(
    `[rotation] ${label}: scanned=${stats.scanned} current=${stats.current} ` +
      `previous=${stats.previous} legacy=${stats.legacy} plaintext=${stats.plaintext} ` +
      `pending=${stats.pending} rotated=${stats.rotated} conflicts=${stats.conflicts} ` +
      `invalid=${stats.invalid}`
  );
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RotationOperatorError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new RotationOperatorError(`${name} must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

function parseOptions(argv: string[]): CliOptions {
  let mode: Mode = 'dry-run';
  let explicitMode: Mode | null = null;
  let batchSize = DEFAULT_BATCH_SIZE;
  let confirmation: string | undefined;
  let evidenceBackupDirectory: string | undefined;

  for (const argument of argv) {
    let requestedMode: Mode | null = null;
    if (argument === '--dry-run') requestedMode = 'dry-run';
    if (argument === '--apply') requestedMode = 'apply';
    if (argument === '--verify') requestedMode = 'verify';

    if (requestedMode) {
      if (explicitMode && explicitMode !== requestedMode) {
        throw new RotationOperatorError('Choose exactly one of --dry-run, --apply, or --verify');
      }
      explicitMode = requestedMode;
      mode = requestedMode;
      continue;
    }

    if (argument.startsWith('--batch-size=')) {
      batchSize = parsePositiveInteger(argument.slice('--batch-size='.length), '--batch-size');
      continue;
    }
    if (argument.startsWith('--confirm=')) {
      confirmation = argument.slice('--confirm='.length);
      continue;
    }
    if (argument.startsWith('--evidence-backup-dir=')) {
      evidenceBackupDirectory = argument.slice('--evidence-backup-dir='.length).trim();
      if (!evidenceBackupDirectory) {
        throw new RotationOperatorError('--evidence-backup-dir cannot be empty');
      }
      continue;
    }
    if (argument === '--help') {
      console.log(
        'Usage: npm run encryption:rotate -- [--dry-run|--verify|--apply] ' +
          '[--batch-size=100] [--evidence-backup-dir=/secure/path] ' +
          `[--confirm=${APPLY_CONFIRMATION}]`
      );
      process.exit(0);
    }

    throw new RotationOperatorError('Unknown command-line option');
  }

  return { batchSize, confirmation, evidenceBackupDirectory, mode };
}

function validateOptions(options: CliOptions): void {
  if (options.mode !== 'apply') return;
  if (!hasPreviousEncryptionKey()) {
    throw new RotationOperatorError('ENCRYPTION_KEY_PREVIOUS is required for apply mode');
  }
  if (options.confirmation !== APPLY_CONFIRMATION) {
    throw new RotationOperatorError(`Apply mode requires --confirm=${APPLY_CONFIRMATION}`);
  }
}

function inspectField(field: UserSecretField, value: string): StoredSecretInspection {
  return field === 'adminTwoFactorSecret'
    ? inspectAdminTwoFactorSecret(value)
    : inspectStoredSecret(value);
}

function replacementForField(field: UserSecretField, value: string): string | null {
  const result = field === 'adminTwoFactorSecret'
    ? reencryptAdminTwoFactorSecret(value)
    : reencryptStoredSecret(value);
  return result.replacement;
}

async function compareAndSwapUserSecret(params: {
  field: UserSecretField;
  id: string;
  original: string;
  prisma: PrismaClient;
  replacement: string;
}): Promise<boolean> {
  if (params.field === 'githubAccessToken') {
    const result = await params.prisma.user.updateMany({
      where: { id: params.id, githubAccessToken: params.original },
      data: { githubAccessToken: params.replacement },
    });
    return result.count === 1;
  }

  if (params.field === 'phoneEncrypted') {
    const result = await params.prisma.user.updateMany({
      where: { id: params.id, phoneEncrypted: params.original },
      data: { phoneEncrypted: params.replacement },
    });
    return result.count === 1;
  }

  const result = await params.prisma.user.updateMany({
    where: { id: params.id, adminTwoFactorSecret: params.original },
    data: { adminTwoFactorSecret: params.replacement },
  });
  return result.count === 1;
}

async function processUserField(params: {
  field: UserSecretField;
  id: string;
  mode: Mode;
  prisma: PrismaClient;
  stats: RotationStats;
  value: string | null;
}): Promise<void> {
  if (!params.value) return;

  let inspection: StoredSecretInspection;
  try {
    inspection = inspectField(params.field, params.value);
    recordInspection(params.stats, inspection);
  } catch {
    params.stats.scanned += 1;
    params.stats.invalid += 1;
    return;
  }

  if (params.mode !== 'apply' || !inspection.needsRotation) return;

  try {
    const replacement = replacementForField(params.field, params.value);
    if (!replacement) return;
    const updated = await compareAndSwapUserSecret({
      field: params.field,
      id: params.id,
      original: params.value,
      prisma: params.prisma,
      replacement,
    });
    if (updated) params.stats.rotated += 1;
    else params.stats.conflicts += 1;
  } catch {
    params.stats.invalid += 1;
  }
}

async function scanDatabaseSecrets(
  prisma: PrismaClient,
  options: Pick<CliOptions, 'batchSize' | 'mode'>
): Promise<Record<UserSecretField, RotationStats>> {
  const stats: Record<UserSecretField, RotationStats> = {
    githubAccessToken: emptyStats(),
    phoneEncrypted: emptyStats(),
    adminTwoFactorSecret: emptyStats(),
  };
  let lastId: string | undefined;

  while (true) {
    const rows = await prisma.user.findMany({
      where: {
        ...(lastId ? { id: { gt: lastId } } : {}),
        OR: [
          { githubAccessToken: { not: null } },
          { phoneEncrypted: { not: null } },
          { adminTwoFactorSecret: { not: null } },
        ],
      },
      orderBy: { id: 'asc' },
      take: options.batchSize,
      select: {
        id: true,
        githubAccessToken: true,
        phoneEncrypted: true,
        adminTwoFactorSecret: true,
      },
    });

    if (rows.length === 0) break;
    for (const row of rows) {
      await processUserField({
        field: 'githubAccessToken',
        id: row.id,
        mode: options.mode,
        prisma,
        stats: stats.githubAccessToken,
        value: row.githubAccessToken,
      });
      await processUserField({
        field: 'phoneEncrypted',
        id: row.id,
        mode: options.mode,
        prisma,
        stats: stats.phoneEncrypted,
        value: row.phoneEncrypted,
      });
      await processUserField({
        field: 'adminTwoFactorSecret',
        id: row.id,
        mode: options.mode,
        prisma,
        stats: stats.adminTwoFactorSecret,
        value: row.adminTwoFactorSecret,
      });
    }

    lastId = rows[rows.length - 1].id;
  }

  return stats;
}

async function scanIdentityEvidence(options: CliOptions): Promise<RotationStats> {
  const stats = emptyStats();
  const storageKeys = await listIdentityEvidenceStorageKeys();

  if (options.mode === 'apply' && storageKeys.length > 0 && !options.evidenceBackupDirectory) {
    throw new RotationOperatorError(
      'Apply mode requires --evidence-backup-dir when evidence files exist'
    );
  }

  for (const storageKey of storageKeys) {
    stats.scanned += 1;
    try {
      const result = await rotateEncryptedIdentityEvidence({
        backupDirectory: options.evidenceBackupDirectory,
        dryRun: options.mode !== 'apply',
        storageKey,
      });
      if (result.keySource === 'current') stats.current += 1;
      if (result.keySource === 'previous') {
        stats.previous += 1;
        stats.pending += 1;
      }
      if (result.rotated) stats.rotated += 1;
    } catch {
      stats.invalid += 1;
    }
  }

  return stats;
}

function aggregateStats(
  database: Record<UserSecretField, RotationStats>,
  evidence: RotationStats
): RotationStats {
  const total = emptyStats();
  for (const fieldStats of Object.values(database)) mergeStats(total, fieldStats);
  mergeStats(total, evidence);
  return total;
}

async function runPass(prisma: PrismaClient, options: CliOptions, label: string): Promise<RotationStats> {
  console.log(`[rotation] Starting ${label} pass.`);
  const database = await scanDatabaseSecrets(prisma, options);
  const evidence = await scanIdentityEvidence(options);
  printStats('githubAccessToken', database.githubAccessToken);
  printStats('phoneEncrypted', database.phoneEncrypted);
  printStats('adminTwoFactorSecret', database.adminTwoFactorSecret);
  printStats('identityEvidence', evidence);
  const total = aggregateStats(database, evidence);
  printStats('total', total);
  return total;
}

function assertCleanScan(stats: RotationStats, phase: string): void {
  if (stats.invalid > 0) {
    throw new RotationOperatorError(`${phase} found unreadable protected values`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  validateOptions(options);
  const prisma = new PrismaClient({ log: [] });

  try {
    if (options.mode !== 'apply') {
      const result = await runPass(prisma, options, options.mode);
      assertCleanScan(result, options.mode);
      if (options.mode === 'verify' && result.pending > 0) {
        throw new RotationOperatorError('Verification found values that still require rotation');
      }
      console.log(`[rotation] ${options.mode} completed successfully.`);
      return;
    }

    const preflight = await runPass(prisma, { ...options, mode: 'dry-run' }, 'preflight');
    assertCleanScan(preflight, 'Preflight');

    const applied = await runPass(prisma, options, 'apply');
    assertCleanScan(applied, 'Apply');

    const verified = await runPass(prisma, { ...options, mode: 'verify' }, 'verification');
    assertCleanScan(verified, 'Verification');
    if (verified.pending > 0) {
      throw new RotationOperatorError('Verification found values that still require rotation');
    }
    console.log('[rotation] Apply and verification completed successfully.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof RotationOperatorError) {
    console.error(`[rotation] ${error.message}. No protected values were displayed.`);
  } else {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error(`[rotation] Failed safely (${errorName}). No protected values were displayed.`);
  }
  process.exitCode = 1;
});
