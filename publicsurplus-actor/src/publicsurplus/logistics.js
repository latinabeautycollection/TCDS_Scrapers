import { cleanText } from './text.js';

export function extractLogisticsSignals(text) {
  const t = cleanText(text);
  const lower = t.toLowerCase();
  const explicitPickup = /buyer must pickup item\(s\)|buyer must pick up|pickup only|pick-up only|will not ship|no shipping/i.test(t);
  const shippingPossible = /free shipping|shipping price estimator|shipping available|seller will ship|cost of packing and\/or shipping/i.test(t);
  const shippingNegative = /no free shipping|no shipping|will not ship|not available for shipping/i.test(t);
  const shippingAvailable = shippingPossible && !shippingNegative ? true : explicitPickup ? false : null;
  const pickupRequired = explicitPickup ? true : null;
  const removal = t.match(/(?:buyer|successful bidder)[^.]{0,80}(?:remove|removal|pick[- ]?up)[^.]{0,240}/i)?.[0] ?? null;
  const payment = t.match(/payment[^.]{0,280}(?:business days|due|received|wire|credit card)[^.]{0,160}/i)?.[0] ?? null;
  const inspection = t.match(/(?:inspection|viewing)[^.]{0,300}/i)?.[0] ?? null;
  return {
    shipping_available: shippingAvailable,
    pickup_required: pickupRequired,
    removal_requirements: removal ? cleanText(removal) : null,
    payment_terms: payment ? cleanText(payment) : null,
    inspection_details: inspection ? cleanText(inspection) : null,
    buyer_responsible_for_loading: /buyer|successful bidder/.test(lower) && /responsible for (?:packing, )?(?:loading|removal|hauling|transport)/.test(lower) ? true : null,
    freight_possible: /freight|ltl|carrier/.test(lower) ? true : null,
    loading_assistance: /loading assistance|forklift.*available|seller.*load/.test(lower) ? true : null,
  };
}