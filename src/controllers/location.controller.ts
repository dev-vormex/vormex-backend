import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';
import { queueMatchAvailabilityNotifications } from '../services/match-availability-notification.service';
import { cacheService } from '../services/cache.service';
import {
  CoarseLocationDTO,
  serializeCoarseLocation,
} from '../utils/location-dto.util';

interface NearbyUser {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImage: string | null;
  headline: string | null;
  skills: string[];
  interests: string[];
  distanceBucket: string | null;
  isOnline: boolean;
  verified: boolean;
  isVerified: boolean;
  location: CoarseLocationDTO | null;
}

interface NearbyUsersResponse {
  users: NearbyUser[];
  locationRequired?: boolean;
  locationPermissionDenied?: boolean;
  total: number;
  yourLocation?: CoarseLocationDTO | null;
}

type NearbyDistanceRow = {
  id: string;
  distance: number | string;
};

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Get nearby users using GPS coordinates
 * GET /api/location/nearby
 */
export const getNearbyUsers = async (
  req: AuthenticatedRequest,
  res: Response<NearbyUsersResponse | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const radiusKm = Math.min(500, Math.max(1, parseInt(req.query.radius as string) || 50));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 30));

    // Get current user's location
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        latitude: true, 
        longitude: true, 
        currentCity: true,
        currentState: true,
        currentCountry: true,
        locationPermission: true,
      },
    });

    if (!currentUser || currentUser.latitude === null || currentUser.longitude === null) {
      res.status(200).json({
        users: [],
        locationRequired: true,
        total: 0,
      });
      return;
    }

    if (currentUser.locationPermission === false) {
      res.status(200).json({
        users: [],
        locationPermissionDenied: true,
        total: 0,
      });
      return;
    }

    const userLat = currentUser.latitude;
    const userLng = currentUser.longitude;

    // Calculate bounding box for initial filtering (rough approximation)
    // 1 degree latitude ≈ 111km
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.max(0.01, Math.abs(Math.cos(toRad(userLat)))));

    const nearbyDistanceRows = await prisma.$queryRaw<NearbyDistanceRow[]>(Prisma.sql`
      SELECT "id", "distance"
      FROM (
        SELECT
          "id",
          "lastActiveAt",
          6371 * 2 * ASIN(LEAST(1, SQRT(
            POWER(SIN(RADIANS(("latitude" - ${userLat}) / 2)), 2) +
            COS(RADIANS(${userLat})) * COS(RADIANS("latitude")) *
            POWER(SIN(RADIANS(("longitude" - ${userLng}) / 2)), 2)
          ))) AS "distance"
        FROM "users"
        WHERE "id" <> ${userId}
          AND "isBanned" = false
          AND "latitude" IS NOT NULL
          AND "longitude" IS NOT NULL
          AND "latitude" BETWEEN ${userLat - latDelta} AND ${userLat + latDelta}
          AND "longitude" BETWEEN ${userLng - lngDelta} AND ${userLng + lngDelta}
          AND COALESCE("locationPermission", true) = true
          AND "shareLocationPublic" = true
      ) ranked
      WHERE "distance" <= ${radiusKm}
      ORDER BY "distance" ASC, "lastActiveAt" DESC NULLS LAST, "id" ASC
      LIMIT ${limit}
    `);

    const nearbyIds = nearbyDistanceRows.map((row) => row.id);
    if (nearbyIds.length === 0) {
      res.status(200).json({
        users: [],
        total: 0,
        yourLocation: serializeCoarseLocation(currentUser),
      });
      return;
    }

    const distanceByUserId = new Map(
      nearbyDistanceRows.map((row) => [row.id, Number(row.distance)])
    );

    const usersInBox = await prisma.user.findMany({
      where: {
        id: { in: nearbyIds },
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        currentCity: true,
        currentState: true,
        currentCountry: true,
        isOnline: true,
        isVerified: true,
        profileBadgeStyle: true,
        interests: true,
        skills: {
          select: { skill: { select: { name: true } } },
        },
      },
    });

    const usersById = new Map(usersInBox.map((user) => [user.id, user]));
    const nearbyUsers: NearbyUser[] = nearbyIds
      .map((id) => usersById.get(id))
      .filter((user): user is NonNullable<typeof user> => Boolean(user))
      .map((user) => {
        const distance = distanceByUserId.get(user.id) ?? null;
        const location = serializeCoarseLocation(user, distance);
        return {
          id: user.id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
          bannerImage: user.bannerImageUrl,
          headline: user.headline,
          skills: user.skills.map((s) => s.skill.name),
          interests: user.interests,
          distanceBucket: location?.distanceBucket ?? null,
          isOnline: user.isOnline,
          verified: Boolean(user.isVerified),
          isVerified: Boolean(user.isVerified),
          profileBadgeStyle: user.profileBadgeStyle ?? null,
          location,
        };
      });

    res.status(200).json({
      users: nearbyUsers,
      total: nearbyUsers.length,
      yourLocation: serializeCoarseLocation(currentUser),
    });
  } catch (error) {
    console.error('Error fetching nearby users:', error);
    res.status(500).json({ error: 'Failed to fetch nearby users' });
  }
};

