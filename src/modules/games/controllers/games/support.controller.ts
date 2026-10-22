

export interface GameStats {
  id: string;
  userId: string;
  totalGamesPlayed: number;
  totalXpEarned: number;
  currentStreak: number;
  longestStreak: number;
  lastPlayedAt: string | null;
  triviaGamesPlayed: number;
  triviaCorrectAnswers: number;
  triviaTotalQuestions: number;
  triviaHighScore: number;
  codingProblemsAttempted: number;
  codingProblemsSolved: number;
  codingTotalSubmissions: number;
  wordleGamesPlayed: number;
  wordleGamesWon: number;
  wordleCurrentStreak: number;
  wordleBestStreak: number;
  wordleAverageAttempts: number;
  quizBattlesPlayed: number;
  quizBattlesWon: number;
  quizBattleWinRate: number;
  typingRacesCompleted: number;
  typingBestWpm: number;
  typingAverageWpm: number;
  typingBestAccuracy: number;
  currentXpBalance: number;
  currentCoinsBalance: number;
}

export interface LeaderboardEntry {
  rank: number;
  user: {
    id: string;
    name: string;
    username: string;
    profileImage: string | null;
  };
  xp: number;
  gamesPlayed: number;
  streak: number;
}

export interface XPTransaction {
  id: string;
  userId: string;
  amount: number;
  type: string;
  source: string;
  sourceId?: string;
  description?: string;
  createdAt: string;
  currency?: string;
  countsForStreak?: boolean;
}
