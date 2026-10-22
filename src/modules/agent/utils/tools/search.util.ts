import { AgentToolExecutionContext, AgentToolResult } from "../../types";
import { getDiscoverableUsersWhere } from "../../../safety/services/trust-safety.service";
import { prisma } from "../../../../config/prisma";
import { getCurrentUserContext, buildConnectionMetadata, summarizeUser } from "./context.util";
import { clip } from "./support.util";
import { buildPeopleSearchTerms, queryRequestsCurrentUsersCampus, buildPeopleSearchClauses, scoreUserAgainstPeopleSearch, calculateDistanceKm, sharedInterests } from "./search-support.util";
import { actionRecord, switchTabIntent, showInlineResultsIntent } from "./policy.util";
import { agentUserSelect } from "./schemas.util";

export async function peopleSearchTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 8));
      const query = clip(args.query, 80) || '';
      const searchTerms = buildPeopleSearchTerms(query);
      const hasSearchTerms = searchTerms.length > 0;
      const nearbyOnly = Boolean(args.nearbyOnly);
      const sameCampusOnly = queryRequestsCurrentUsersCampus(query);
      const where: any = {
        id: { not: ctx.userId },
        isBanned: false,
        AND: [await getDiscoverableUsersWhere(ctx.userId)],
      };

      if (sameCampusOnly) {
        if (!currentUser?.college) {
          return {
            summary: 'I cannot filter by your campus yet because your college is missing from your profile.',
            output: {
              status: 'blocked',
              reason: 'current_user_college_missing',
            },
            blockedAction: actionRecord({
              type: 'people_search',
              toolName,
              status: 'blocked',
              title: 'Campus filter unavailable',
              summary: 'Your college is missing, so campus-only discovery is unavailable right now.',
            }),
          };
        }

        where.college = currentUser.college;
      }

      if (searchTerms.length > 0) {
        where.OR = buildPeopleSearchClauses(searchTerms);
      }

      const candidates = await prisma.user.findMany({
        where,
        orderBy: { lastActiveAt: 'desc' },
        take: nearbyOnly ? 50 : Math.max(limit * 6, 36),
        select: agentUserSelect,
      });
      const displayQuery = hasSearchTerms ? query : '';
      const { connectionStatusMap, mutualConnectionsMap } = await buildConnectionMetadata(
        ctx.userId,
        candidates.map((candidate) => candidate.id)
      );

      const people: any[] = candidates
        .map((user) => {
          const person = summarizeUser(
            user,
            currentUser,
            connectionStatusMap.get(user.id) || 'none',
            mutualConnectionsMap.get(user.id) || 0
          );
          const queryScore = hasSearchTerms ? scoreUserAgainstPeopleSearch(user, searchTerms) : 0;
          let distanceKm: number | null = null;
          if (
            nearbyOnly &&
            user.shareLocationPublic === true &&
            currentUser?.latitude !== null &&
            currentUser?.latitude !== undefined &&
            currentUser?.longitude !== null &&
            currentUser?.longitude !== undefined &&
            user.latitude !== null &&
            user.latitude !== undefined &&
            user.longitude !== null &&
            user.longitude !== undefined
          ) {
            distanceKm = calculateDistanceKm(
              Number(currentUser.latitude),
              Number(currentUser.longitude),
              Number(user.latitude),
              Number(user.longitude)
            );
          }

          return {
            ...person,
            distanceKm,
            queryScore,
          };
        })
        .filter(
          (item: any) =>
            (!nearbyOnly || item.distanceKm !== null) &&
            (!hasSearchTerms || item.queryScore > 0)
        )
        .sort((a: any, b: any) => {
          const overlapA = Array.isArray(a.sharedInterests) ? a.sharedInterests.length : 0;
          const overlapB = Array.isArray(b.sharedInterests) ? b.sharedInterests.length : 0;
          if (nearbyOnly) {
            return Number(a.distanceKm || 9999) - Number(b.distanceKm || 9999);
          }
          if (Number(b.queryScore || 0) !== Number(a.queryScore || 0)) {
            return Number(b.queryScore || 0) - Number(a.queryScore || 0);
          }
          return overlapB - overlapA;
        })
        .slice(0, limit)
        .map(({ queryScore: _queryScore, ...person }) => person);

      if (people.length === 0) {
        const fallbackSummary = nearbyOnly
          ? 'I could not find nearby people here, so I’m opening Find to look deeper.'
          : sameCampusOnly
            ? 'I could not find strong campus matches here, so I’m opening Find to look deeper.'
            : 'I could not find strong people here, so I’m opening Find to look deeper.';

        return {
          summary: fallbackSummary,
          output: {
            status: 'executed',
            people: [],
            totalCount: 0,
            hasMore: false,
          },
          executedAction: actionRecord({
            type: nearbyOnly ? 'people_nearby' : 'people_search',
            toolName,
            status: 'executed',
            title: nearbyOnly ? 'Checking nearby people in Find' : 'Checking people in Find',
            summary: fallbackSummary,
            uiIntents: [switchTabIntent('find')],
          }),
          uiIntents: [switchTabIntent('find')],
        };
      }

      const shownPeople = people.slice(0, 5);
      const summary = nearbyOnly
        ? `Found ${people.length} nearby people${displayQuery ? ` for "${displayQuery}"` : ''}.`
        : sameCampusOnly
          ? `Found ${people.length} people from ${currentUser?.college}${displayQuery ? ` for "${displayQuery}"` : ''}.`
          : `Found ${people.length} people${displayQuery ? ` for "${displayQuery}"` : ''}.`;
      const title = nearbyOnly
        ? 'Nearby people to check out'
        : sameCampusOnly
          ? 'People from your campus'
          : 'People worth opening';
      const subtitle = nearbyOnly
        ? displayQuery
          ? `Closest people for ${displayQuery}`
          : 'Best nearby matches without leaving this screen'
        : sameCampusOnly
          ? displayQuery
            ? `Top ${currentUser?.college} matches for ${displayQuery}`
            : `Best matches from ${currentUser?.college}`
          : displayQuery
            ? `Top matches for ${displayQuery}`
            : 'Best matches without leaving this screen';
      const inlinePayload = {
        resultType: 'people',
        title,
        subtitle,
        source: nearbyOnly ? 'people_nearby' : sameCampusOnly ? 'people_same_campus' : 'people_search',
        people: shownPeople,
        shownCount: shownPeople.length,
        totalCount: people.length,
        fallbackNavigationTarget: 'find_people',
      };

      return {
        summary,
        output: {
          status: 'executed',
          people: shownPeople,
          totalCount: people.length,
          hasMore: people.length > shownPeople.length,
        },
        executedAction: actionRecord({
          type: nearbyOnly ? 'people_nearby' : sameCampusOnly ? 'people_same_campus' : 'people_search',
          toolName,
          status: 'executed',
          title: nearbyOnly ? 'Found nearby people' : sameCampusOnly ? 'Found campus people' : 'Searched people',
          summary,
          uiIntents: [showInlineResultsIntent(inlinePayload)],
          payload: inlinePayload,
        }),
        uiIntents: [showInlineResultsIntent(inlinePayload)],
      };
    }

