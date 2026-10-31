// Run: node certification-tests/unit/payload.test.mjs  (no dependencies)
// Uses the REAL Municibid browse page recorded from Apify on 11/10/2026 (24 listings).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePayloadListings, findPayloadListing, toIsoUtc, titleCaseLocation, cleanMunicibidDescription, splitMedia, payloadString, htmlToText } from '../../src/municibid/payload.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, '../fixtures/municibid-index-REAL-2026-10-11.htm'), 'utf8');

const map = parsePayloadListings(html);
assert.equal(map.size, 24, 'all 24 listings parsed from the embedded payload');

// Lot 84929706 (canary lot): the HTML parser had the wrong seller and location and no end time
const o = map.get('84929706');
assert.equal(o.agencyName, 'Borough of Franklin Park');
assert.equal(o.sellerUserName, 'FranklinParkBoro');
assert.equal(o.currentPrice, 15655); assert.equal(o.bidCount, 31);
assert.equal(toIsoUtc(o.endsAtUtc), '2026-10-12T16:00:00.000Z', 'end time in UTC with Z');
assert.equal(titleCaseLocation(o.location), 'Pittsburgh, PA');
assert.equal(titleCaseLocation('SALT LAKE CITY, ut'), 'Salt Lake City, UT');
assert.equal(titleCaseLocation('nothing'), 'nothing');

// Every listing has an end time and a seller
for (const [, v] of map) { assert.ok(toIsoUtc(v.endsAtUtc)); assert.ok(v.agencyName); }
// No-bid lots exist on the page: currentPrice is the starting bid, bidCount 0
const noBid = [...map.values()].filter((v) => v.bidCount === 0);
assert.ok(noBid.length >= 1 && noBid.every((v) => v.currentPrice > 0));

// findPayloadListing: matching id, then the only endsAtUtc
assert.equal(findPayloadListing(html, '84929706').id, 84929706);
assert.equal(findPayloadListing('<script>x{"endsAtUtc":"2026-10-12T16:00:00"}</script>', '1'), null);
assert.equal(findPayloadListing('<html></html>', '1'), null);

// Media: only the item's own _largesize photos; PDFs to documents; related thumbnails dropped
const m = splitMedia([
  'https://x.blob/assets/media/88eed4a6.pdf', 'https://x.blob/assets/media/a2f6_largesize.jpg', 'https://x.blob/assets/media/1b7f_largesize.jpg',
  'https://x.blob/assets/media/399f_thumbcrop.jpg', 'https://x.blob/assets/media/a2f6_largesize.jpg']);
assert.deepEqual(m.photos, ['https://x.blob/assets/media/a2f6_largesize.jpg', 'https://x.blob/assets/media/1b7f_largesize.jpg']);
assert.deepEqual(m.documents, ['https://x.blob/assets/media/88eed4a6.pdf']);

// Description: the canary record contained map + related-auction boilerplate instead of the real text
const junk = 'Item LocationApproximate location based on the seller’s zip code. Explore other active listings on the map.Listing status This listing Other active listingsRelated Auctions You Might Be Interested In2017 Ford Explorer23 bids · Chester Springs, PA';
assert.equal(cleanMunicibidDescription(junk), null, 'boilerplate-only text becomes null, never the title');
assert.equal(cleanMunicibidDescription('Runs and drives. 800 hours.\nSold as is.\nRelated Auctions You Might Be Interested In 2017 Ford'), 'Runs and drives. 800 hours.\nSold as is.');
assert.equal(cleanMunicibidDescription('Government surplus auction by Borough of Franklin Park on Municibid.'), null, 'generic metadata sentence is not a description');
assert.equal(cleanMunicibidDescription('6.4l diesel, 107,865 miles. Comes with a 9 ft plow and a salt spreader.'), '6.4l diesel, 107,865 miles. Comes with a 9 ft plow and a salt spreader.');
assert.equal(payloadString('<script>{"description":"<p>Dump truck</p><p>800 hours</p>"}</script>'), '<p>Dump truck</p><p>800 hours</p>');
assert.equal(htmlToText('<p>Dump truck</p><p>800 hours &amp; clean</p>').replace(/\s+/g, ' ').trim(), 'Dump truck 800 hours & clean');
console.log('ALL municibid payload TESTS PASSED (real page: 24 listings)');