import { AuthenticatedRequest, ErrorResponse } from "../../../auth/types/auth.types";
import { Response } from "express";
import { getDiscoveryAccess, buildPremiumRequiredDiscoveryResponse, listSavedDiscoverySearches, createSavedDiscoverySearch, updateSavedDiscoverySearch, deleteSavedDiscoverySearch } from "../../services/discovery-power.service";
import { normalizeSearchText } from "./support.controller";

export const getSavedDiscoverySearches = async (
  req: AuthenticatedRequest,
  res: Response<{ searches: any[] } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searches = await listSavedDiscoverySearches(userId);
    res.status(200).json({ searches });
  } catch (error) {
    console.error('Error fetching saved discovery searches:', error);
    res.status(500).json({ error: 'Failed to fetch saved searches' });
  }
};

export const createSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ search: any } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const search = await createSavedDiscoverySearch(userId, req.body || {});
    res.status(201).json({ search });
  } catch (error) {
    console.error('Error creating saved discovery search:', error);
    res.status(500).json({ error: 'Failed to save search' });
  }
};

export const updateSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ search: any } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searchId = normalizeSearchText(req.params.id, 80);
    const search = await updateSavedDiscoverySearch(userId, searchId, req.body || {});
    if (!search) {
      res.status(404).json({ error: 'Saved search not found' });
      return;
    }

    res.status(200).json({ search });
  } catch (error) {
    console.error('Error updating saved discovery search:', error);
    res.status(500).json({ error: 'Failed to update saved search' });
  }
};

export const deleteSavedDiscoverySearchController = async (
  req: AuthenticatedRequest,
  res: Response<{ message: string } | ErrorResponse>
): Promise<void> => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userId = String(req.user.userId);
    const access = await getDiscoveryAccess(userId);
    if (!access.isPremium) {
      res.status(403).json(buildPremiumRequiredDiscoveryResponse('Saved discovery searches'));
      return;
    }

    const searchId = normalizeSearchText(req.params.id, 80);
    const deleted = await deleteSavedDiscoverySearch(userId, searchId);
    if (!deleted) {
      res.status(404).json({ error: 'Saved search not found' });
      return;
    }

    res.status(200).json({ message: 'Saved search deleted' });
  } catch (error) {
    console.error('Error deleting saved discovery search:', error);
    res.status(500).json({ error: 'Failed to delete saved search' });
  }
};
