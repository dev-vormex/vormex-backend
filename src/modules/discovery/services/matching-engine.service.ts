/** Stable import surface; implementations live in focused responsibility modules. */
export {
  MatchFilterType,
  MatchNotificationSource,
  MatchReasonKey,
  MatchingScorecardItem,
  MatchingWhyMatched,
  MatchingSharedSignals,
  MatchingScore,
  MatchingSignalUser,
  MATCHING_ENGINE_USER_SELECT,
  collectSkillNames,
  collectSkillsToLearn,
  collectInterests,
  collectGoals,
} from './matching-engine/matching-engine-user-select.service';
export {
  scoreUserMatch,
  rankUserMatches,
  getConnectedOrPendingUserIds,
} from './matching-engine/score-user-match.service';
export {
  buildMatchingCandidateWhere,
  getMatchNotificationCooldownHours,
  getMatchNotificationLookbackDays,
  getMatchNotificationMaxRecipients,
  getStrongMatchThreshold,
  isStrongMatch,
  buildRecommendedMatchCopy,
  serializeMatchedUser,
} from './matching-engine/build-matching-candidate-where.service';
