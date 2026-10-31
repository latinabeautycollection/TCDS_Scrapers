// purplewave-discovery: find where Purple Wave's listing data comes from, using US IPs.
// Discovery only. No listing extraction, no Unblocker, no attempt to defeat challenge pages:
// if a tier returns a challenge, it moves to the next tier and otherwise reports "blocked".
//
// What it does, per page:
//   1. Fetches the page through none -> datacenter (US) -> residential (US), stopping at the
//      first tier that returns a real page.
//   2. Saves the raw HTML to the key-value store (page-<n>.html) so it can be inspected.
//   3. Reports whether listings are already in the HTML (Cheerio candidate).
//   4. Downloads the site's own JavaScript bundles (same tier) and searches them for the data
//      API: /api/ paths, GraphQL, Algolia / Typesense / Elasticsearch config, fetch/axios URLs.
//
// Results: dataset (one row per page) + key-value store record FINDINGS (everything combined).
//
// SETUP: Crawlee + Cheerio (JavaScript) template. Replace src/main.js with this file and add
// "got-scraping": "^4.0.0" to package.json dependencies. Run on the Apify platform.
//
// Optional input: { "pages": ["https://..." or {"url","method":"POST","form":{...}|"json":{...},"headers":{...}}], "headers": {"Accept": "application/json"}, "datacenterGroups": [], "maxBundleKB": 4000 }
// A page that returns JSON is saved as page-<n>.json and reported with its item count.

import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();
const input = (await Actor.getInput()) ?? {};

const PAGES = Array.isArray(input.pages) && input.pages.length ? input.pages : [
    'https://www.purplewave.com/',
    'https://www.purplewave.com/search',
    'https://www.purplewave.com/search?searchTerms=truck',
];
const MAX_BUNDLES = 25;
const MAX_BUNDLE_BYTES = (input.maxBundleKB ?? 4000) * 1024;
const RESIDENTIAL_USD_PER_GB = 8;

const CHALLENGE = /cf-chl|challenge-platform|<title>\s*(just a moment|attention required)|_Incapsula_Resource|awsWafCookieDomainList|gokuProps|px-captcha/i;
const PRICE = /\$\s?\d[\d,]*(?:\.\d{2})?/g;

// ---- Proxy tiers (initialised once) -------------------------------------
const datacenterProxy = { countryCode: 'US' };
if (Array.isArray(input.datacenterGroups) && input.datacenterGroups.length) datacenterProxy.groups = input.datacenterGroups;
const TIERS = [
    { name: 'none', proxy: null },
    { name: 'datacenter', proxy: datacenterProxy },
    { name: 'residential', proxy: { groups: ['RESIDENTIAL'], countryCode: 'US' } },
];
const proxyCfgs = {};
const tierUnavailable = {};
for (const tier of TIERS) {
    if (!tier.proxy) continue;
    try {
        const cfg = await Actor.createProxyConfiguration(tier.proxy);
        if (!cfg) throw new Error('proxy configuration unavailable (not running on Apify?)');
        await cfg.newUrl('probe');
        proxyCfgs[tier.name] = cfg;
    } catch (e) {
        tierUnavailable[tier.name] = String(e.message || e).slice(0, 200);
        console.warn(`Tier "${tier.name}" unavailable: ${tierUnavailable[tier.name]}`);
    }
}

let residentialBytes = 0;

async function fetchVia(tier, url, { session, maxBytes, headers, method, form, json } = {}) {
    const proxyUrl = tier.proxy ? await proxyCfgs[tier.name].newUrl(session || `s${Date.now()}${Math.floor(Math.random() * 1e6)}`) : undefined;
    try {
        const res = await gotScraping({
            url,
            proxyUrl,
            headers,
            method: method || 'GET',
            ...(form ? { form } : {}),
            ...(json ? { json } : {}),
            timeout: { request: 30000 },
            retry: { limit: 0 },
            throwHttpErrors: false,
            followRedirect: true,
        });
        let body = typeof res.body === 'string' ? res.body : '';
        if (maxBytes && body.length > maxBytes) body = body.slice(0, maxBytes);
        const bytes = Buffer.byteLength(body);
        if (tier.name === 'residential') residentialBytes += bytes;
        return { status: res.statusCode, body, bytes, headers: res.headers };
    } catch (e) {
        return { status: 'ERR', body: '', bytes: 0, error: String(e.message || e).slice(0, 120) };
    }
}

