/** Stable import surface; implementations live in focused responsibility modules. */
export {
  ManagedAdPlacementName,
  ManagedAdEventType,
  MANAGED_AD_FEED_FIRST_AFTER_ITEMS,
  MANAGED_AD_FEED_INTERVAL_ITEMS,
  MANAGED_AD_REELS_FIRST_AFTER_ITEMS,
  MANAGED_AD_REELS_INTERVAL_ITEMS,
  MANAGED_AD_SIDEBAR_SLOT_KEY,
  ManagedAdSlot,
  ManagedAdPlacement,
  ManagedAdTargeting,
  managedAdSlotsForItemCount,
  matchesManagedAdTargeting,
  isManagedAdCtaAllowed,
} from './managed-ad/managed-ad-feed-first-after-items.service';
export {
  selectManagedAdPlacements,
  selectManagedAdSidebarPlacement,
  recordManagedAdEvent,
  invalidateManagedAdCaches,
} from './managed-ad/select-managed-ad-placements.service';
