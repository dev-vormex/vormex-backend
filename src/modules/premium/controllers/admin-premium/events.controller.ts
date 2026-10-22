import { Response } from "express";
import { prisma } from "../../../../config/prisma";
import { formatCurrency } from "../../services/premium-access.service";
import { AuthRequest, parsePositiveInt, PremiumEventsFilter, normalizeSearch, mapEventFilterToWhere, buildEventPaymentRef } from "./support.controller";

export const getPremiumAdminEvents = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const page = parsePositiveInt(req.query.page, 1);
    const limit = parsePositiveInt(req.query.limit, 20);
    const filter = String(req.query.filter || 'all') as PremiumEventsFilter;
    const search = normalizeSearch(req.query.search);
    const skip = (page - 1) * limit;

    const where: any = {
      ...mapEventFilterToWhere(filter),
    };

    if (search) {
      where.OR = [
        {
          message: {
            contains: search,
            mode: 'insensitive',
          },
        },
        {
          user: {
            is: {
              name: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
        {
          user: {
            is: {
              email: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
        {
          user: {
            is: {
              username: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        },
      ];
    }

    const [events, total] = await Promise.all([
      prisma.premium_checkout_events.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          eventType: true,
          outcome: true,
          message: true,
          amountMinor: true,
          currency: true,
          metadata: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
            },
          },
        },
      }),
      prisma.premium_checkout_events.count({ where }),
    ]);

    res.json({
      events: events.map((event) => ({
        ...event,
        displayAmount:
          typeof event.amountMinor === 'number' && event.currency
            ? formatCurrency(event.amountMinor, event.currency)
            : null,
        payment: buildEventPaymentRef(event.metadata),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('getPremiumAdminEvents error:', error);
    res.status(500).json({ error: 'Failed to load premium events' });
  }
};
