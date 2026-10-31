let buildRawRecord, normalizeRecord, validateRecord;
beforeAll(async () => {
  ({ buildRawRecord } = await import('../../src/govdeals/apiParser.js'));
  ({ normalizeRecord, validateRecord } = await import('../../src/utils/normalize.js'));
});

test('GovDeals price precedence, shipping selection and raw API evidence survive normalization', () => {
  const search = {
    assetId: 12, accountId: 34, assetShortDescription: 'Test lot', currentBid: 0,
    bidCount: 0, startingBid: 25, buyNowPrice: 40, assetAuctionEndDateUtc: '2026-10-20T12:00:00Z',
  };
  const detail = {
    assetId: 12, assetLongDesc: 'Shipping is available',
    shippingOptions: [{ shippingCost: 18 }, { shippingCost: 9 }, { shippingCost: null }],
    assetAuctionStartDateUtc: '2026-10-01T10:00:00Z',
  };
  const bidbox = { bidCount: 0 };
  const raw = buildRawRecord({ row: search, detail, bidbox, observedAt: '2026-10-19T10:00:00Z' });
  expect(raw.current_price).toBe(25);
  expect(raw.attributes.price_type).toBe('starting_bid');
  expect(raw.attributes.bid_count).toBe(0);
  expect(raw.estimated_shipping).toBe(9);
  expect(raw.shipping_method).toBe('shipping');
  expect(raw.auction_start_time).toBe('2026-10-01T10:00:00.000Z');
  expect(raw.attributes.auction_start_time_source).toBe('govdeals_api');
  expect(raw.source_record).toEqual({ search, detail, bidbox });

  const normalized = normalizeRecord(raw, 'govdeals');
  expect(normalized.source_record).toEqual({ search, detail, bidbox });
  expect(normalized.estimated_shipping).toBe(9);
  expect(validateRecord(normalized).valid).toBe(true);
});

test('GovDeals does not mislabel a missing API start time as unpublished by the site', () => {
  const raw = buildRawRecord({
    row: { assetId: 13, accountId: 34, assetShortDescription: 'No start time', currentBid: 15, bidCount: 1, assetAuctionEndDateUtc: '2026-10-20T12:00:00Z' },
    detail: { assetId: 13, assetLongDesc: 'Pickup only' },
    bidbox: { bidCount: 1 },
    observedAt: '2026-10-19T10:00:00Z',
  });
  expect(raw.auction_start_time).toBeNull();
  expect(raw.attributes.auction_start_time_source).toBe('not_observed_in_api');
  expect(raw.normalization_status).toBe('incomplete');
  expect(raw.shipping_method).toBe('pickup_only');
  const normalized = normalizeRecord(raw, 'govdeals');
  expect(normalized.normalization_status).toBe('incomplete');
  expect(validateRecord(normalized).valid).toBe(true);
});

test('GovDeals rejects a record without the original bid-box response', () => {
  const raw = buildRawRecord({
    row: { assetId: 14, accountId: 34, assetShortDescription: 'Missing bid box', currentBid: 15, bidCount: 1, assetAuctionEndDateUtc: '2026-10-20T12:00:00Z' },
    detail: { assetId: 14, assetLongDesc: 'Pickup only', auctionStartDateUtc: '2026-10-01T10:00:00Z' },
    bidbox: null,
    observedAt: '2026-10-19T10:00:00Z',
  });
  expect(validateRecord(normalizeRecord(raw, 'govdeals')).errors).toContain(
    'source_record.bidbox: must contain the original API object',
  );
});

test('GovDeals maps explicitly advertised free shipping to zero-cost shipping', () => {
  const raw = buildRawRecord({
    // Mirrors the live lot that was exported with an empty estimated_shipping:
    // the title is explicit even when the API boolean conflicts with it.
    row: { assetId: 850, accountId: 28251, assetShortDescription: '2025 S AMERICAN SILVER EAGLE LIMITED EDITION ONE OUNCE SILVER PROOF COIN FREE SHIPPING (USA ONLY)', currentBid: 0, startingBid: 199, bidCount: 0, assetAuctionEndDateUtc: '2026-11-01T01:15:00Z', willShip: true },
    detail: { assetId: 850, assetLongDesc: 'See title for delivery terms.', willShip: true },
    bidbox: { bidCount: 0 },
    observedAt: '2026-10-19T10:00:00Z',
  });
  expect(raw.estimated_shipping).toBe(0);
  expect(raw.shipping_method).toBe('free_shipping');
  expect(raw.shipping_available).toBe(true);
  expect(raw.source_meta.shipping.source).toBe('govdeals_published_free_shipping_text');

  const normalized = normalizeRecord(raw, 'govdeals');
  expect(normalized.estimated_shipping).toBe(0);
  expect(normalized.shipping_method).toBe('free_shipping');
  expect(normalized.source_record.search.assetShortDescription).toContain('FREE SHIPPING');
});

