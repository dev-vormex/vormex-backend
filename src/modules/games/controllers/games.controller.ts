/** Stable import surface; implementations are grouped by responsibility. */
export { getMyGameStats, getXPHistory, getLeaderboard } from './games/stats.controller';
export { getDailyTrivia, answerTriviaQuestion, getTriviaQuestions } from './games/trivia.controller';
export { getDailyWordle, guessWordle } from './games/wordle.controller';
export { getCodingProblems, getCodingProblem, submitCodingSolution } from './games/coding.controller';
export {
  createQuizBattle,
  getAvailableBattles,
  joinQuizBattle,
  getQuizBattle,
  answerBattleQuestion,
} from './games/battles.controller';
export { getTypingTexts, startTypingRace, finishTypingRace, getTypingHistory } from './games/typing.controller';
