import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import {
  sendConnectionRequest,
  acceptConnectionRequest,
  rejectConnectionRequest,
  cancelConnectionRequest,
  cancelSentRequestToUser,
  removeConnection,
  getConnections,
  getUserConnections,
  getPendingRequests,
  getSentRequests,
  getConnectionStatus,
} from '../controllers/connection.controller';

const router = Router();

router.use(authenticate);

router.post('/request', sendConnectionRequest);
router.post('/:connectionId/accept', acceptConnectionRequest);
router.post('/:connectionId/reject', rejectConnectionRequest);
router.delete('/:connectionId/cancel', cancelConnectionRequest);
// Declared before the bare `/:connectionId` delete so the literal segment wins.
// Lets a surface withdraw by recipient when it never learned the connection id.
router.delete('/user/:userId/request', cancelSentRequestToUser);
router.delete('/:connectionId', removeConnection);
router.get('/', getConnections);
router.get('/user/:userId', getUserConnections);
router.get('/pending', getPendingRequests);
router.get('/sent', getSentRequests);
router.get('/status/:userId', getConnectionStatus);

export default router;
