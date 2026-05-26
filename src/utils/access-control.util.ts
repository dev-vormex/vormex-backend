import { prismaRead } from '../config/prisma';

type PrismaLike = {
  connections: {
    findFirst: (args: any) => Promise<unknown>;
    findMany: (args: any) => Promise<Array<{ requesterId: string; addresseeId: string }>>;
  };
  group_members: {
    findUnique: (args: any) => Promise<unknown>;
    findMany: (args: any) => Promise<Array<{ groupId: string }>>;
  };
  postCollaborator?: {
    findFirst: (args: any) => Promise<unknown>;
  };
};

const PUBLIC_VISIBILITIES = ['public', 'PUBLIC'];
const CONNECTION_VISIBILITIES = ['connections', 'CONNECTIONS'];

function normalizeUserId(userId?: string | number | null): string | null {
  if (userId === null || userId === undefined) {
    return null;
  }

  const value = String(userId).trim();
  return value.length > 0 ? value : null;
}

function normalizeVisibility(value?: string | null): string {
  return String(value || 'public').trim().toLowerCase();
}

function isReadyStatus(value?: string | null): boolean {
  return String(value || '').trim().toLowerCase() === 'ready';
}

export async function areUsersConnected(
  leftUserId?: string | number | null,
  rightUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<boolean> {
  const left = normalizeUserId(leftUserId);
  const right = normalizeUserId(rightUserId);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const connection = await client.connections.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: left, addresseeId: right },
        { requesterId: right, addresseeId: left },
      ],
    },
    select: { id: true },
  });

  return Boolean(connection);
}