test('GovDeals does not infer free shipping from a negative statement', () => {
  const raw = buildRawRecord({
    row: { assetId: 16, accountId: 34, assetShortDescription: 'No free shipping; pickup only', currentBid: 5, bidCount: 1, assetAuctionEndDateUtc: '2026-10-20T12:00:00Z', willShip: false },
    detail: { assetId: 16, assetLongDesc: 'Pickup only.', willShip: false },
    bidbox: { bidCount: 1 },
    observedAt: '2026-10-19T10:00:00Z',
  });
  expect(raw.estimated_shipping).toBeNull();
  expect(raw.shipping_method).toBe('pickup_only');
  expect(raw.shipping_available).toBe(false);
});

test('GovDeals listing text overrides a false willShip flag and records the matched sentence', () => {
  const raw = buildRawRecord({
    row: { assetId: 795, accountId: 28251, assetShortDescription: 'FREE SHIPPING (USA ONLY)', currentBid: 10, bidCount: 1, assetAuctionEndDateUtc: '2026-11-01T12:00:00Z', willShip: false },
    detail: { assetId: 795, assetLongDesc: 'Working unit.', removalInstructions: '* FREE SHIPPING * Shipping is available to USA addresses.', willShip: false },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  expect(raw.shipping_method).toBe('free_shipping');
  expect(raw.estimated_shipping).toBe(0);
  expect(raw.attributes.shipping_evidence).toMatch(/FREE SHIPPING/i);
});

test('GovDeals keeps free shipping when the only negative is a destination restriction', () => {
  const raw = buildRawRecord({
    row: { assetId: 2017, accountId: 26841, assetShortDescription: 'FREE SHIPPING 25HP Kubota diesel skid steer', currentBid: 16200, bidCount: 1, assetAuctionEndDateUtc: '2026-10-30T18:25:00Z', willShip: false },
    detail: {
      assetId: 2017,
      assetLongDesc: 'FREE SHIPPING IN USA. Free shipping within mainland USA.',
      removalInstructions: 'FREE SHIPPING FOR BUYER SHIPPING INCLUDED IN PRICE. Item ships via freight. No shipping to Alaska, Hawaii, Puerto Rico, or Guam.',
      willShip: false,
    },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  expect(raw.shipping_method).toBe('free_shipping');
  expect(raw.estimated_shipping).toBe(0);
  expect(raw.shipping_available).toBe(true);
  expect(raw.attributes.shipping_evidence).toMatch(/FREE SHIPPING/i);
  expect(normalizeRecord(raw, 'govdeals').attributes.shipping_evidence).toMatch(/FREE SHIPPING/i);
});

test('GovDeals does not treat combined-shipping or third-party-label limits as pickup-only', () => {
  const raw = buildRawRecord({
    row: { assetId: 10077, accountId: 23980, assetShortDescription: 'Console table', currentBid: 20, bidCount: 1, assetAuctionEndDateUtc: '2026-10-26T19:15:00Z', willShip: true },
    detail: {
      assetId: 10077,
      assetLongDesc: 'Console table.',
      removalInstructions: 'We can arrange shipping. We do not combine shipping. Buyer-provided shipping labels and customer-arranged freight are not accepted. All winning lots must be picked up or have shipping arranged within ten days.',
      willShip: true,
    },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  expect(raw.shipping_method).toBe('shipping_quote');
  expect(raw.shipping_available).toBe(true);
  expect(raw.attributes.shipping_evidence).toMatch(/arrange shipping/i);
  expect(normalizeRecord(raw, 'govdeals').attributes.shipping_evidence).toMatch(/arrange shipping/i);
});

test('GovDeals treats pickup-or-shipping deadlines as shipping alternatives, not pickup-only', () => {
  const raw = buildRawRecord({
    row: { assetId: 10078, accountId: 23980, assetShortDescription: 'Console table', currentBid: 20, bidCount: 1, assetAuctionEndDateUtc: '2026-10-26T19:15:00Z', willShip: true },
    detail: { assetId: 10078, assetLongDesc: 'Desk.', removalInstructions: 'All winning lots must be picked up or have shipping arranged within ten days.', willShip: true },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  expect(raw.shipping_method).toBe('shipping_quote');
  expect(raw.attributes.shipping_evidence).toMatch(/shipping arranged/i);
});

test('GovDeals classifies quoted and priced shipping from text despite willShip=false', () => {
  const build = (instructions) => buildRawRecord({
    row: { assetId: 17, accountId: 34, assetShortDescription: 'Generator', currentBid: 50, bidCount: 1, assetAuctionEndDateUtc: '2026-11-01T12:00:00Z', willShip: false },
    detail: { assetId: 17, assetLongDesc: '', removalInstructions: instructions, willShip: false },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  const quote = build('Shipping is available. Contact seller for a quote.');
  expect(quote.shipping_method).toBe('shipping_quote');
  expect(quote.estimated_shipping).toBeNull();
  expect(quote.attributes.shipping_evidence).toContain('Shipping is available.');
  const priced = build('Shipping is available for $125.00.');
  expect(priced.shipping_method).toBe('shipping');
  expect(priced.estimated_shipping).toBe(125);
  expect(priced.attributes.shipping_evidence).toContain('$125.00');
});

test('GovDeals negative shipping instruction wins over a positive offer in the same sentence', () => {
  const raw = buildRawRecord({
    row: { assetId: 18, accountId: 34, assetShortDescription: 'Can ship if needed; pickup only', currentBid: 50, bidCount: 1, assetAuctionEndDateUtc: '2026-11-01T12:00:00Z', willShip: true },
    detail: { assetId: 18, assetLongDesc: 'Shipping is not available. Must be picked up at the site.' },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  expect(raw.shipping_method).toBe('pickup_only');
  expect(raw.estimated_shipping).toBeNull();
  expect(raw.attributes.shipping_evidence).toMatch(/pickup only/i);
});

test('GovDeals maps explicit MPN labels and coded Model values but never serial/VIN', () => {
  const build = (groups) => buildRawRecord({
    row: { assetId: 19, accountId: 34, assetShortDescription: 'Equipment', currentBid: 50, bidCount: 1, assetAuctionEndDateUtc: '2026-11-01T12:00:00Z' },
    detail: { assetId: 19, assetLongDesc: 'Pickup only.', vinserial: 'VIN-SERIAL-123', assetAttributeGroups: [{ attributes: groups.map(([attributeName, attributeValue]) => ({ attributeName, attributeValue })) }] },
    bidbox: { bidCount: 1 }, observedAt: '2026-10-24T08:00:00Z',
  });
  const explicit = build([['Catalog Number', 'CAT-7'], ['Serial Number', 'SER-123']]);
  expect(explicit.model).toBeNull();
  expect(explicit.mpn).toBe('CAT-7');
  const codedModel = build([['Model', 'SC-W60A-AV']]);
  expect(codedModel.model).toBe('SC-W60A-AV');
  expect(codedModel.mpn).toBe('SC-W60A-AV');
  const descriptiveModel = build([['Model', 'Industrial pump'], ['Serial Number', 'SN-999']]);
  expect(descriptiveModel.model).toBe('Industrial pump');
  expect(descriptiveModel.mpn).toBeNull();
  expect(descriptiveModel.serial_number).toBe('VIN-SERIAL-123');
  expect(descriptiveModel.attributes.serial_number).toBe('VIN-SERIAL-123');
});

test('GovDeals normalizer accepts the expanded shipping classifications', () => {
  for (const shipping_method of ['shipping', 'shipping_quote', 'free_shipping', 'pickup_only']) {
    const raw = buildRawRecord({
      row: { assetId: 30, accountId: 34, assetShortDescription: 'Equipment', currentBid: 50, bidCount: 1, assetAuctionEndDateUtc: '2026-11-01T12:00:00Z' },
      detail: { assetId: 30, assetLongDesc: 'Shipping is available.' }, bidbox: { bidCount: 1 },
      observedAt: '2026-10-24T08:00:00Z',
    });
    raw.shipping_method = shipping_method;
    expect(validateRecord(normalizeRecord(raw, 'govdeals')).valid).toBe(true);
  }
});
