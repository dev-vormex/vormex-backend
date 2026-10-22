import { normalizeUsername, generateUsernameFromName, validateUsername } from "../../../../shared/utils/username.util";
import { prisma } from "../../../../config/prisma";

export /**
 * Email validation regex
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function generateUniqueUsernameFromName(name: string): Promise<string> {
  let username = normalizeUsername(generateUsernameFromName(name));
  let attempts = 0;

  while (attempts < 100) {
    const existingUser = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!existingUser) {
      return username;
    }

    const suffix = Math.floor(1000 + Math.random() * 9000);
    username = `${username.slice(0, 25)}_${suffix}`.slice(0, 30);
    attempts += 1;
  }

  return `user_${Date.now().toString(36)}_${Math.floor(1000 + Math.random() * 9000)}`.slice(0, 30);
}

export async function resolveRegistrationUsername(params: {
  username?: string;
  displayName: string;
  existingUserId?: string;
  existingUsername?: string | null;
}): Promise<{ username?: string; error?: string; status?: number }> {
  if (!params.username) {
    return {
      username: params.existingUsername || await generateUniqueUsernameFromName(params.displayName),
    };
  }

  const normalizedUsername = normalizeUsername(params.username);
  const usernameValidation = validateUsername(normalizedUsername);
  if (!usernameValidation.valid) {
    return {
      status: 400,
      error: usernameValidation.error || 'Invalid username format',
    };
  }

  const existingUserByUsername = await prisma.user.findUnique({
    where: { username: normalizedUsername },
    select: { id: true },
  });

  if (
    existingUserByUsername &&
    (!params.existingUserId || existingUserByUsername.id !== params.existingUserId)
  ) {
    return {
      status: 409,
      error: 'Username already taken',
    };
  }

  return { username: normalizedUsername };
}
