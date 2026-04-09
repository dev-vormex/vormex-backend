import { Request, Response } from 'express';

interface AuthRequest extends Request {
  user?: { userId: string };
}

// Get interview categories
export const getCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json([
      { id: '1', name: 'Data Structures', slug: 'data-structures', questionCount: 50 },
      { id: '2', name: 'Algorithms', slug: 'algorithms', questionCount: 40 },
      { id: '3', name: 'System Design', slug: 'system-design', questionCount: 30 },
      { id: '4', name: 'Behavioral', slug: 'behavioral', questionCount: 25 },
      { id: '5', name: 'Frontend', slug: 'frontend', questionCount: 35 },
      { id: '6', name: 'Backend', slug: 'backend', questionCount: 35 },
    ]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

// Get category by slug
export const getCategoryBySlug = async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    res.json({
      id: '1',
      name: 'Data Structures',
      slug: slug,
      questionCount: 50,
      questions: [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch category' });
  }
};

// Get questions
export const getQuestions = async (req: Request, res: Response): Promise<void> => {
  try {
    const { categoryId, difficulty } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
};

// Get question by ID
export const getQuestion = async (req: Request, res: Response): Promise<void> => {
  try {
    const { questionId } = req.params;
    res.status(404).json({ error: 'Question not found' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch question' });
  }
};

// Start interview session
export const startSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { categoryId, difficulty, questionCount, duration } = req.body;

    res.json({
      session: {
        id: `session-${Date.now()}`,
        categoryId,
        difficulty,
        questionCount: questionCount || 5,
        duration: duration || 30,
        status: 'in_progress',
        startedAt: new Date().toISOString(),
      },
      questions: [],
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start session' });
  }
};

// Get my sessions
export const getMySessions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { status } = req.query;
    res.json([]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
};

// Get session by ID
export const getSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
};

// Submit response
export const submitResponse = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { sessionId, questionId, answer, duration } = req.body;

    res.json({
      success: true,
      feedback: null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit response' });
  }
};

// Complete session
export const completeSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { sessionId } = req.params;

    res.json({
      success: true,
      score: 0,
      xpEarned: 0,
      feedback: null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete session' });
  }
};

// Get my stats
export const getMyStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    res.json({
      totalSessions: 0,
      completedSessions: 0,
      averageScore: 0,
      strongCategories: [],
      weakCategories: [],
      totalTimeSpent: 0,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
};
