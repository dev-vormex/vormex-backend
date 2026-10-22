import { Prisma } from '@prisma/client';
import { prisma } from '../../../config/prisma';
import { httpError } from '../../../shared/utils/http-error.util';
import { getBlockedUserIds } from '../../safety/services/trust-safety.service';
import { groupAuthorSelect, requireGroupAccess } from './group-access.service';

export async function listGroupPosts(groupId: string, userId: string | null, page: number, limit: number) {
  await requireGroupAccess(groupId, userId, false);
  const blocked = userId ? await getBlockedUserIds(userId) : [];
  const where: Prisma.group_postsWhereInput = {
    groupId,
    isApproved: true,
    authorId: { notIn: blocked },
    author: { isBanned: false },
  };
  const [posts, total] = await prisma.$transaction([
    prisma.group_posts.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        author: { select: groupAuthorSelect },
        likes: { where: { userId: userId ?? '' }, select: { userId: true } },
      },
    }),
    prisma.group_posts.count({ where }),
  ]);
  return {
    posts: posts.map(({ likes, ...post }) => ({ ...post, isLiked: likes.length > 0 })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function createGroupPostRecord(groupId: string, userId: string, input: Record<string, unknown>) {
  await requireGroupAccess(groupId, userId);
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const mediaUrls = input.mediaUrls ?? [];
  if (
    content.length > 10_000 ||
    !Array.isArray(mediaUrls) ||
    mediaUrls.length > 10 ||
    mediaUrls.some((url) => typeof url !== 'string' || !/^https:\/\//i.test(url) || url.length > 2048) ||
    (!content && mediaUrls.length === 0)
  )
    throw httpError(400, 'Provide text or up to 10 HTTPS media URLs');
  if (input.mediaType !== undefined && (typeof input.mediaType !== 'string' || input.mediaType.length > 50))
    throw httpError(400, 'Invalid media type');
  return prisma.group_posts.create({
    data: {
      groupId,
      authorId: userId,
      content,
      mediaUrls: mediaUrls as string[],
      mediaType: input.mediaType as string | undefined,
    },
    include: { author: { select: groupAuthorSelect } },
  });
}

export async function toggleGroupPostReaction(groupId: string, postId: string, userId: string) {
  await requireGroupAccess(groupId, userId);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM group_posts WHERE id = ${postId} AND "groupId" = ${groupId} FOR UPDATE`;
    const post = await tx.group_posts.findFirst({ where: { id: postId, groupId, isApproved: true } });
    if (!post) throw httpError(404, 'Post not found');
    const existing = await tx.group_post_likes.findUnique({ where: { postId_userId: { postId, userId } } });
    if (existing) await tx.group_post_likes.delete({ where: { postId_userId: { postId, userId } } });
    else await tx.group_post_likes.create({ data: { postId, userId } });
    const updated = await tx.group_posts.update({
      where: { id: postId },
      data: { likesCount: { increment: existing ? -1 : 1 } },
    });
    return { liked: !existing, likesCount: updated.likesCount };
  });
}

export async function pinGroupPostRecord(groupId: string, postId: string, userId: string, isPinned: unknown) {
  const access = await requireGroupAccess(groupId, userId);
  if (!access.canModerate) throw httpError(403, 'Only group moderators can pin posts');
  if (typeof isPinned !== 'boolean') throw httpError(400, 'isPinned must be a boolean');
  const changed = await prisma.group_posts.updateMany({ where: { id: postId, groupId }, data: { isPinned } });
  if (!changed.count) throw httpError(404, 'Post not found');
  return prisma.group_posts.findUniqueOrThrow({
    where: { id: postId },
    include: { author: { select: groupAuthorSelect } },
  });
}

export async function deleteGroupPostRecord(groupId: string, postId: string, userId: string) {
  const access = await requireGroupAccess(groupId, userId);
  const post = await prisma.group_posts.findFirst({ where: { id: postId, groupId } });
  if (!post) throw httpError(404, 'Post not found');
  if (post.authorId !== userId && !access.canModerate) throw httpError(403, 'Not allowed to delete this post');
  await prisma.group_posts.deleteMany({ where: { id: postId, groupId } });
  return { success: true };
}
