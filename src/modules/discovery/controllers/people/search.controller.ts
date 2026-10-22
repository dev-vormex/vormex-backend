import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getBlockedUserIds } from "../../../safety/services/trust-safety.service";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { prismaRead } from "../../../../config/prisma";
import { getPremiumVisibilityByUserIds } from "../../../premium/services/premium-visibility.service";
import { cacheService } from "../../../../infrastructure/cache/cache.service";
import { PeopleResponse, normalizeSearchText, PEOPLE_MIN_TEXT_SEARCH_LENGTH, decodePeopleSearchCursor, parseBoundedInt, PEOPLE_SEARCH_DEFAULT_LIMIT, PEOPLE_SEARCH_MAX_LIMIT, PEOPLE_CACHE_VERSION, shouldBypassPeopleCache, PeopleSearchRankRow, personCardUserSelectWithCursor, getRelationshipSummary, mapUserToPersonCard, encodePeopleSearchCursor, peopleCacheTags, PEOPLE_AUTH_CACHE_TTL_SECONDS, recordPeopleSearchAppearancesIfNeeded } from "./support.controller";

/**
 * Global indexed people search.
 * GET /api/people/search?q=&cursor=&limit=20
 */
export const searchPeople = async (
  req: AuthenticatedRequest,
  res: Response<PeopleResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const normalizedQuery = normalizeSearchText(req.query.q, 80).toLowerCase();
    if (normalizedQuery.length < PEOPLE_MIN_TEXT_SEARCH_LENGTH) {
      res.status(200).json({
        people: [],
        total: 0,
        page: 1,
        totalPages: 1,
        hasMore: false,
        nextCursor: null,
      });
      return;
    }

    const cursor = decodePeopleSearchCursor(req.query.cursor, normalizedQuery);
    if (req.query.cursor && !cursor) {
      res.status(400).json({ error: 'Invalid or expired search cursor' });
      return;
    }
    if (cursor?.n === undefined) {
      if (req.query.cursor) {
        res.status(400).json({ error: 'Invalid search cursor' });
        return;
      }
    }

    const cursorDate = cursor?.t ? new Date(cursor.t) : null;
    if (cursorDate && Number.isNaN(cursorDate.getTime())) {
      res.status(400).json({ error: 'Invalid search cursor' });
      return;
    }

    const limit = parseBoundedInt(
      req.query.limit,
      PEOPLE_SEARCH_DEFAULT_LIMIT,
      1,
      PEOPLE_SEARCH_MAX_LIMIT
    );
    const blockedUserIds = await getBlockedUserIds(userId);
    const blockedClause = blockedUserIds.length
      ? Prisma.sql`AND u."id" NOT IN (${Prisma.join(blockedUserIds)})`
      : Prisma.empty;
    const cursorClause = !cursor
      ? Prisma.empty
      : cursorDate
        ? Prisma.sql`WHERE (
            "rank" < ${cursor.n!}
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" < ${cursorDate})
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" = ${cursorDate} AND "id" > ${cursor.id})
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" IS NULL)
          )`
        : Prisma.sql`WHERE (
            "rank" < ${cursor.n!}
            OR ("rank" = ${cursor.n!} AND "lastActiveAt" IS NULL AND "id" > ${cursor.id})
          )`;

    const queryHash = createHash('sha256')
      .update(`${normalizedQuery}|${String(req.query.cursor || '')}|${limit}`)
      .digest('hex')
      .slice(0, 32);
    const cacheKey = `people:search:${PEOPLE_CACHE_VERSION}:user:${userId}:${queryHash}`;
    const bypassCache = shouldBypassPeopleCache(req);

    const computeResponse = async (): Promise<PeopleResponse> => {
      const rankedRows = await prismaRead.$queryRaw<PeopleSearchRankRow[]>(Prisma.sql`
        WITH ranked_people AS (
          SELECT
            u."id",
            u."lastActiveAt",
            (
              CASE
                WHEN lower(u."username") = ${normalizedQuery} THEN 1000
                WHEN lower(u."name") = ${normalizedQuery} THEN 900
                WHEN lower(u."username") LIKE ${`${normalizedQuery}%`} THEN 800
                WHEN lower(u."name") LIKE ${`${normalizedQuery}%`} THEN 700
                WHEN lower(COALESCE(u."college", '')) = ${normalizedQuery} THEN 600
                WHEN lower(COALESCE(u."college", '')) LIKE ${`${normalizedQuery}%`} THEN 550
                ELSE 100
              END
              + COALESCE(ts_rank_cd(d."searchVector", websearch_to_tsquery('english', ${normalizedQuery})), 0) * 100
            )::double precision AS "rank"
          FROM "users" u
          LEFT JOIN "discovery_documents" d
            ON d."entityType" = 'profile' AND d."entityId" = u."id"
          WHERE u."id" <> ${userId}
            AND u."isBanned" = false
            ${blockedClause}
            AND (
              lower(u."username") = ${normalizedQuery}
              OR lower(u."name") = ${normalizedQuery}
              OR lower(u."username") LIKE ${`${normalizedQuery}%`}
              OR lower(u."name") LIKE ${`${normalizedQuery}%`}
              OR lower(COALESCE(u."college", '')) LIKE ${`${normalizedQuery}%`}
              OR d."searchVector" @@ websearch_to_tsquery('english', ${normalizedQuery})
            )
        )
        SELECT "id", "rank", "lastActiveAt"
        FROM ranked_people
        ${cursorClause}
        ORDER BY "rank" DESC, "lastActiveAt" DESC NULLS LAST, "id" ASC
        LIMIT ${limit + 1}
      `);

      const pageRows = rankedRows.slice(0, limit);
      const users = pageRows.length
        ? await prismaRead.user.findMany({
            where: { id: { in: pageRows.map((row) => row.id) }, isBanned: false },
            select: personCardUserSelectWithCursor,
          })
        : [];
      const userById = new Map(users.map((user) => [user.id, user]));
      const orderedUsers = pageRows.flatMap((row) => {
        const user = userById.get(row.id);
        return user ? [user] : [];
      });
      const [visibilityByUser, relationship] = await Promise.all([
        getPremiumVisibilityByUserIds(orderedUsers.map((user) => user.id)),
        getRelationshipSummary(userId, orderedUsers.map((user) => user.id), false),
      ]);
      const people = orderedUsers.map((user) =>
        mapUserToPersonCard(user, relationship, visibilityByUser)
      );
      const hasMore = rankedRows.length > limit;
      const boundary = pageRows[pageRows.length - 1];

      return {
        people,
        total: people.length + (hasMore ? 1 : 0),
        page: 1,
        totalPages: hasMore ? 2 : 1,
        hasMore,
        nextCursor: hasMore && boundary
          ? encodePeopleSearchCursor(boundary, normalizedQuery)
          : null,
        totalIsApproximate: true,
      };
    };

    const response = bypassCache
      ? await computeResponse()
      : await cacheService.getOrSet(cacheKey, computeResponse, {
          tags: peopleCacheTags(userId),
          swr: {
            softTtlSeconds: PEOPLE_AUTH_CACHE_TTL_SECONDS,
            hardTtlSeconds: PEOPLE_AUTH_CACHE_TTL_SECONDS * 4,
          },
        });

    void recordPeopleSearchAppearancesIfNeeded(
      userId,
      { ...req.query, search: normalizedQuery },
      response.people
    );
    res.setHeader('X-Vormex-Cache', bypassCache ? 'BYPASS' : 'MISS');
    res.status(200).json(response);
  } catch (error) {
    console.error('Error searching people:', error);
    res.status(500).json({ error: 'Failed to search people' });
  }
};
