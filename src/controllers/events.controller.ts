import { Response } from 'express';
import { prisma } from '../config/prisma';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { decorateSurfaceRecommendations } from '../services/surface-recommendation.service';
import { recordAuthoritativeRecommendationOutcome } from '../services/recommendation-platform.service';

const EVENT_TYPES = new Set([
  'meetup',
  'study_session',
  'hackathon',
  'workshop',
  'talk',
  'social',
]);

const RSVP_STATUSES = new Set(['going', 'interested', 'not_going']);
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

type EventResponse = {
  id: string;
  title: string;
  description: string;
  type: string;
  campus: string;
  venue: string | null;
  isOnline: boolean;
  meetingLink: string | null;
  startsAt: Date;
  endsAt: Date;
  maxAttendees: number | null;
  attendeesCount: number;
  organizerId: string;
  circleId: string | null;
  coverImageUrl: string | null;
  tags: string[];
  myStatus: string | null;
  circle: {
    id: string;
    name: string;
    emoji: string;
    slug: string;
  } | null;
  attendeesPreview: Array<{
    id: string;
    name: string;
    profileImage: string | null;
  }>;
  createdAt: Date;
};

function toPositiveInt(value: unknown, fallback: number, max = MAX_PAGE_SIZE): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanOptionalString(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  return cleaned || undefined;
}

function getParamString(value: unknown): string {
  if (Array.isArray(value)) {
    return cleanString(value[0]);
  }
  return cleanString(value);
}

function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((tag) => cleanString(tag))
        .filter(Boolean)
        .slice(0, 10)
    )
  );
}

function getUserId(req: AuthenticatedRequest): string | null {
  return req.user?.userId ? String(req.user.userId) : null;
}

async function getMyStatusByEventId(eventIds: string[], userId: string | null): Promise<Map<string, string>> {
  if (!userId || eventIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.event_attendees.findMany({
    where: {
      userId,
      eventId: { in: eventIds },
    },
    select: {
      eventId: true,
      status: true,
    },
  });

  return new Map(rows.map((row) => [row.eventId, row.status]));
}

async function serializeEvents(events: any[], userId: string | null): Promise<EventResponse[]> {
  const myStatuses = await getMyStatusByEventId(
    events.map((event) => event.id),
    userId
  );

  return events.map((event) => ({
    id: event.id,
    title: event.title,
    description: event.description,
    type: event.type,
    campus: event.campus,
    venue: event.venue,
    isOnline: event.isOnline,
    meetingLink: event.meetingLink,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    maxAttendees: event.maxAttendees,
    attendeesCount: event.attendeesCount,
    organizerId: event.organizerId,
    circleId: event.circleId,
    coverImageUrl: event.coverImageUrl,
    tags: event.tags || [],
    myStatus: myStatuses.get(event.id) || null,
    circle: event.circles
      ? {
          id: event.circles.id,
          name: event.circles.name,
          emoji: event.circles.emoji || '',
          slug: event.circles.slug,
        }
      : null,
    attendeesPreview: (event.event_attendees || []).map((attendee: any) => ({
      id: attendee.users.id,
      name: attendee.users.name,
      profileImage: attendee.users.profileImage,
    })),
    createdAt: event.createdAt,
  }));
}

function eventInclude(previewLimit = 3) {
  return {
    circles: {
      select: {
        id: true,
        name: true,
        emoji: true,
        slug: true,
      },
    },
    event_attendees: {
      where: { status: 'going' },
      orderBy: { joinedAt: 'desc' as const },
      take: previewLimit,
      include: {
        users: {
          select: {
            id: true,
            name: true,
            profileImage: true,
          },
        },
      },
    },
  };
}

export const listEvents = async (
  req: AuthenticatedRequest,
  res: Response<{ events: EventResponse[]; total: number; page: number; totalPages: number } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const page = toPositiveInt(req.query.page, 1);
    const limit = toPositiveInt(req.query.limit, PAGE_SIZE);
    const type = cleanOptionalString(req.query.type);
    const campus = cleanOptionalString(req.query.campus);
    const upcoming = String(req.query.upcoming || '').toLowerCase() === 'true';

    const where: any = {};
    if (campus) {
      where.campus = { equals: campus, mode: 'insensitive' };
    }
    if (type && type !== 'all') {
      where.type = type;
    }
    if (upcoming) {
      where.endsAt = { gte: new Date() };
    }

    const [events, total] = await Promise.all([
      prisma.campus_events.findMany({
        where,
        orderBy: { startsAt: upcoming ? 'asc' : 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: eventInclude(),
      }),
      prisma.campus_events.count({ where }),
    ]);

    const serialized = await serializeEvents(events, userId);
    const decorated = userId ? await decorateSurfaceRecommendations({
      userId,
      surface: 'EVENTS',
      entityType: 'EVENT',
      items: serialized,
      createdAtOf: (event) => event.startsAt,
      pageSize: serialized.length || 1,
    }) : { items: serialized };
    res.json({
      events: decorated.items,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      recommendationSessionId: decorated.recommendationSessionId,
      requestId: decorated.requestId,
      rankerVersion: decorated.rankerVersion,
      experimentVariant: decorated.experimentVariant,
    } as any);
  } catch (error) {
    console.error('List events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
};

export const getUpcomingEvents = async (
  req: AuthenticatedRequest,
  res: Response<{ events: EventResponse[] } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const campus = cleanOptionalString(req.query.campus);
    const where: any = {
      endsAt: { gte: new Date() },
    };

    if (campus) {
      where.campus = { equals: campus, mode: 'insensitive' };
    }

    const events = await prisma.campus_events.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 10,
      include: eventInclude(),
    });

    const serialized = await serializeEvents(events, userId);
    const decorated = userId ? await decorateSurfaceRecommendations({
      userId,
      surface: 'EVENTS',
      entityType: 'EVENT',
      items: serialized,
      createdAtOf: (event) => event.startsAt,
      pageSize: serialized.length || 1,
    }) : { items: serialized };
    res.json({
      events: decorated.items,
      recommendationSessionId: decorated.recommendationSessionId,
      requestId: decorated.requestId,
      rankerVersion: decorated.rankerVersion,
      experimentVariant: decorated.experimentVariant,
    } as any);
  } catch (error) {
    console.error('Get upcoming events error:', error);
    res.status(500).json({ error: 'Failed to fetch upcoming events' });
  }
};

