/**
 * Visibility and safety policy: pure business rules.
 *
 * This module is transport-agnostic (no Express, Socket.IO, agent, Prisma or
 * Redis imports). Callers load the facts (account state, block state) and ask a
 * question; the answer is a structured decision, never an HTTP response.
 * `trust-safety.service.ts` loads the facts for the interaction rules and maps
 * decisions to its existing `SafetyActionError` codes.
 *
 * Questions are deliberately kept separate:
 *   - evaluateAccountMayAct          Is this account allowed to perform operations?
 *   - evaluateInteraction            May actor act on target (message, request, comment...)?
 *   - evaluateProfileVisibility      May viewer see target's profile / content?
 *   - evaluateDiscoveryCandidate     May target appear in viewer's lists/search/nearby?
 *   - evaluateNotificationRecipient  Should recipient be notified about actor's action?
 *   - evaluateLocationVisibility     May viewer see target's location?
 *
 * See docs/architecture/domain/visibility-and-safety.md.
 */

export type DateLike = Date | string | number | null | undefined;

/** Account facts that drive ban / suspension / restriction decisions. */
export interface AccountSafetyState {
  isBanned?: boolean | null;
  safetySuspendedUntil?: DateLike;
  safetyRestrictedUntil?: DateLike;
}

export type SafetyDenialReason =
  | 'ACCOUNT_BANNED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_RESTRICTED'
  | 'TARGET_UNAVAILABLE'
  | 'BLOCKED'
  | 'SELF_NOTIFICATION';

/** `reason` is set whenever `allowed` is false. */
export interface SafetyDecision {
  allowed: boolean;
  reason?: SafetyDenialReason;
}

export const ALLOWED: SafetyDecision = Object.freeze({ allowed: true }) as SafetyDecision;

function deny(reason: SafetyDenialReason): SafetyDecision {
  return { allowed: false, reason };
}

function toTime(value: DateLike): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** True while the timestamp is strictly in the future (expired == not active). */
export function isActiveUntil(until: DateLike, now: Date = new Date()): boolean {
  const time = toTime(until);
  return time !== null && time > now.getTime();
}

export function isAccountSuspended(
  account: AccountSafetyState | null | undefined,
  now: Date = new Date()
): boolean {
  return isActiveUntil(account?.safetySuspendedUntil, now);
}

export function isAccountRestricted(
  account: AccountSafetyState | null | undefined,
  now: Date = new Date()
): boolean {
  return isActiveUntil(account?.safetyRestrictedUntil, now);
}

/** Banned or currently suspended: not available to other users. */
export function isAccountUnavailable(
  account: AccountSafetyState | null | undefined,
  now: Date = new Date()
): boolean {
  return Boolean(account?.isBanned) || isAccountSuspended(account, now);
}

/**
 * Is this account allowed to perform operations at all?
 * Ban wins over suspension, suspension over restriction. A missing account
 * record imposes no restriction (matches historic `assertUsersCanInteract`).
 * Restriction only matters for social actions, so callers opt in.
 */
export function evaluateAccountMayAct(
  account: AccountSafetyState | null | undefined,
  options: { now?: Date; includeRestricted?: boolean } = {}
): SafetyDecision {
  const now = options.now ?? new Date();
  if (account?.isBanned) return deny('ACCOUNT_BANNED');
  if (isAccountSuspended(account, now)) return deny('ACCOUNT_SUSPENDED');
  if (options.includeRestricted !== false && isAccountRestricted(account, now)) {
    return deny('ACCOUNT_RESTRICTED');
  }
  return ALLOWED;
}

export interface InteractionFacts {
  actorId: string;
  targetId: string;
  actor?: AccountSafetyState | null;
  target?: AccountSafetyState | null;
  /** True when a block exists in either direction (including device-scoped blocks). */
  blocked: boolean;
}

/**
 * May `actor` perform a social action (message, connection request, comment,
 * react, join...) toward `target`?
 *
 * Order is part of the contract (it decides which reason a caller sees):
 * actor ban, actor suspension, actor restriction, target unavailable, block.
 * Acting on yourself is never denied here.
 */
