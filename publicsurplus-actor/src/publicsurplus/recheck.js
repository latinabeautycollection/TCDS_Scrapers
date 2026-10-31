import { parseAuctionIdentity } from './url.js';

const ALLOWED_PUBLICSURPLUS_HOST = /(^|\.)publicsurplus\.com$/i;

function assertDetailUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_PUBLICSURPLUS_HOST.test(url.hostname)) {
    throw new Error(`INVALID_PUBLICSURPLUS_RECHECK_TARGET:${rawUrl}`);
  }
  if (!parseAuctionIdentity(url.toString())) throw new Error(`INVALID_PUBLICSURPLUS_RECHECK_TARGET:${rawUrl}`);
}

/** Build an exact, deduplicated list of detail-page requests for operator rechecks. */
export function buildRecheckRequests(recheckLots = [], runId = 'manual') {
  const requests = new Map();
  for (const value of Array.isArray(recheckLots) ? recheckLots : []) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    let url;
    if (/^https?:\/\//i.test(raw)) {
      assertDetailUrl(raw);
      // Preserve the host and agency/region route for the request. Those parts
      // can be required by Public Surplus even though records use a canonical URL.
      const sourceUrl = new URL(raw);
      sourceUrl.protocol = 'https:';
      sourceUrl.hash = '';
      url = sourceUrl.toString();
    } else {
      const id = raw.replace(/^publicsurplus-/i, '');
      if (!/^\d+$/.test(id)) throw new Error(`INVALID_PUBLICSURPLUS_RECHECK_TARGET:${raw}`);
      url = `https://www.publicsurplus.com/sms/auction/view?auc=${id}`;
    }
    const identity = parseAuctionIdentity(url);
    if (!identity) throw new Error(`INVALID_PUBLICSURPLUS_RECHECK_TARGET:${raw}`);
    const detailUrl = new URL(url);
    const detailRoute = detailUrl.pathname.match(/^(\/sms(?:\/[^/]+)?)\/auction\/view$/i)?.[1] || '/sms';
    const referer = new URL(`${detailRoute}/browse/home`, detailUrl.origin).toString();
    requests.set(identity.externalId, {
      url,
      uniqueKey: `recheck:${runId}:${identity.externalId}`,
      userData: { type: 'detail', externalId: identity.externalId, partition: 'operator_recheck', recheck: true, referer },
    });
  }
  return [...requests.values()];
}

/** Warm one Public Surplus browse route per host/agency before recheck details. */
export function buildRecheckBootstrapRequests(recheckLots = [], runId = 'manual') {
  const bootstraps = new Map();
  for (const detail of buildRecheckRequests(recheckLots, runId)) {
    const url = new URL(detail.userData.referer);
    const key = `${url.origin}${url.pathname}`;
    if (!bootstraps.has(key)) {
      bootstraps.set(key, {
        url: key,
        uniqueKey: `recheck-bootstrap:${runId}:${encodeURIComponent(key)}`,
        userData: { type: 'bootstrap', partition: 'recheck_session_bootstrap', recheck: true },
      });
    }
  }
  return [...bootstraps.values()];
}