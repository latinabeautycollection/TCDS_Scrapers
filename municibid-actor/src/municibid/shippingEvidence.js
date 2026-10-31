// Classification is driven by explicit seller text. Keep the matched source
// clause as evidence, including pickup-only answers. Negative statements win.
export function classifyShipping({ title = '', description = '', terms = '', answer = '', cost = null, costText = '', extraText = '' } = {}) {
  const texts = [answer ? `Will you ship this item: ${answer}` : '', title, description, terms, costText, extraText].filter(Boolean);
  const clauses = texts.flatMap(text => String(text).split(/[\r\n]+|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean));
  const result = (method, amount, evidence) => ({ shipping_method: method, estimated_shipping: amount, shipping_evidence: evidence,
    shipping_available: method ? method !== 'pickup_only' : null, pickup_required: method === 'pickup_only' ? true : null });
  const negative = clauses.find(s => /\b(?:no shipping\b(?!\s+(?:damage|box|label|carton|packaging))|shipping (?:is )?not available|pick[ -]?up only|must be picked up)\b/i.test(s))
    || clauses.find(s => /\bwill you ship this item\s*[:?]?\s*no\b/i.test(s));
  if (negative) return result('pickup_only', null, negative);
  const free = clauses.find(s => /\bfree shipping\b/i.test(s));
  if (free) return result('free_shipping', 0, free);
  const numeric = clauses.map(s => ({ s, match: s.match(/\b(?:shipping(?: (?:cost|fee|price))?|delivery (?:cost|fee))\s*(?:is|:)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i) })).find(x => x.match);
  const amount = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : numeric ? Number(numeric.match[1].replace(/,/g, '')) : null;
  if (amount !== null) return result(amount === 0 ? 'free_shipping' : 'shipping', amount, costText || numeric?.s || null);
  const positive = clauses.find(s => /\b(?:shipping (?:is )?available|will ship|can ship|seller ships|will you ship this item\s*[:?]?\s*yes)\b/i.test(s));
  if (positive) return result('shipping_quote', null, positive);
  return result(null, null, null);
}