/**
 * Update user location with GPS coordinates
 * POST /api/location/update
 */
export const updateLocation = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string; location?: CoarseLocationDTO | null } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { lat, lng, accuracy, city, state, country, countryCode } = req.body;

    // Validate coordinates
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      res.status(400).json({ error: 'Valid latitude and longitude required' });
      return;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: 'Invalid coordinates' });
      return;
    }

    // Build location string
    let locationString = '';
    if (city && country) {
      locationString = `${city}, ${country}`;
    } else if (city) {
      locationString = city;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        latitude: lat,
        longitude: lng,
        locationAccuracy: accuracy || null,
        currentCity: city || null,
        currentState: state || null,
        currentCountry: country || null,
        currentCountryCode: countryCode || null,
        location: locationString || null,
        locationUpdatedAt: new Date(),
        lastLocationUpdate: new Date(),
        currentCoordinates: { lat, lng },
      },
      select: {
        currentCity: true,
        currentState: true,
        currentCountry: true,
      },
    });

    res.status(200).json({
      message: 'Location updated successfully',
      location: serializeCoarseLocation(updatedUser),
    });

    queueMatchAvailabilityNotifications(userId, 'location_update');
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
};

/**
 * Update location settings
 * PUT /api/location/settings
 */
export const updateLocationSettings = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const { shareLocationPublic, locationPermission } = req.body;

    if (shareLocationPublic !== undefined && typeof shareLocationPublic !== 'boolean') {
      res.status(400).json({ error: 'shareLocationPublic must be a boolean' });
      return;
    }

    if (locationPermission !== undefined && typeof locationPermission !== 'boolean') {
      res.status(400).json({ error: 'locationPermission must be a boolean' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        shareLocationPublic: shareLocationPublic ?? undefined,
        locationPermission: locationPermission ?? undefined,
      },
    });

    await cacheService.invalidateTags(`user:${userId}`, `people:user:${userId}`, `matching:user:${userId}`);

    res.status(200).json({ message: 'Location settings updated' });
  } catch (error) {
    console.error('Error updating location settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

/**
 * Get current location
 * GET /api/location/current
 */
export const getCurrentLocation = async (
  req: AuthenticatedRequest,
  res: Response<{ 
    location: CoarseLocationDTO | null;
    updatedAt: string | null;
    shareLocationPublic: boolean;
    locationPermission: boolean;
  } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        currentCity: true,
        currentState: true,
        currentCountry: true,
        locationUpdatedAt: true,
        shareLocationPublic: true,
        locationPermission: true,
      },
    });

    res.status(200).json({
      location: serializeCoarseLocation(user),
      updatedAt: user?.locationUpdatedAt?.toISOString() || null,
      shareLocationPublic: user?.shareLocationPublic ?? false,
      locationPermission: user?.locationPermission ?? true,
    });
  } catch (error) {
    console.error('Error getting location:', error);
    res.status(500).json({ error: 'Failed to get location' });
  }
};
