/**
 * One-off cleanup for the removed test/developer premium override.
 *
 * Any subscription row still carrying the `developer_override` provider was granted without
 * a payment. Access evaluation already ignores those rows, and this script marks them
 * revoked in the database so admin dashboards stop counting them as premium users.
 *
 * Usage: npx tsx src/scripts/revoke-test-premium.ts
 */
import { prisma } from '../config/prisma';
import {
  LEGACY_TEST_PREMIUM_PROVIDER,
  logPremiumCheckoutEvent,
  revokeLegacyTestPremiumSubscriptions,
} from '../services/premium-access.service';

async function main() {
  const pending = await prisma.subscriptions.count({
    where: { provider: LEGACY_TEST_PREMIUM_PROVIDER },
  });

  if (pending === 0) {
    console.log('No test premium subscriptions found. Nothing to revoke.');
    return;
  }

  console.log(`Revoking ${pending} test premium subscription(s)...`);
  const revokedUserIds = await revokeLegacyTestPremiumSubscriptions();

  for (const userId of revokedUserIds) {
    await logPremiumCheckoutEvent({
      userId,
      eventType: 'TEST_PREMIUM_REVOKED',
      outcome: 'info',
      message: 'Test premium access revoked. Premium now requires a real payment.',
      metadata: { provider: LEGACY_TEST_PREMIUM_PROVIDER },
    });
  }

  console.log(`Revoked test premium for ${revokedUserIds.length} user(s).`);
}

main()
  .catch((error) => {
    console.error('Failed to revoke test premium subscriptions:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
