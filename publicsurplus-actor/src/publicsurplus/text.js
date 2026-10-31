export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function money(value) {
  if (value == null) return null;
  const m = String(value).replace(/,/g, '').match(/\$\s*(-?\d+(?:\.\d{1,2})?)/i)
    || String(value).replace(/,/g, '').match(/(?:USD\s*)?(-?\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function integer(value) {
  const m = String(value ?? '').match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

const TZ_OFFSETS = Object.freeze({
  EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00',
  MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00',
  UTC: '+00:00', GMT: '+00:00',
});

const REGION_ZONES = Object.freeze({
  EASTERN: 'America/New_York', CENTRAL: 'America/Chicago',
  MOUNTAIN: 'America/Denver', PACIFIC: 'America/Los_Angeles',
});

function zonedOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs));
  const part = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - instantMs;
}

export function parsePublicSurplusDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const m = text.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)(?:\s+(EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT|Eastern|Central|Mountain|Pacific))?/i);
  if (!m || !m[8]) return null; // A time without a published zone cannot safely be converted to UTC.
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = months.indexOf(m[1].toLowerCase());
  let hour = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'PM') hour += 12;
  const wallMs = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0));
  const zone = m[8].toUpperCase();
  let utcMs;
  if (TZ_OFFSETS[zone]) {
    const offset = TZ_OFFSETS[zone];
    const sign = offset[0] === '-' ? -1 : 1;
    const [oh, om] = offset.slice(1).split(':').map(Number);
    utcMs = wallMs - sign * (oh * 60 + om) * 60_000;
  } else {
    const timeZone = REGION_ZONES[zone];
    if (!timeZone || month < 0) return null;
    let candidate = wallMs - zonedOffsetMs(wallMs, timeZone);
    candidate = wallMs - zonedOffsetMs(candidate, timeZone);
    utcMs = candidate;
  }
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function inferAuctionStatus(text, endIso, now = new Date()) {
  const t = cleanText(text).toLowerCase();
  if (/cancelled|canceled|withdrawn/.test(t)) return 'CANCELLED';
  if (/auction closed|auction has ended|closed auction/.test(t)) return 'ENDED';
  if (/auction has not started|upcoming/.test(t)) return 'UPCOMING';
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