export async function matchingFindLikeMindedPeersTool(toolName: string, args: Record<string, any>, ctx: AgentToolExecutionContext, currentUser: Awaited<ReturnType<typeof getCurrentUserContext>>): Promise<AgentToolResult> {
      const limit = Math.min(10, Math.max(1, Number(args.limit) || 8));
      const focus = clip(args.focus, 80) || '';
      const existingConnections = await prisma.connections.findMany({
        where: {
          OR: [{ requesterId: ctx.userId }, { addresseeId: ctx.userId }],
        },
        select: {
          requesterId: true,
          addresseeId: true,
        },
      });
      const excludedIds = new Set<string>([ctx.userId]);
      existingConnections.forEach((connection) => {
        excludedIds.add(connection.requesterId);
        excludedIds.add(connection.addresseeId);
      });

      const candidates = await prisma.user.findMany({
        where: {
          id: { notIn: Array.from(excludedIds) },
          isBanned: false,
          AND: [await getDiscoverableUsersWhere(ctx.userId)],
        },
        orderBy: { lastActiveAt: 'desc' },
        take: Math.max(24, limit * 5),
        select: agentUserSelect,
      });
      const { connectionStatusMap, mutualConnectionsMap } = await buildConnectionMetadata(
        ctx.userId,
        candidates.map((candidate) => candidate.id)
      );

      const matches = candidates
        .map((user) => {
          const reasons: string[] = [];
          let score = 0;

          if (currentUser?.college && user.college === currentUser.college) {
            score += 25;
            reasons.push('same college');
          }
          if (currentUser?.branch && user.branch === currentUser.branch) {
            score += 15;
            reasons.push('same branch');
          }

          const overlap = sharedInterests(user.interests || [], currentUser?.interests || []);
          if (overlap.length > 0) {
            score += overlap.length * 10;
            reasons.push(`${overlap.length} shared interest${overlap.length > 1 ? 's' : ''}`);
          }

          if (
            currentUser?.user_onboarding?.primaryGoal &&
            currentUser.user_onboarding.primaryGoal === user.user_onboarding?.primaryGoal
          ) {
            score += 20;
            reasons.push('same goal');
          }

          const currentWantToLearn = currentUser?.user_onboarding?.wantToLearn || [];
          const currentCanTeach = currentUser?.user_onboarding?.canTeach || [];
          const candidateWantToLearn = user.user_onboarding?.wantToLearn || [];
          const candidateCanTeach = user.user_onboarding?.canTeach || [];

          if (sharedInterests(currentWantToLearn, candidateCanTeach).length > 0) {
            score += 12;
            reasons.push('can teach what you want to learn');
          }

          if (sharedInterests(currentCanTeach, candidateWantToLearn).length > 0) {
            score += 12;
            reasons.push('could benefit from what you can teach');
          }

          if (focus) {
            const searchable = [
              user.headline,
              user.bio,
              ...(user.interests || []),
              ...(user.skills || []).map((item: any) => item.skill?.name || ''),
            ]
              .join(' ')
              .toLowerCase();
            if (searchable.includes(focus.toLowerCase())) {
              score += 8;
              reasons.push(`aligned with ${focus}`);
            }
          }

          return {
            user: summarizeUser(
              user,
              currentUser,
              connectionStatusMap.get(user.id) || 'none',
              mutualConnectionsMap.get(user.id) || 0
            ),
            score,
            reasons,
          };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (matches.length === 0) {
        const fallbackSummary = focus
          ? `I could not find strong ${focus} matches here, so I’m opening Find to search deeper.`
          : 'I could not find strong like-minded matches here, so I’m opening Find to search deeper.';

        return {
          summary: fallbackSummary,
          output: {
            status: 'executed',
            matches: [],
            totalCount: 0,
            hasMore: false,
          },
          executedAction: actionRecord({
            type: 'match_people',
            toolName,
            status: 'executed',
            title: 'Searching deeper in Find',
            summary: fallbackSummary,
            uiIntents: [switchTabIntent('find')],
          }),
          uiIntents: [switchTabIntent('find')],
        };
      }

      const shownMatches = matches.slice(0, 5);
      const inlinePeople = shownMatches.map((match) => ({
        ...match.user,
        matchReasons: match.reasons,
        matchScore: match.score,
      }));
      const summary = `Ranked ${matches.length} like-minded peer matches${focus ? ` around ${focus}` : ''}.`;
      const inlinePayload = {
        resultType: 'people',
        title: focus ? `Best matches for ${focus}` : 'Like-minded people for you',
        subtitle: focus
          ? 'Top ranked peers without leaving this screen'
          : 'Top ranked peers based on your goals, interests, and network',
        source: 'matching_find_like_minded_peers',
        people: inlinePeople,
        shownCount: inlinePeople.length,
        totalCount: matches.length,
        fallbackNavigationTarget: 'find_people',
      };

      return {
        summary,
        output: {
          status: 'executed',
          matches: shownMatches,
          totalCount: matches.length,
          hasMore: matches.length > shownMatches.length,
        },
        executedAction: actionRecord({
          type: 'match_people',
          toolName,
          status: 'executed',
          title: 'Found like-minded peers',
          summary,
          uiIntents: [showInlineResultsIntent(inlinePayload)],
          payload: inlinePayload,
        }),
        uiIntents: [showInlineResultsIntent(inlinePayload)],
      };
    }
