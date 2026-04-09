import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  getStoreItems,
  getStoreItem,
  getStoreCategories,
  purchaseItem,
  getInventory,
  getPurchaseHistory,
  activateItem,
  getBalance,
} from '../controllers/store.controller';

const router = Router();

// Public routes
router.get('/items', getStoreItems);
router.get('/categories', getStoreCategories);
router.get('/items/:slug', getStoreItem);

// Protected routes
router.use(authenticate);

router.post('/purchase', purchaseItem);
router.get('/inventory', getInventory);
router.get('/history', getPurchaseHistory);
router.get('/purchases', getPurchaseHistory); // Alias
router.post('/inventory/:inventoryId/activate', activateItem);
router.get('/balance', getBalance);

export default router;