export const getMyEvents = async (
  req: AuthenticatedRequest,
  res: Response<{ events: EventResponse[] } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const attendeeRows = await prisma.event_attendees.findMany({
      where: {
        userId,
        status: { in: ['going', 'interested'] },
      },
      select: { eventId: true },
    });

    const events = await prisma.campus_events.findMany({
      where: {
        OR: [
          { organizerId: userId },
          { id: { in: attendeeRows.map((row) => row.eventId) } },
        ],
      },
      orderBy: { startsAt: 'asc' },
      include: eventInclude(),
    });

    res.json({ events: await serializeEvents(events, userId) });
  } catch (error) {
    console.error('Get my events error:', error);
    res.status(500).json({ error: 'Failed to fetch your events' });
  }
};

export const getEvent = async (
  req: AuthenticatedRequest,
  res: Response<{ event: EventResponse & { attendeesList: Array<{ id: string; name: string; profileImage: string | null; status: string }> } } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    const eventId = getParamString(req.params.eventId);

    const event = await prisma.campus_events.findUnique({
      where: { id: eventId },
      include: eventInclude(12),
    });

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const [serialized] = await serializeEvents([event], userId);
    const attendees = await prisma.event_attendees.findMany({
      where: {
        eventId,
        status: { in: ['going', 'interested'] },
      },
      orderBy: { joinedAt: 'desc' },
      take: 100,
      include: {
        users: {
          select: {
            id: true,
            name: true,
            profileImage: true,
          },
        },
      },
    }) as any[];

    res.json({
      event: {
        ...serialized,
        attendeesList: attendees.map((attendee) => ({
          id: attendee.users.id,
          name: attendee.users.name,
          profileImage: attendee.users.profileImage,
          status: attendee.status,
        })),
      },
    });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
};

