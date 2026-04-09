import { Response } from 'express';
import { AuthenticatedRequest, ErrorResponse } from '../types/auth.types';
import { prisma } from '../config/prisma';

interface NearbyUser {
  id: string;
  username: string;
  name: string;
  profileImage: string | null;
  bannerImage: string | null;
  headline: string | null;
  skills: string[];
  interests: string[];
  distance: number;
  isOnline: boolean;
  location: {
    lat: number;
    lng: number;
    city: string | null;
    state: string | null;
    country: string | null;
  } | null;
}

interface NearbyUsersResponse {
  users: NearbyUser[];
  locationRequired?: boolean;
  locationPermissionDenied?: boolean;
  total: number;
  yourLocation?: {
    lat: number;
    lng: number;
    city: string | null;
  };
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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

    const userLat = currentUser.latitude;
    const userLng = currentUser.longitude;

    // Calculate bounding box for initial filtering (rough approximation)
    // 1 degree latitude ≈ 111km
    const latDelta = radiusKm / 111;
    const lngDelta = radiusKm / (111 * Math.cos(toRad(userLat)));

    // Get users within bounding box who have location data
    const usersInBox = await prisma.user.findMany({
      where: {
        id: { not: userId },
        isBanned: false,
        latitude: { 
          gte: userLat - latDelta,
          lte: userLat + latDelta,
        },
        longitude: {
          gte: userLng - lngDelta,
          lte: userLng + lngDelta,
        },
        locationPermission: { not: false },
        shareLocationPublic: true,
      },
      select: {
        id: true,
        username: true,
        name: true,
        profileImage: true,
        bannerImageUrl: true,
        headline: true,
        latitude: true,
        longitude: true,
        currentCity: true,
        currentState: true,
        currentCountry: true,
        isOnline: true,
        interests: true,
        skills: {
          select: { skill: { select: { name: true } } },
        },
      },
    });

    // Calculate actual distances and filter by radius
    const nearbyUsers: NearbyUser[] = usersInBox
      .map((user) => {
        const distance = calculateDistance(
          userLat,
          userLng,
          user.latitude!,
          user.longitude!
        );
        return {
          id: user.id,
          username: user.username,
          name: user.name,
          profileImage: user.profileImage,
          bannerImage: user.bannerImageUrl,
          headline: user.headline,
          skills: user.skills.map((s) => s.skill.name),
          interests: user.interests,
          distance: Math.round(distance * 10) / 10, // Round to 1 decimal
          isOnline: user.isOnline,
          location: user.latitude && user.longitude ? {
            lat: user.latitude,
            lng: user.longitude,
            city: user.currentCity,
            state: user.currentState,
            country: user.currentCountry,
          } : null,
        };
      })
      .filter((user) => user.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    res.status(200).json({
      users: nearbyUsers,
      total: nearbyUsers.length,
      yourLocation: {
        lat: userLat,
        lng: userLng,
        city: currentUser.currentCity,
      },
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
  res: Response<{ message: string; location?: any } | ErrorResponse>
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
        shareLocationPublic: true, // Enable by default when user shares location
      },
      select: {
        latitude: true,
        longitude: true,
        currentCity: true,
        currentCountry: true,
      },
    });

    res.status(200).json({
      message: 'Location updated successfully',
      location: {
        lat: updatedUser.latitude,
        lng: updatedUser.longitude,
        city: updatedUser.currentCity,
        country: updatedUser.currentCountry,
      },
    });
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

    await prisma.user.update({
      where: { id: userId },
      data: {
        shareLocationPublic: shareLocationPublic ?? undefined,
        locationPermission: locationPermission ?? undefined,
      },
    });

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
    lat: number | null; 
    lng: number | null;
    city: string | null; 
    state: string | null;
    country: string | null;
    updatedAt: string | null;
    shareLocationPublic: boolean;
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
        latitude: true,
        longitude: true,
        currentCity: true,
        currentState: true,
        currentCountry: true,
        locationUpdatedAt: true,
        shareLocationPublic: true,
      },
    });

    res.status(200).json({
      lat: user?.latitude || null,
      lng: user?.longitude || null,
      city: user?.currentCity || null,
      state: user?.currentState || null,
      country: user?.currentCountry || null,
      updatedAt: user?.locationUpdatedAt?.toISOString() || null,
      shareLocationPublic: user?.shareLocationPublic ?? false,
    });
  } catch (error) {
    console.error('Error getting location:', error);
    res.status(500).json({ error: 'Failed to get location' });
  }
};
