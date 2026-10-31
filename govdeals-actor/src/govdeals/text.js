export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function money(value) {
  if (value == null) return null;
  const m = String(value).replace(/,/g, '').match(/(?:USD\s*|\$)\s*(-?\d+(?:\.\d{1,2})?)/i)
    || String(value).replace(/,/g, '').match(/(-?\d+(?:\.\d{1,2})?)\s*USD/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function integer(value) {
  const m = String(value ?? '').match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

export function parseUtcParenthetical(value) {
  const text = cleanText(value);
  const m = text.match(/\(([^()]*?\bUTC)\)/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseDateLoose(value) {
  const text = cleanText(value);
  if (!text) return null;
  const candidates = [
    text.match(/\(([^()]*?(?:UTC|GMT))\)/i)?.[1],
    text.match(/(?:Closed|Closes|Closing|Ends?)\s*:?\s*([^\n]+)/i)?.[1],
    text,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export function inferAuctionStatus(text, endIso, now = new Date()) {
  const t = cleanText(text).toLowerCase();
  if (/withdrawn|cancelled|canceled/.test(t)) return 'CANCELLED';
  if (/no longer available|closed:|auction closed/.test(t)) return 'ENDED';
  if (/upcoming|opens:|opening:/.test(t)) return 'UPCOMING';
  if (endIso) {
    const end = new Date(endIso).getTime();
    if (Number.isFinite(end)) return end <= now.getTime() ? 'ENDED' : 'ACTIVE';
  }
  return 'UNKNOWN';
}

export function timeRemainingSeconds(endIso, observedIso) {
  if (!endIso || !observedIso) return null;
  const end = new Date(endIso).getTime();
  const observed = new Date(observedIso).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(observed)) return null;
  return Math.max(0, Math.floor((end - observed) / 1000));
}

export function labelValueFromText(text, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*:?\\s*([^|\\n]+)`, 'i');
  return cleanText(String(text ?? '').match(re)?.[1] ?? '');
}