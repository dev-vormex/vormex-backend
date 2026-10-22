
export function normalizePremiumBillingCycle(value: string | undefined | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'yearly' || normalized === 'annual' || normalized === 'annually') {
    return 'yearly';
  }
  return 'monthly';
}

