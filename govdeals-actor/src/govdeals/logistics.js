import { cleanText } from './text.js';

export function extractLogisticsSignals(text) {
  const t = cleanText(text);
  const lower = t.toLowerCase();
  const sentences = t.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const negativePattern = /\b(?:no\s+(?:shipping|delivery)(?:\s+(?:is\s+)?available)?|(?:shipping|delivery)\s+(?:is\s+)?(?:not\s+available|unavailable|not\s+offered|not\s+provided|not\s+permitted|not\s+allowed)|(?:pickup|pick[- ]?up|collection)\s+only|must\s+be\s+(?:picked\s+up|collected)|cannot\s+(?:ship|deliver)|will\s+not\s+(?:ship|deliver))\b/i;
  const freePattern = /\bfree\s+(?:shipping|delivery)\b/i;
  const offerPattern = /\b(?:shipping|delivery)\s+(?:is\s+)?available\b|\b(?:will|can)\s+(?:ship|deliver)\b|\bseller\s+(?:will\s+)?ships?\b|\bwe\s+(?:will\s+)?ship\b|\bshipping\s+(?:is\s+)?offered\b|\b(?:we|seller)\s+(?:can|will)\s+(?:arrange|organize|provide)\s+(?:for\s+)?(?:shipping|delivery)\b|\b(?:shipping|delivery)\s+(?:(?:can|may|will)\s+be\s+)?arranged\b|\b(?:shipping|delivery)\s+arrangements?\s+(?:can|may|will)\s+be\s+made\b/i;
  const moneyPattern = /(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\bUSD\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|dollars?)\b)/i;
  const shippingPricePattern = /\b(?:shipping|delivery|freight)\b[^.!?;]{0,70}(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\bUSD\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|dollars?)\b)|(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\bUSD\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|dollars?)\b)[^.!?;]{0,70}\b(?:shipping|delivery|freight)\b/i;
  // These are limits on a particular destination or shipping arrangement, not
  // statements that the seller refuses to ship the lot at all.
  const isScopedShippingLimit = (sentence) =>
    /\b(?:must\s+be\s+(?:picked\s+up|collected)|pickup|pick[- ]?up|collection)\b[^.!?;]{0,100}\b(?:or|alternatively)\b[^.!?;]{0,100}\b(?:ship(?:ped|ping)?|deliver(?:ed|y)?|shipping|delivery)\b/i.test(sentence) ||
    /\bno\s+(?:shipping|delivery)\s+(?:to|into|outside|beyond)\b/i.test(sentence) ||
    /\b(?:combined|combine|multiple[- ]lot)\s+shipping\b[^.!?;]{0,100}\b(?:not\s+available|unavailable|not\s+offered|not\s+provided|not\s+permitted|not\s+allowed|cannot|can't|do\s+not)\b/i.test(sentence) ||
    /\b(?:shipping\s+labels?|customer[- ]arranged\s+(?:shipping|freight)|third[- ]party\s+(?:shipping|freight))\b[^.!?;]{0,100}\b(?:not\s+accepted|not\s+permitted|not\s+allowed|cannot|can't|do\s+not)\b/i.test(sentence);
  const negativeSentence = sentences.find((s) => negativePattern.test(s) && !isScopedShippingLimit(s)) ?? null;
  const freeSentence = sentences.find((s) => freePattern.test(s)) ?? null;
  const pricedSentence = sentences.find((s) => shippingPricePattern.test(s)) ?? null;
  const offerSentence = sentences.find((s) => offerPattern.test(s)) ?? null;
  const regionalLimitSentence = sentences.find((s) => /\bno\s+(?:shipping|delivery)\s+(?:to|into|outside|beyond)\b/i.test(s)) ?? null;
  const amountText = pricedSentence?.match(moneyPattern)?.[0] ?? null;
  const textShippingCost = amountText == null ? null : Number(amountText.replace(/[^\d.]/g, ''));
  const shippingAvailable = negativeSentence ? false : (freeSentence || pricedSentence || offerSentence || regionalLimitSentence) ? true : null;
  const shippingMethod = negativeSentence ? 'pickup_only'
    : freeSentence ? 'free_shipping'
      : pricedSentence ? 'shipping'
        : offerSentence || regionalLimitSentence ? 'shipping_quote' : null;
  const shippingEvidence = negativeSentence || freeSentence || pricedSentence || offerSentence || regionalLimitSentence;
  const pickupRequired = negativeSentence && /\b(?:pickup|pick[- ]?up|collection)\s+only|must\s+be\s+(?:picked\s+up|collected)/i.test(negativeSentence)
    ? true : shippingAvailable === true ? null : null;

  const removal = t.match(/(?:removal|pick[- ]?up)[^.!]{0,160}(?:required|within|appointment|schedule)[^.!]{0,180}/i)?.[0] ?? null;
  const payment = t.match(/payment[^.!]{0,220}(?:required|within|due|facilitate)[^.!]{0,140}/i)?.[0] ?? null;
  const inspection = t.match(/inspection[^.!]{0,280}/i)?.[0] ?? null;

  return {
    shipping_available: shippingAvailable,
    shipping_method: shippingMethod,
    shipping_evidence: shippingEvidence,
    text_shipping_cost: Number.isFinite(textShippingCost) && textShippingCost >= 0 ? textShippingCost : null,
    pickup_required: pickupRequired,
    removal_requirements: removal ? cleanText(removal) : null,
    payment_terms: payment ? cleanText(payment) : null,
    inspection_details: inspection ? cleanText(inspection) : null,
    buyer_responsible_for_loading: /buyer.*(?:load|loading|remove)|loading.*buyer/i.test(t) ? true : null,
    freight_possible: /freight|ltl|carrier/.test(lower) ? true : null,
    loading_assistance: /loading assistance|forklift.*available|seller.*load/i.test(lower) ? true : null,
  };
}