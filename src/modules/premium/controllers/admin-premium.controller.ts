/** Stable import surface; implementations are grouped by responsibility. */
export { getPremiumAdminOverview, updatePremiumAdminSettings } from './admin-premium/overview.controller';
export { getPremiumAdminUsers } from './admin-premium/users.controller';
export { updatePremiumAdminUser, cancelPremiumAdminUser } from './admin-premium/management.controller';
export { getPremiumAdminEvents } from './admin-premium/events.controller';
export { getPremiumAdminUserDetail } from './admin-premium/detail.controller';
export { sendPremiumAdminUserMessage } from './admin-premium/messaging.controller';