// ---- Analysis helpers ---------------------------------------------------
const uniq = (a) => [...new Set(a)];

function scriptSources(html, base) {
    return uniq([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => {
        try { return new URL(m[1], base).href; } catch { return null; }
    }).filter(Boolean));
}

const NOISE_HOSTS = 'google|facebook|doubleclick|hotjar|clarity|hubspot|cloudflareinsights|sentry|newrelic|nr-data|segment|linkedin|bing|pinterest|tiktok|youtube|vimeo|gstatic|fonts\\.|w3\\.org|schema\\.org|jquery|jsdelivr|cdnjs|unpkg|twitter|instagram|cookie|onetrust|criteo|richrelevance|reddit|adsrvr|adnxs|optimizely|visualwebsiteoptimizer|amplitude|zdassets|zendesk|intercom|github|mozilla|apple\\.com|microsoft|example\\.com|angular|reactjs|vuejs|getbootstrap|fontawesome';

// Endpoints and search-service config that point at the listing data.
function findApiHints(text) {
    const hints = {};
    const add = (k, arr) => { const v = uniq(arr).slice(0, 40); if (v.length) hints[k] = v; };

    add('absoluteApiUrls', (text.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?\/[^\s"'`<>)\\]*(?:api|graphql|search|lots?|items?|auctions?|inventory|listings?)[^\s"'`<>)\\]*/gi) || [])
        .filter((u) => !new RegExp(NOISE_HOSTS, 'i').test(u)));
    add('relativeApiPaths', (text.match(/["'`](\/(?:api|graphql|v\d)\/[^"'`\s]{0,120})["'`]/gi) || []).map((s) => s.slice(1, -1)));
    add('apiHosts', (text.match(/https?:\/\/(?:api|search|gql|graphql|data|services?)[a-z0-9.-]*\.[a-z]{2,}/gi) || []));
    add('graphql', (text.match(/.{0,60}graphql.{0,60}/gi) || []));
    add('algolia', (text.match(/.{0,80}(?:algolia|x-algolia|appId|applicationId|searchApiKey|indexName).{0,80}/gi) || []).filter((s) => /algolia|indexName/i.test(s)));
    add('typesense', (text.match(/.{0,80}typesense.{0,80}/gi) || []));
    add('elasticsearch', (text.match(/.{0,80}(?:elasticsearch|_search\b|opensearch).{0,80}/gi) || []));
    add('fetchCalls', (text.match(/(?:fetch|axios(?:\.(?:get|post))?|\$\.(?:ajax|get|post)|baseURL)\s*\(?\s*[:=]?\s*["'`](?:https?:\/\/|\/)[^"'`\s]{2,150}["'`]/gi) || []));
    // Every non-tracker host the code mentions; the data API base is often stored bare (https://api.example.com/).
    add('allHosts', (text.match(/https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).map((h) => h.toLowerCase())
        .filter((h) => !new RegExp(NOISE_HOSTS, 'i').test(h)));
    // Quoted path fragments that look like data endpoints (often joined onto a bare base URL).
    add('dataPaths', (text.match(/["'`]\/?(?:[a-z0-9_-]+\/){0,3}(?:search|lots?|items?|auctions?|assets?|inventory|listings?|catalog(?:ue)?s?)(?:\/[a-z0-9_-]+){0,3}\/?["'`]/gi) || [])
        .map((x) => x.slice(1, -1)).filter((x) => x.includes('/')));
    add('inlineState', (text.match(/__NEXT_DATA__|__NUXT__|window\.__[A-Z_]+__|__APOLLO_STATE__|__INITIAL_STATE__|__PRELOADED_STATE__/g) || []));
    return hints;
}

function mergeHints(into, from, source) {
    for (const [k, v] of Object.entries(from)) {
        into[k] = into[k] || [];
        for (const item of v) if (!into[k].some((x) => x.value === item) && into[k].length < 60) into[k].push({ value: item, source });
    }
}

// ---- Main ---------------------------------------------------------------
const findings = { pages: [], hints: {}, bundlesScanned: [], tierUnavailable };

for (const [i, entry] of PAGES.entries()) {
    // A page is a URL string, or { url, method, form, json, headers } for POST/API calls.
    const req = typeof entry === 'string' ? { url: entry } : entry;
    const url = req.url;
    const row = { n: i + 1, url, method: req.method || 'GET' };
    let got = null;

    for (const tier of TIERS) {
        if (tierUnavailable[tier.name]) { row[tier.name] = 'skipped (unavailable)'; continue; }
        const r = await fetchVia(tier, url, { headers: { ...(input.headers || {}), ...(req.headers || {}) }, method: req.method, form: req.form, json: req.json });
        const challenge = CHALLENGE.test(r.body.slice(0, 50000));
        row[tier.name] = `${r.status}${challenge ? ' (challenge)' : ''} ${Math.round(r.bytes / 1024)}KB${r.error ? ' ' + r.error : ''}`;
        if (r.status === 200 && !challenge) { got = { tier, ...r }; break; }
        if (r.status === 404 || (typeof r.status === 'number' && r.status >= 500)) break; // a proxy will not fix these
    }

    if (!got) {
        row.result = 'Blocked or unreachable at all available tiers';
        findings.pages.push(row);
        await Actor.pushData(row);
        console.log(`${row.n}. ${url}: ${row.result}`);
        continue;
    }

    const html = got.body;
    row.workingTier = got.tier.name;
    row.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim().slice(0, 100) || '';
    row.sizeKB = Math.round(got.bytes / 1024);
    row.priceStringsInHtml = (html.match(PRICE) || []).length;
    row.listingsInHtml = row.priceStringsInHtml >= 5;
    let json = null;
    try { json = JSON.parse(html); } catch { /* not JSON */ }
    if (json !== null) {
        row.isJson = true;
        const arr = Array.isArray(json) ? json : (Object.values(json).find((v) => Array.isArray(v)) || []);
        row.jsonItems = arr.length;
        row.jsonFirstItemKeys = arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]).slice(0, 60) : (Array.isArray(json) ? [] : Object.keys(json).slice(0, 40));
        row.htmlKey = `page-${row.n}.json`;
        await Actor.setValue(row.htmlKey, json);
        row.result = `Reachable with ${row.workingTier}; JSON with ${row.jsonItems} items -> API works`;
        findings.pages.push(row);
        await Actor.pushData(row);
        console.log(`${row.n}. ${url}: ${row.result}`);
        continue;
    }
    row.htmlKey = `page-${row.n}.html`;
    await Actor.setValue(row.htmlKey, html, { contentType: 'text/html; charset=utf-8' });

    const pageHints = findApiHints(html);
    mergeHints(findings.hints, pageHints, url);
    row.hintTypesInHtml = Object.keys(pageHints);

    // Scan the site's own JS bundles (same tier) for the data API.
    const origin = new URL(url).origin;
    const scripts = scriptSources(html, url)
        .filter((s) => s.startsWith(origin) || !new RegExp(NOISE_HOSTS, 'i').test(new URL(s).host))
        .sort((a, b) => Number(b.startsWith(origin)) - Number(a.startsWith(origin))); // own scripts first
    row.scriptCount = scripts.length;
    for (const src of (row.method === 'GET' ? scripts : []).slice(0, MAX_BUNDLES)) {
        if (findings.bundlesScanned.includes(src)) continue;
        const b = await fetchVia(got.tier, src, { maxBytes: MAX_BUNDLE_BYTES });
        findings.bundlesScanned.push(src);
        if (b.status === 200) mergeHints(findings.hints, findApiHints(b.body), src);
    }

    row.result = row.listingsInHtml
        ? `Reachable with ${row.workingTier}; listings ARE in the HTML -> Cheerio candidate`
        : `Reachable with ${row.workingTier}; NO listings in HTML -> see FINDINGS.hints for the data API`;
    findings.pages.push(row);
    await Actor.pushData(row);
    console.log(`${row.n}. ${url}: ${row.result}`);
}

findings.residentialMB = residentialBytes / 1e6;
findings.estResidentialCostUsd = (residentialBytes / 1e9) * RESIDENTIAL_USD_PER_GB;
await Actor.setValue('FINDINGS', findings);

console.log('\n=== API hints (first few per type) ===');
for (const [k, v] of Object.entries(findings.hints)) {
    console.log(`\n[${k}] ${v.length} found`);
    for (const h of v.slice(0, 8)) console.log(`  ${String(h.value).slice(0, 160)}`);
}
console.log(`\nBundles scanned: ${findings.bundlesScanned.length}`);
console.log(`Residential data used: ${findings.residentialMB.toFixed(2)} MB (~$${findings.estResidentialCostUsd.toFixed(3)})`);
console.log('Full results: key-value store record FINDINGS; raw HTML: page-1.html, page-2.html, ...');

await Actor.exit();