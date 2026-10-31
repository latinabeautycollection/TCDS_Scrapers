import crypto from 'node:crypto';

function normalizeUrlEntry(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object' && entry.url) return String(entry.url).trim();
  return '';
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

/**
 * Recovery compatibility fingerprint.
 * Deliberately excludes credentials, tokens, webhook/export configuration and other
 * values that do not define Liquidation discovery scope or resume semantics.
 */
export function liquidationRecoveryPolicy(input = {}) {
  return {
    sourceName: 'liquidation',
    recheckLots: (input.recheckLots || []).map(normalizeUrlEntry).filter(Boolean).sort(),
    discoveryMode: String(input.discoveryMode || 'EXHAUSTIVE').toUpperCase(),
    startUrls: (input.startUrls || []).map(normalizeUrlEntry).filter(Boolean).sort(),
    keywords: (input.keywords || []).map((v) => String(v).trim()).filter(Boolean).sort(),
    includeSellerPartitions: input.includeSellerPartitions !== false,
    includeCategoryPartitions: input.includeCategoryPartitions !== false,
    includeCompleted: input.includeCompleted === true,
    includeManifestItems: input.includeManifestItems !== false,
    maxPages: Number(input.maxPages || 0),
    maxDiscoveryRequests: Number(input.maxDiscoveryRequests || 0),
    maxDetailRequests: Number(input.maxDetailRequests || 0),
    maxRuntimeMinutes: Number(input.maxRuntimeMinutes || 0),
    maxItemsPerRun: Number(input.maxItemsPerRun || 0),
  };
}

export function buildLiquidationInputFingerprint(input = {}) {
  const policy = sortObject(liquidationRecoveryPolicy(input));
  return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}