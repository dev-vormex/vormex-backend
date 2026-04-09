/**
 * Data migration script: Generate usernames for existing users
 * 
 * This script:
 * 1. Finds all users without a username
 * 2. Generates a unique username from their name
 * 3. Updates the user record
 * 
 * Run with: npx ts-node src/scripts/generate-usernames.ts
 */

import { PrismaClient } from '@prisma/client';
import { generateUsernameFromName, normalizeUsername } from '../utils/username.util';

const prisma = new PrismaClient();

/**
 * Generate a unique username for a user
 * 
 * @param baseUsername - Base username to start with
 * @param excludeUserId - User ID to exclude from uniqueness check
 * @returns Unique username
 */
async function generateUniqueUsername(
  baseUsername: string,
  excludeUserId?: string
): Promise<string> {
  let username = normalizeUsername(baseUsername);
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    // Check if username is available
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    // If username is available (or belongs to current user), use it
    if (!existing || existing.id === excludeUserId) {
      return username;
    }

    // Username taken, add/increment suffix
    const match = username.match(/^(.+)_(\d+)$/);
    if (match) {
      // Has existing suffix, increment it
      const base = match[1];
      const suffix = parseInt(match[2], 10);
      username = `${base}_${suffix + 1}`;
    } else {
      // No suffix, add one
      username = `${username}_1`;
    }

    attempts++;
  }

  // Fallback: use timestamp
  const timestamp = Date.now().toString().slice(-6);
  return `${baseUsername}_${timestamp}`;
}

/**
 * Main migration function
 */
async function main() {
  console.log('Starting username generation migration...');

  try {
    // Find all users without username
    const usersWithoutUsername = await prisma.user.findMany({
      where: {
        username: null as any,
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    console.log(`Found ${usersWithoutUsername.length} users without username`);

    if (usersWithoutUsername.length === 0) {
      console.log('No users to migrate. Exiting.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of usersWithoutUsername) {
      try {
        // Generate base username from name
        const baseUsername = generateUsernameFromName(user.name);

        // Ensure uniqueness
        const uniqueUsername = await generateUniqueUsername(baseUsername, user.id);

        // Update user
        await prisma.user.update({
          where: { id: user.id },
          data: { username: uniqueUsername },
        });

        console.log(`✓ ${user.email} → ${uniqueUsername}`);
        successCount++;
      } catch (error) {
        console.error(`✗ Failed to generate username for ${user.email}:`, error);
        errorCount++;
      }
    }

    console.log('\nMigration complete!');
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total: ${usersWithoutUsername.length}`);
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Run migration
main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


