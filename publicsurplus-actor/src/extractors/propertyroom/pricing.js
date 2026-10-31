import { PRICE_LABEL_IDS } from './selectors.js';
import { parsePercentText } from './textParsers.js';

export async function extractPricing(page, jsVars = {}) {
  const pricing = await page.evaluate((ids) => {
    const result = {
      priceLabel: '',
      priceValue: null,
      rawPriceText: '',
      rawLabelText: '',
    };

    const labelEl = document.querySelector(ids.label);
    const priceEl = document.querySelector(ids.value);

    if (labelEl) {
      result.priceLabel = labelEl.textContent?.trim() ?? '';
      result.rawLabelText = result.priceLabel;
    }

    if (priceEl) {
      result.rawPriceText = priceEl.textContent?.trim() ?? '';
      const m = result.rawPriceText.match(/\$\s*([\d,]+(?:\.\d+)?)/);
      if (m) result.priceValue = parseFloat(m[1].replace(/,/g, ''));
    }

    if (!result.priceLabel || result.priceValue === null) {
      const labels = ['Buy Now Price', 'Current Price', 'Current Bid', 'Starting Bid', 'Starting Price'];
      for (const el of document.querySelectorAll('li, div, span')) {
        const t = el.textContent?.trim() ?? '';
        for (const lbl of labels) {
          if (t.toLowerCase() === lbl.toLowerCase()) {
            if (!result.priceLabel) {
              result.priceLabel = t;
              result.rawLabelText = t;
            }

            if (result.priceValue === null) {
              const next = el.nextElementSibling;
              const nextText = next?.textContent?.trim() ?? '';
              result.rawPriceText = result.rawPriceText || nextText;
              const pm = nextText.match(/\$\s*([\d,]+(?:\.\d+)?)/);
              if (pm) result.priceValue = parseFloat(pm[1].replace(/,/g, ''));
            }
            break;
          }
        }
        if (result.priceLabel && result.priceValue !== null) break;
      }
    }

    if (result.priceValue === null) {
      const container = document.querySelector('.current-price-propductpage');
      const text = container?.textContent?.trim() ?? '';
      if (text) {
        result.rawPriceText = result.rawPriceText || text;
        const m = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
        if (m) result.priceValue = parseFloat(m[1].replace(/,/g, ''));
      }
    }

    if (result.priceValue === null) {
      const priceItemprop = document.querySelector('[itemprop="price"]');
      const val = priceItemprop?.content || priceItemprop?.textContent?.trim() || '';
      if (val) {
        result.rawPriceText = result.rawPriceText || String(val);
        const m = String(val).match(/([\d,]+(?:\.\d+)?)/);
        if (m) result.priceValue = parseFloat(m[1].replace(/,/g, ''));
      }
    }

    return result;
  }, PRICE_LABEL_IDS);

  const listingFormat = (jsVars.LISTING_FORMAT || '').toLowerCase();
  const label = (pricing.priceLabel || '').toLowerCase();
  const value = Number.isFinite(pricing.priceValue) ? pricing.priceValue : null;

  let buy_now_price = null;
  let current_bid = null;
  let starting_bid = null;
  let source = 'unknown';
  let confidence = 0.4;

  if (label.includes('buy now') || listingFormat === 'fixed price') {
    buy_now_price = value;
    source = label ? 'dom_price_id_or_label' : 'listing_format_inference';
    confidence = label ? 0.96 : 0.82;
  } else if (label.includes('current bid') || label.includes('current price')) {
    current_bid = value;
    source = 'dom_price_id_or_label';
    confidence = 0.96;
  } else if (label.includes('starting bid') || label.includes('starting price')) {
    starting_bid = value;
    source = 'dom_price_id_or_label';
    confidence = 0.93;
  } else if (value !== null) {
    if (listingFormat === 'auction') {
      current_bid = value;
      source = 'listing_format_inference';
      confidence = 0.78;
    } else {
      buy_now_price = value;
      source = 'listing_format_inference';
      confidence = 0.76;
    }
  }

  let current_price = null;
  let price_type = 'unknown';

  if (buy_now_price !== null) {
    current_price = buy_now_price;
    price_type = 'buy_now';
  } else if (current_bid !== null) {
    current_price = current_bid;
    price_type = 'current_bid';
  } else if (starting_bid !== null) {
    current_price = starting_bid;
    price_type = 'starting_bid';
  }

  return {
    current_price,
    buy_now_price,
    current_bid,
    starting_bid,
    price_type,
    source,
    confidence,
    raw_label: pricing.rawLabelText || null,
    raw_value_text: pricing.rawPriceText || null,
  };
}

export function buildBuyersPremiumInterpretation(rawText, numericValue) {
  const percentage = parsePercentText(rawText);
  const hasPercent = percentage !== null;

  return {
    raw_text: rawText || null,
    numeric_extracted: numericValue,
    interpreted_type: hasPercent ? 'percentage' : numericValue !== null ? 'amount' : 'unknown',
    percentage,
    amount: hasPercent ? null : numericValue,
    confidence: hasPercent ? 0.9 : numericValue !== null ? 0.7 : 0.2,
  };
}