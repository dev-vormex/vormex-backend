import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { spendCoins } from '../services/progress.service';

interface AuthRequest extends Request {
  user?: { userId: string };
}

type StoreCatalogItem = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  imageUrl?: string | null;
  category: string;
  type: string;
  xpCost: number;
  isFeatured?: boolean;
  metadata?: Record<string, unknown>;
  isActive: boolean;
  stock?: number;
};

const STORE_ITEMS: StoreCatalogItem[] = [
  {
    id: 'store-theme-aurora',
    slug: 'aurora-profile-theme',
    name: 'Aurora Theme',
    description: 'Add a soft aurora gradient to your public profile cards.',
    category: 'theme',
    type: 'profile_theme',
    xpCost: 240,
    isFeatured: true,
    isActive: true,
  },
  {
    id: 'store-frame-neon',
    slug: 'neon-profile-frame',
    name: 'Neon Frame',
    description: 'A glowing frame for your profile image and highlights.',
    category: 'frame',
    type: 'profile_frame',
    xpCost: 320,
    isFeatured: true,
    isActive: true,
  },
  {
    id: 'store-badge-founder',
    slug: 'founder-badge',
    name: 'Founder Badge',
    description: 'A limited badge for early builders on Vormex.',
    category: 'badge',
    type: 'exclusive_badge',
    xpCost: 420,
    isFeatured: true,
    isActive: true,
  },
  {
    id: 'store-effect-glow',
    slug: 'glow-name-effect',
    name: 'Glow Name Effect',
    description: 'Make your display name shimmer across the app.',
    category: 'effect',
    type: 'name_effect',
    xpCost: 180,
    isActive: true,
  },
  {
    id: 'store-chat-pack',
    slug: 'campus-chat-pack',
    name: 'Campus Chat Pack',
    description: 'Unlock themed reactions and message effects for chat.',
    category: 'chat_customization',
    type: 'chat_theme_pack',
    xpCost: 260,
    isActive: true,
  },
];

function serializeStoreItem(item: StoreCatalogItem) {
  return {
    ...item,
    price: item.xpCost,
    coinsCost: item.xpCost,
    isAvailable: item.isActive,
  };
}

function findStoreItem(itemSlugOrId: string | undefined): StoreCatalogItem | null {
  if (!itemSlugOrId) return null;

  return (
    STORE_ITEMS.find(
      (item) => item.slug === itemSlugOrId || item.id === itemSlugOrId
    ) ?? null
  );
}

function toBooleanQueryParam(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;

  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

// Get store items
export const getStoreItems = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { category, featured } = req.query;
    const featuredOnly = toBooleanQueryParam(featured);

    const items = STORE_ITEMS.filter((item) => {
      if (!item.isActive) return false;
      if (typeof category === 'string' && category.trim().length > 0 && item.category !== category) {
        return false;
      }
      if (featuredOnly !== null && Boolean(item.isFeatured) !== featuredOnly) {
        return false;
      }
      return true;
    }).map(serializeStoreItem);

    res.json(items);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch store items' });
  }
};

// Get store item by slug
export const getStoreItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const item = findStoreItem(slug);

    if (!item || !item.isActive) {
      res.status(404).json({ error: 'Store item not found' });
      return;
    }

    res.json(serializeStoreItem(item));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch store item' });
  }
};

// Get store categories
export const getStoreCategories = async (_req: Request, res: Response): Promise<void> => {
  try {
    const counts = STORE_ITEMS.filter((item) => item.isActive).reduce<Record<string, number>>(
      (accumulator, item) => {
        accumulator[item.category] = (accumulator[item.category] ?? 0) + 1;
        return accumulator;
      },
      {}
    );

    res.json(
      Object.entries(counts).map(([category, count]) => ({
        category,
        count,
      }))
    );
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
};

// Purchase item
export const purchaseItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const { itemSlug } = req.body as { itemSlug?: string };

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const item = findStoreItem(itemSlug);
    if (!item || !item.isActive) {
      res.status(404).json({ error: 'Store item not found' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const existingPurchase = await prisma.xp_transactions.findFirst({
      where: {
        userId,
        type: 'store_purchase',
        source: 'store',
        sourceId: item.slug,
      },
      select: { id: true },
    });

    if (existingPurchase) {
      res.status(400).json({ error: 'Item already owned' });
      return;
    }

    const { newBalance } = await spendCoins({
      userId,
      amount: item.xpCost,
      type: 'store_purchase',
      source: 'store',
      sourceId: item.slug,
      description: `Purchased ${item.name}`,
    });

    res.json({
      success: true,
      message: `${item.name} purchased successfully!`,
      item: serializeStoreItem(item),
      coinsSpent: item.xpCost,
      coinsBalance: newBalance,
      xpSpent: item.xpCost,
      newBalance,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Not enough Coins') {
      res.status(400).json({ error: 'Not enough Coins' });
      return;
    }
    res.status(500).json({ error: 'Failed to purchase item' });
  }
};

// Get user inventory
export const getInventory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transactions = await prisma.xp_transactions.findMany({
      where: {
        userId,
        type: 'store_purchase',
        source: 'store',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        sourceId: true,
        createdAt: true,
      },
    });

    const seen = new Set<string>();
    const inventory = transactions
      .map((transaction) => {
        const slug = transaction.sourceId;
        if (!slug || seen.has(slug)) return null;

        const item = findStoreItem(slug);
        if (!item) return null;

        seen.add(slug);

        return {
          id: transaction.id,
          userId: transaction.userId,
          itemType: item.type,
          itemSlug: item.slug,
          isEquipped: false,
          acquiredAt: transaction.createdAt.toISOString(),
          item: serializeStoreItem(item),
        };
      })
      .filter((item) => item !== null);

    res.json(inventory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
};

// Get purchase history
export const getPurchaseHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const transactions = await prisma.xp_transactions.findMany({
      where: {
        userId,
        type: 'store_purchase',
        source: 'store',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        amount: true,
        sourceId: true,
        createdAt: true,
      },
    });

    const purchases = transactions
      .map((transaction) => {
        const item = findStoreItem(transaction.sourceId ?? undefined);
        if (!item) return null;

        return {
          id: transaction.id,
          userId: transaction.userId,
          itemId: item.id,
          item: serializeStoreItem(item),
          coinsSpent: Math.abs(transaction.amount),
          xpSpent: Math.abs(transaction.amount),
          purchasedAt: transaction.createdAt.toISOString(),
        };
      })
      .filter((purchase) => purchase !== null);

    res.json(purchases);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch purchase history' });
  }
};

// Activate item
export const activateItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    const inventoryId = Array.isArray(req.params.inventoryId)
      ? req.params.inventoryId[0]
      : req.params.inventoryId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const inventoryItem = await prisma.xp_transactions.findFirst({
      where: {
        id: inventoryId,
        userId,
        type: 'store_purchase',
        source: 'store',
      },
      select: {
        sourceId: true,
      },
    });

    if (!inventoryItem) {
      res.status(404).json({ error: 'Inventory item not found' });
      return;
    }

    const item = findStoreItem(inventoryItem.sourceId ?? undefined);

    res.json({
      success: true,
      itemSlug: item?.slug ?? null,
      message: `${item?.name ?? 'Item'} is ready to use.`,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to activate item' });
  }
};

// Get Coins balance
export const getBalance = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinsBalance: true, xpBalance: true },
    });

    res.json(user?.coinsBalance || user?.xpBalance || 0);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
};
