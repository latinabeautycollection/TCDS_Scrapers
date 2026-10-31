import { BOILERPLATE_HEADINGS } from './selectors.js';

export function roundTo2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function parseDollarText(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (/not\s*applicable/i.test(s)) return null;
  const m = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;

  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parsePercentText(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*%/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function cleanDescriptionText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

export function stripBoilerplate(text) {
  if (!text) return '';
  let cutIndex = text.length;

  for (const heading of BOILERPLATE_HEADINGS) {
    const idx = text.indexOf(heading);
    if (idx !== -1 && idx < cutIndex) cutIndex = idx;
  }

  return cutIndex === text.length ? text : text.slice(0, cutIndex).trim();
}

export function normalizeLocationText(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+\d{5}$/, '');
}

export function extractPickupLocationFromText(text) {
  if (!text) return null;

  const warehouseRe = /(?:warehouse|facility|location)\s+in\s+([A-Za-z][A-Za-z .'-]+,\s*[A-Za-z][a-zA-Z ]*[a-zA-Z])(?:\s+\d{5})?/i;
  const pickupRe = /Pick[-\s]?up.*?available.*?in\s+([A-Za-z][A-Za-z .'-]+,\s*[A-Za-z][a-zA-Z ]*[a-zA-Z])(?:\s+\d{5})?/i;

  const m1 = text.match(warehouseRe);
  if (m1) return normalizeLocationText(m1[1]);

  const m2 = text.match(pickupRe);
  if (m2) return normalizeLocationText(m2[1]);

  return null;
}

export function splitLocationParts(location) {
  if (!location || !location.includes(',')) {
    return {
      raw: location || '',
      city: null,
      state: null,
      country: 'US',
    };
  }

  const [city, ...rest] = location.split(',');
  const state = rest.join(',').trim() || null;

  return {
    raw: location,
    city: city.trim() || null,
    state,
    country: 'US',
  };
}