export function evaluateInteraction(
  facts: InteractionFacts,
  now: Date = new Date()
): SafetyDecision {
  if (!facts.actorId || !facts.targetId || facts.actorId === facts.targetId) return ALLOWED;

  const actorDecision = evaluateAccountMayAct(facts.actor, { now });
  if (!actorDecision.allowed) return actorDecision;
  if (isAccountUnavailable(facts.target, now)) return deny('TARGET_UNAVAILABLE');
  if (facts.blocked) return deny('BLOCKED');
  return ALLOWED;
}

export interface ProfileVisibilityFacts {
  viewerId: string;
  targetId: string;
  target?: AccountSafetyState | null;
  blocked: boolean;
}

/**
 * May `viewer` see `target`'s profile or user-authored content? Users always
 * see themselves. Restriction on the viewer does not hide content.
 * Callers should present TARGET_UNAVAILABLE and BLOCKED identically (as "not
 * found") so a block is not detectable.
 */
export function evaluateProfileVisibility(
  facts: ProfileVisibilityFacts,
  now: Date = new Date()
): SafetyDecision {
  if (!facts.viewerId || facts.viewerId === facts.targetId) return ALLOWED;
  if (isAccountUnavailable(facts.target, now)) return deny('TARGET_UNAVAILABLE');
  if (facts.blocked) return deny('BLOCKED');
  return ALLOWED;
}

export interface DiscoveryFacts {
  viewerId: string;
  candidateId: string;
  candidate?: AccountSafetyState | null;
  /** Ids blocked in either direction for the viewer (from getBlockedUserIds). */
  blockedUserIds: Iterable<string>;
}

/**
 * May `candidate` appear in `viewer`'s lists, search, suggestions or nearby
 * results? The viewer themselves is excluded from discovery.
 */
export function evaluateDiscoveryCandidate(
  facts: DiscoveryFacts,
  now: Date = new Date()
): SafetyDecision {
  if (facts.viewerId === facts.candidateId) return deny('SELF_NOTIFICATION');
  if (isAccountUnavailable(facts.candidate, now)) return deny('TARGET_UNAVAILABLE');
  const blocked = (facts.blockedUserIds instanceof Set
    ? (facts.blockedUserIds as Set<string>)
    : new Set<string>(facts.blockedUserIds)
  ).has(facts.candidateId);
  if (blocked) return deny('BLOCKED');
  return ALLOWED;
}

export interface NotificationFacts {
  actorId: string;
  recipientId: string;
  blocked: boolean;
}

/**
 * Should `recipient` be notified (in-app or push) about something `actor` did?
 * No self-notifications; no notifications across a block.
 */
export function evaluateNotificationRecipient(facts: NotificationFacts): SafetyDecision {
  if (facts.actorId === facts.recipientId) return deny('SELF_NOTIFICATION');
  if (facts.blocked) return deny('BLOCKED');
  return ALLOWED;
}

/**
 * May the viewer see the target's location? Owners always do; everyone else
 * only when the target opted in with `shareLocationPublic`. Mirrors the rule in
 * profile.service.ts (`isOwner || shareLocationPublic === true`).
 */
export function evaluateLocationVisibility(facts: {
  isOwner: boolean;
  shareLocationPublic?: boolean | null;
}): boolean {
  return facts.isOwner || facts.shareLocationPublic === true;
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Prisma `where` fragment for "users that may appear in discovery for a
 * viewer". Plain object so this module stays Prisma-free; spread into a
 * `where` or `AND` array. Mirrors evaluateDiscoveryCandidate.
 */
export function discoverableUsersWhere(
  viewerId: string,
  blockedUserIds: readonly string[],
  now: Date = new Date()
) {
  return {
    isBanned: false,
    id: { notIn: uniqueIds([viewerId, ...blockedUserIds]) },
    OR: [{ safetySuspendedUntil: null }, { safetySuspendedUntil: { lte: now } }],
  };
}
