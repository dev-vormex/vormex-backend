import 'dotenv/config';
import { prisma, disconnectPrisma } from '../config/prisma';
import { hashEmail } from '../utils/email-hash.util';

async function main() {
  const users = await prisma.user.findMany({
    where: { emailHash: null },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    console.log('No users need email-hash backfill.');
    return;
  }

  console.log(`Backfilling email hashes for ${users.length} users...`);

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailHash: hashEmail(user.email) },
    });
  }

  console.log('Email-hash backfill complete.');
}

main()
  .catch((error) => {
    console.error('Failed to backfill user email hashes:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