export const createEvent = async (
  req: AuthenticatedRequest,
  res: Response<{ event: EventResponse } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const title = cleanString(req.body.title);
    const description = cleanString(req.body.description);
    const type = cleanString(req.body.type || 'meetup');
    const campus = cleanString(req.body.campus);
    const startsAt = new Date(req.body.startsAt);
    const endsAt = new Date(req.body.endsAt);
    const maxAttendees = req.body.maxAttendees ? Number(req.body.maxAttendees) : null;

    if (!title || !description || !campus || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
      res.status(400).json({ error: 'Title, description, campus, startsAt, and endsAt are required' });
      return;
    }

    if (!EVENT_TYPES.has(type)) {
      res.status(400).json({ error: 'Invalid event type' });
      return;
    }

    if (endsAt <= startsAt) {
      res.status(400).json({ error: 'Event end time must be after start time' });
      return;
    }

    if (maxAttendees !== null && (!Number.isInteger(maxAttendees) || maxAttendees < 1)) {
      res.status(400).json({ error: 'maxAttendees must be a positive number' });
      return;
    }

    const circleId = cleanOptionalString(req.body.circleId);
    if (circleId) {
      const circle = await prisma.circles.findUnique({
        where: { id: circleId },
        select: { id: true },
      });

      if (!circle) {
        res.status(404).json({ error: 'Circle not found' });
        return;
      }
    }

    const event = await prisma.campus_events.create({
      data: {
        title,
        description,
        type,
        campus,
        venue: cleanOptionalString(req.body.venue),
        isOnline: Boolean(req.body.isOnline),
        meetingLink: cleanOptionalString(req.body.meetingLink),
        startsAt,
        endsAt,
        maxAttendees,
        organizerId: userId,
        circleId,
        coverImageUrl: cleanOptionalString(req.body.coverImageUrl),
        tags: cleanTags(req.body.tags),
        event_attendees: {
          create: {
            userId,
            status: 'going',
          },
        },
        attendeesCount: 1,
      },
      include: eventInclude(),
    });

    const [serialized] = await serializeEvents([event], userId);
    res.status(201).json({ event: serialized });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
};

export const rsvpToEvent = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string; status: string | null; attendeesCount: number } | ErrorResponse>
): Promise<void> => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const eventId = getParamString(req.params.eventId);
    const status = cleanString(req.body.status || 'going');

    if (!RSVP_STATUSES.has(status)) {
      res.status(400).json({ error: 'Invalid RSVP status' });
      return;
    }

    const event = await prisma.campus_events.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        maxAttendees: true,
        attendeesCount: true,
        endsAt: true,
      },
    });

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.endsAt < new Date()) {
      res.status(400).json({ error: 'Cannot RSVP to a past event' });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.event_attendees.findUnique({
        where: {
          eventId_userId: {
            eventId,
            userId,
          },
        },
      });

      const wasGoing = existing?.status === 'going';
      const nowGoing = status === 'going';
      const currentGoingCount = await tx.event_attendees.count({
        where: {
          eventId,
          status: 'going',
        },
      });

      if (
        nowGoing &&
        !wasGoing &&
        event.maxAttendees !== null &&
        currentGoingCount >= event.maxAttendees
      ) {
        return { full: true, attendeesCount: currentGoingCount };
      }

      if (status === 'not_going') {
        if (existing) {
          await tx.event_attendees.delete({
            where: {
              eventId_userId: {
                eventId,
                userId,
              },
            },
          });
        }
      } else {
        await tx.event_attendees.upsert({
          where: {
            eventId_userId: {
              eventId,
              userId,
            },
          },
          update: {
            status,
            joinedAt: new Date(),
          },
          create: {
            eventId,
            userId,
            status,
          },
        });
      }

      const attendeesCount = await tx.event_attendees.count({
        where: {
          eventId,
          status: 'going',
        },
      });

      await tx.campus_events.update({
        where: { id: eventId },
        data: { attendeesCount },
      });

      return { full: false, attendeesCount };
    });

    if (result.full) {
      res.status(409).json({ error: 'Event is full' });
      return;
    }

    if (status === 'going' || status === 'interested') {
      void recordAuthoritativeRecommendationOutcome({
        userId, entityType: 'EVENT', entityId: eventId, eventType: 'EVENT_JOIN', meaningfulOutcome: true,
      }).catch(() => undefined);
    }

    res.json({
      message: status === 'not_going' ? 'RSVP removed' : 'RSVP updated',
      status: status === 'not_going' ? null : status,
      attendeesCount: result.attendeesCount,
    });
  } catch (error) {
    console.error('RSVP event error:', error);
    res.status(500).json({ error: 'Failed to update RSVP' });
  }
};
