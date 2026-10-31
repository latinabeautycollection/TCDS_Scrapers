export function hasEnded(endTime, now = new Date().toISOString()) {
  const end = Date.parse(endTime || '');
  return Number.isFinite(end) && end <= Date.parse(now);
}

export function isClosedLot(record, now = new Date().toISOString()) {
  return ['ENDED', 'CLOSED', 'CANCELLED'].includes(record?.auction_status)
    || hasEnded(record?.auction_end_time, now);
}

// Login/access status alone is not proof that an auction has ended.
export function unavailableDisposition(status, knownEnd, now = new Date().toISOString()) {
  if ([401,404,410].includes(status) && hasEnded(knownEnd, now)) return 'CLOSED';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'ACCESS_RESTRICTED';
  if ([404,410].includes(status)) return 'REMOVED_CONFIRMED';
  return null;
}