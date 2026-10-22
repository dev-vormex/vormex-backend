import { Request } from "express";
import { serializeProfileTheme } from "../../../profiles/constants/profile-themes";

export interface AuthRequest extends Request<Record<string, string>> {
  user?: { userId: string; sessionId?: string };
}

export const parseStringArray = (value: any): string[] => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
};

export const normalizeOptionalString = (value: any): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export const parseOptionalDateInput = (value: any): Date | undefined => {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
};

export const buildUserAudienceWhere = ({
  search,
  colleges = [],
  skills = [],
  excludeBanned = true,
}: {
  search?: string;
  colleges?: string[];
  skills?: string[];
  excludeBanned?: boolean;
}) => {
  const where: any = {};

  if (excludeBanned) {
    where.isBanned = false;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { username: { contains: search, mode: 'insensitive' } },
      { college: { contains: search, mode: 'insensitive' } },
      { branch: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (colleges.length > 0) {
    where.college = { in: colleges };
  }

  if (skills.length > 0) {
    where.skills = {
      some: {
        skill: {
          name: { in: skills },
        },
      },
    };
  }

  return where;
};

export const mapAdminUser = (user: any) => ({
  ...user,
  profileTheme: serializeProfileTheme(user.profileTheme),
  hasActivePushToken: (user.device_tokens?.length ?? 0) > 0,
  activePushPlatforms: Array.from(new Set((user.device_tokens ?? []).map((entry: any) => entry.platform))),
  lastPushTokenAt: user.device_tokens?.[0]?.updatedAt ?? null,
  skills: user.skills?.map((entry: any) => entry.skill.name) ?? [],
  _count: {
    posts: user._count.posts,
    connectionsSent: user._count.connections_connections_requesterIdTousers,
    connectionsReceived: user._count.connections_connections_addresseeIdTousers,
  },
});

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};
