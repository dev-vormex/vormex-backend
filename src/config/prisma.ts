import { PrismaClient } from '@prisma/client';

type PrismaGlobal = {
  prismaWrite?: PrismaClient;
  prismaRead?: PrismaClient;
};

const globalForPrisma = global as unknown as PrismaGlobal;

function buildClient(logQueries = false, url?: string): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? logQueries
          ? ['query', 'error', 'warn']
          : ['error', 'warn']
        : ['error'],
    ...(url
      ? {
          datasources: {
            db: {
              url,
            },
          },
        }
      : {}),
  });
}

const logQueries = process.env.PRISMA_LOG_QUERIES === 'true';

export const prismaWrite =
  globalForPrisma.prismaWrite || buildClient(logQueries, process.env.DATABASE_URL);

const readUrl = process.env.READ_DATABASE_URL;
export const prismaRead =
  globalForPrisma.prismaRead ||
  (readUrl && readUrl !== process.env.DATABASE_URL
    ? buildClient(logQueries, readUrl)
    : prismaWrite);

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaWrite = prismaWrite;
  globalForPrisma.prismaRead = prismaRead;
}

export const prisma = prismaWrite;

export async function disconnectPrisma(): Promise<void> {
  await Promise.allSettled([
    prismaWrite.$disconnect(),
    prismaRead === prismaWrite ? Promise.resolve() : prismaRead.$disconnect(),
  ]);
}

export async function withWriteTransaction<T>(
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  return prismaWrite.$transaction((tx) => fn(tx as unknown as PrismaClient));
}