export async function getConnectedPeerIds(
  userId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<string[]> {
  const viewerId = normalizeUserId(userId);
  if (!viewerId) {
    return [];
  }

  const connections = await client.connections.findMany({
    where: {
      status: 'accepted',
      OR: [{ requesterId: viewerId }, { addresseeId: viewerId }],
    },
    select: { requesterId: true, addresseeId: true },
  });

  return Array.from(
    new Set(
      connections
        .flatMap((connection) => [connection.requesterId, connection.addresseeId])
        .filter((peerId) => peerId !== viewerId)
    )
  );
}

export async function buildPostVisibilityWhere(
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<Record<string, unknown>> {
  const viewerId = normalizeUserId(viewerUserId);
  const visibilityOr: Array<Record<string, unknown>> = [
    { visibility: { in: PUBLIC_VISIBILITIES } },
  ];

  if (viewerId) {
    visibilityOr.push({ authorId: viewerId });
    visibilityOr.push({
      collaborators: {
        some: {
          userId: viewerId,
          status: 'accepted',
        },
      },
    });

    const connectedPeerIds = await getConnectedPeerIds(viewerId, client);
    if (connectedPeerIds.length > 0) {
      visibilityOr.push({
        AND: [
          { visibility: { in: CONNECTION_VISIBILITIES } },
          { authorId: { in: connectedPeerIds } },
        ],
      });
    }
  }

  return { OR: visibilityOr };
}

export async function canViewPost(
  post: { id?: string; authorId: string; visibility?: string | null; isActive?: boolean | null } | null | undefined,
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<boolean> {
  if (!post) {
    return false;
  }

  if (post.isActive === false) {
    return false;
  }

  const viewerId = normalizeUserId(viewerUserId);
  if (viewerId && post.authorId === viewerId) {
    return true;
  }

  const visibility = normalizeVisibility(post.visibility);
  if (visibility === 'public') {
    return true;
  }

  if (visibility === 'connections') {
    if (await areUsersConnected(viewerId, post.authorId, client)) {
      return true;
    }
  }

  if (viewerId && post.id && client.postCollaborator) {
    const collaboration = await client.postCollaborator.findFirst({
      where: {
        postId: post.id,
        userId: viewerId,
        status: 'accepted',
      },
      select: { id: true },
    });
    if (collaboration) return true;
  }

  return false;
}

export async function buildReelVisibilityWhere(
  viewerUserId?: string | number | null,
  options: { allowOwnerDraft?: boolean } = {},
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<Record<string, unknown>> {
  const viewerId = normalizeUserId(viewerUserId);
  const readyPublicWhere = {
    status: 'ready',
    publishedAt: { not: null },
    visibility: { in: PUBLIC_VISIBILITIES },
  };
  const visibilityOr: Array<Record<string, unknown>> = [readyPublicWhere];

  if (viewerId) {
    visibilityOr.push(
      options.allowOwnerDraft
        ? { authorId: viewerId }
        : { authorId: viewerId, status: 'ready', publishedAt: { not: null } }
    );

    const connectedPeerIds = await getConnectedPeerIds(viewerId, client);
    if (connectedPeerIds.length > 0) {
      visibilityOr.push({
        AND: [
          { status: 'ready' },
          { publishedAt: { not: null } },
          { visibility: { in: CONNECTION_VISIBILITIES } },
          { authorId: { in: connectedPeerIds } },
        ],
      });
    }
  }

  return { OR: visibilityOr };
}

export async function canViewReel(
  reel: {
    authorId: string;
    visibility?: string | null;
    status?: string | null;
    publishedAt?: Date | string | null;
  } | null | undefined,
  viewerUserId?: string | number | null,
  options: { allowOwnerDraft?: boolean } = {},
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<boolean> {
  if (!reel) {
    return false;
  }

  const viewerId = normalizeUserId(viewerUserId);
  const isOwner = Boolean(viewerId && reel.authorId === viewerId);
  if (isOwner && options.allowOwnerDraft) {
    return true;
  }

  if (!isReadyStatus(reel.status) || !reel.publishedAt) {
    return false;
  }

  if (isOwner) {
    return true;
  }

  const visibility = normalizeVisibility(reel.visibility);
  if (visibility === 'public') {
    return true;
  }

  if (visibility === 'connections') {
    return areUsersConnected(viewerId, reel.authorId, client);
  }

  return false;
}

export async function buildStoryVisibilityWhere(
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<Record<string, unknown>> {
  const viewerId = normalizeUserId(viewerUserId);
  const visibilityOr: Array<Record<string, unknown>> = [
    { visibility: { in: ['PUBLIC', 'public'] } },
  ];

  if (viewerId) {
    visibilityOr.push({ authorId: viewerId });

    const connectedPeerIds = await getConnectedPeerIds(viewerId, client);
    if (connectedPeerIds.length > 0) {
      visibilityOr.push({
        AND: [
          { visibility: { in: ['CONNECTIONS', 'connections'] } },
          { authorId: { in: connectedPeerIds } },
        ],
      });
    }
  }

  return { OR: visibilityOr };
}

export async function canViewStory(
  story: { authorId: string; visibility?: string | null; expiresAt?: Date | string | null } | null | undefined,
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<boolean> {
  if (!story) {
    return false;
  }

  if (story.expiresAt && new Date(story.expiresAt) <= new Date()) {
    return false;
  }

  const viewerId = normalizeUserId(viewerUserId);
  if (viewerId && story.authorId === viewerId) {
    return true;
  }

  const visibility = normalizeVisibility(story.visibility);
  if (visibility === 'public') {
    return true;
  }

  if (visibility === 'connections') {
    return areUsersConnected(viewerId, story.authorId, client);
  }

  return false;
}

export async function getMemberGroupIds(
  userId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<string[]> {
  const viewerId = normalizeUserId(userId);
  if (!viewerId) {
    return [];
  }

  const memberships = await client.group_members.findMany({
    where: { userId: viewerId },
    select: { groupId: true },
  });

  return memberships.map((membership) => membership.groupId);
}

export async function buildGroupVisibilityWhere(
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<Record<string, unknown>> {
  const viewerId = normalizeUserId(viewerUserId);
  const memberGroupIds = await getMemberGroupIds(viewerId, client);
  const visibilityOr: Array<Record<string, unknown>> = [{ isPrivate: false }];

  if (memberGroupIds.length > 0) {
    visibilityOr.push({ id: { in: memberGroupIds } });
  }
  if (viewerId) {
    visibilityOr.push({ creatorId: viewerId });
  }

  return { OR: visibilityOr };
}

export async function canViewGroup(
  group: { id: string; isPrivate?: boolean | null; creatorId?: string | number | null } | null | undefined,
  viewerUserId?: string | number | null,
  client: PrismaLike = prismaRead as unknown as PrismaLike
): Promise<boolean> {
  if (!group) {
    return false;
  }

  if (!group.isPrivate) {
    return true;
  }

  const viewerId = normalizeUserId(viewerUserId);
  if (!viewerId) {
    return false;
  }
  if (normalizeUserId(group.creatorId) === viewerId) {
    return true;
  }

  const membership = await client.group_members.findUnique({
    where: { groupId_userId: { groupId: group.id, userId: viewerId } },
    select: { id: true },
  });

  return Boolean(membership);
}
