import { SHIPPING_SLOT_IDS } from './selectors.js';
import { parseDollarText } from './textParsers.js';

export async function extractShippingOptions(page) {
  const rawShipping = await page.evaluate((slotIds) => {
    const result = [];

    for (const slot of slotIds) {
      const el = document.getElementById(slot.id);
      if (el) {
        result.push({
          method: slot.method,
          rawText: el.textContent?.trim() ?? '',
          source: 'slot_id',
        });
      }
    }

    if (result.length === 0) {
      const shippingMethods = [
        { pattern: /customer\s*pick/i, method: 'Customer Pick-up' },
        { pattern: /standard\s*shipping/i, method: 'Standard Shipping' },
        { pattern: /expedited\s*shipping/i, method: 'Expedited Shipping' },
        { pattern: /express\s*shipping/i, method: 'Express Shipping' },
        { pattern: /freight/i, method: 'Freight' },
      ];

      const allLis = document.querySelectorAll('li');
      for (const li of allLis) {
        const text = li.textContent?.trim() ?? '';
        for (const sm of shippingMethods) {
          if (sm.pattern.test(text) && text.length < 200) {
            const nextLi = li.nextElementSibling;
            const priceText = nextLi?.textContent?.trim() ?? '';
            result.push({
              method: sm.method,
              rawText: priceText || text,
              source: 'list_pair',
            });
          }
        }
      }
    }

    return result;
  }, SHIPPING_SLOT_IDS);

  const shipping_options = rawShipping.map((raw) => {
    const price = parseDollarText(raw.rawText);
    const applicable = !/not\s*applicable/i.test(raw.rawText) && price !== null;

    return {
      method: raw.method,
      price: applicable ? price : null,
      applicable,
      source: raw.source,
      raw_text: raw.rawText,
      confidence: raw.source === 'slot_id' ? 0.97 : 0.8,
    };
  });

  const PICKUP_RE = /pick[\s-]*up/i;
  const nonPickupApplicable = shipping_options.filter(
    (o) => o.applicable && Number.isFinite(o.price) && !PICKUP_RE.test(o.method),
  );

  const estimated_shipping = nonPickupApplicable.length > 0
    ? Math.min(...nonPickupApplicable.map((o) => o.price))
    : null;

  return {
    shipping_options,
    estimated_shipping,
    source: shipping_options.some((o) => o.source === 'slot_id') ? 'slot_id' : shipping_options.length ? 'list_pair' : 'missing',
    confidence: shipping_options.some((o) => o.source === 'slot_id') ? 0.97 : shipping_options.length ? 0.8 : 0.1,
    raw_shipping_texts: shipping_options.map((o) => `${o.method}: ${o.raw_text}`),
  };
}