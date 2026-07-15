import 'dotenv/config';
import { disconnectPrisma, prismaRead } from '../config/prisma';
import { reindexPublicProfile } from '../services/public-discovery.service';

async function main(): Promise<void> {
  let cursor: string | undefined;
  let indexed = 0;
  do {
    const users = await prismaRead.user.findMany({
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!users.length) break;
    for (let offset = 0; offset < users.length; offset += 4) {
      const batch = users.slice(offset, offset + 4);
      await Promise.all(batch.map((user) => reindexPublicProfile(user.id)));
      indexed += batch.length;
      console.log(`Public discovery profiles indexed: ${indexed}`);
    }
    cursor = users[users.length - 1].id;
  } while (cursor);
}

main()
  .catch((error) => {
    console.error('Public discovery backfill failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
