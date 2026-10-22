export function getTodayStart(): Date {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

export function isToday(date: Date | null): boolean {
  if (!date) return false;
  const today = getTodayStart();
  const checkDate = new Date(date);
  checkDate.setUTCHours(0, 0, 0, 0);
  return checkDate.getTime() === today.getTime();
}
