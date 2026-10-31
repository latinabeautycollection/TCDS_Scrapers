import { JS_VAR_NAMES, LABELS, PROPERTYROOM_CONSTANTS, SELECTORS } from './selectors.js';
import { chooseFirstField, makeFieldValue } from './provenance.js';
import {
  allImageSrcs,
  extractJsVars,
  extractJsonLd,
  extractNumberAfterLabel,
  extractTextAfterLabel,
  firstText,
  getBodyText,
  metaContent,
} from './pageDom.js';
import {
  cleanDescriptionText,
  extractPickupLocationFromText,
  normalizeLocationText,
  splitLocationParts,
  stripBoilerplate,
} from './textParsers.js';
import { extractPricing, buildBuyersPremiumInterpretation } from './pricing.js';
import { extractShippingOptions } from './shipping.js';
import { extractAttributes } from './attributes.js';
import { detectPageSignals } from './signals.js';
import { externalIdFromUrl, listingIdFromUrl } from './urlHelpers.js';

async function extractCategoryFromBreadcrumb(page) {
  try {
    const category = await page.evaluate(() => {
      const breadcrumbs = Array.from(
        document.querySelectorAll('a[href*="/c/"], .breadcrumb a, nav[aria-label="breadcrumb"] a'),
      );
      if (breadcrumbs.length === 0) return '';
      const last = breadcrumbs[breadcrumbs.length - 1];
      return last.textContent?.trim() ?? '';
    });
    return category || '';
  } catch {
    return '';
  }
}

async function extractEndTime(page) {
  try {
    const result = await page.evaluate(() => {
      const timerEl =
        document.querySelector('[data-end-time]') ||
        document.querySelector('[data-endtime]') ||
        document.querySelector('[data-expires]') ||
        document.querySelector('[data-countdown]') ||
        document.querySelector('time[datetime]');

      if (timerEl) {
        const attr =
          timerEl.getAttribute('data-end-time') ||
          timerEl.getAttribute('data-endtime') ||
          timerEl.getAttribute('data-expires') ||
          timerEl.getAttribute('datetime');

        if (attr) {
          return {
            raw: attr,
            source: 'timer_attribute',
            confidence: 0.95,
          };
        }
      }

      const body = document.body.innerText || '';

      const endsMatch = body.match(/Ends?\s+([A-Za-z]{3}\s+\d{1,2},?\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*\(?[A-Za-z]*\)?)/i);
      if (endsMatch) {
        return {
          raw: endsMatch[1].replace(/[()]/g, '').trim(),
          source: 'body_regex_primary',
          confidence: 0.8,
        };
      }

      const m = body.match(/(?:ends?|closes?|closing|auction end)[:\s]+([A-Za-z0-9 :,/\-.]+?(?:AM|PM|EST|EDT|PST|PDT|GMT|UTC|Eastern|Pacific|Central))/i);
      if (m) {
        return {
          raw: m[1].trim(),
          source: 'body_regex_fallback',
          confidence: 0.65,
        };
      }

      return {
        raw: '',
        source: 'missing',
        confidence: 0,
      };
    });

    return result;
  } catch {
    return { raw: '', source: 'missing', confidence: 0 };
  }
}

async function extractLocationField(page) {
  const labelLocation = await extractTextAfterLabel(page, LABELS.location);
  if (labelLocation?.trim()) {
    const normalized = normalizeLocationText(labelLocation.trim());
    return makeFieldValue(normalized, 'location_label', 0.94, labelLocation);
  }

  const bodyText = await getBodyText(page);
  const pickupLoc = extractPickupLocationFromText(bodyText);
  if (pickupLoc) {
    return makeFieldValue(pickupLoc, 'pickup_text_regex', 0.72, pickupLoc);
  }

  const cssLocation = await firstText(page, SELECTORS.location);
  if (cssLocation?.trim()) {
    const normalized = normalizeLocationText(cssLocation.trim());
    return makeFieldValue(normalized, 'location_css', 0.65, cssLocation);
  }

  return makeFieldValue('', 'missing', 0, null);
}

export async function extractPropertyRoomDetail({ page, url, debug = false, log }) {
  const pageSignals = await detectPageSignals(page);

  if (pageSignals.blocked) {
    return {
      blocked: true,
      page_state: 'blocked',
      page_signals: pageSignals,
    };
  }

  const jsVars = await extractJsVars(page, JS_VAR_NAMES);
  const productLd = await extractJsonLd(page, 'Product');
  const ogTitle = await metaContent(page, 'og:title');
  const ogDescription = await metaContent(page, 'og:description');

  const titleField = chooseFirstField(
    jsVars.LISTING_TITLE ? makeFieldValue(jsVars.LISTING_TITLE, 'js_var', 0.99, jsVars.LISTING_TITLE) : null,
    productLd?.name ? makeFieldValue(productLd.name, 'json_ld', 0.92, productLd.name) : null,
    ogTitle ? makeFieldValue(ogTitle, 'og_meta', 0.85, ogTitle) : null,
    (await firstText(page, SELECTORS.title)) ? makeFieldValue(await firstText(page, SELECTORS.title), 'css_selector', 0.74, await firstText(page, SELECTORS.title)) : null,
  );

  const rawDescription = chooseFirstField(
    productLd?.description ? makeFieldValue(productLd.description, 'json_ld', 0.9, productLd.description) : null,
    ogDescription ? makeFieldValue(ogDescription, 'og_meta', 0.82, ogDescription) : null,
    (await firstText(page, SELECTORS.description)) ? makeFieldValue(await firstText(page, SELECTORS.description), 'css_selector', 0.76, await firstText(page, SELECTORS.description)) : null,
  );

  const descriptionClean = cleanDescriptionText(rawDescription.value || '');
  const descriptionFinal = stripBoilerplate(descriptionClean);

  const categoryText = (await extractCategoryFromBreadcrumb(page)) || (await firstText(page, SELECTORS.category));
  const categoryField = categoryText
    ? makeFieldValue(categoryText, categoryText === await firstText(page, SELECTORS.category) ? 'css_selector' : 'breadcrumb', categoryText === await firstText(page, SELECTORS.category) ? 0.7 : 0.9, categoryText)
    : makeFieldValue('', 'missing', 0, null);

  const conditionLabel = await extractTextAfterLabel(page, LABELS.condition);
  const conditionCss = await firstText(page, SELECTORS.condition);
  const conditionField = chooseFirstField(
    conditionLabel ? makeFieldValue(conditionLabel, 'label_text', 0.84, conditionLabel) : null,
    conditionCss ? makeFieldValue(conditionCss, 'css_selector', 0.72, conditionCss) : null,
  );

  const pricing = await extractPricing(page, jsVars);
  const shipping = await extractShippingOptions(page);
  const buyersPremiumRawText = await extractTextAfterLabel(page, LABELS.buyersPremium);
  const buyersPremiumRawNumber = await extractNumberAfterLabel(page, LABELS.buyersPremium);
  const buyersPremium = buildBuyersPremiumInterpretation(buyersPremiumRawText, buyersPremiumRawNumber);

  const locationField = await extractLocationField(page);
  const locationParts = splitLocationParts(locationField.value);

  const endTime = await extractEndTime(page);
  const images = await allImageSrcs(page, SELECTORS.image);
  const attrs = await extractAttributes(page);

  const listingId = jsVars.LISTING_ID || listingIdFromUrl(url);
  const externalId = listingId ? `propertyroom-${listingId}` : externalIdFromUrl(url);

  const primaryImage = images[0] || null;

  const raw = {
    source: 'propertyroom',
    external_id: externalId,
    listing_id: listingId || null,
    listing_url: url,
    title: titleField.value || '',
    category: categoryField.value || '',
    condition: conditionField.value || '',
    description: descriptionFinal || '',
    current_price: pricing.current_price,
    estimated_shipping: shipping.estimated_shipping,
    buyers_premium: buyersPremium.amount,
    auction_end_time: endTime.raw || '',
    location: locationField.value || '',
    image_urls: images,
    primary_image_url: primaryImage,
    attributes: {
      trusted: attrs.trusted_attributes,
      mined: attrs.mined_attributes,
    },
    source_meta: {
      page_state: pageSignals.page_state,
      title: titleField,
      category: categoryField,
      condition: conditionField,
      description: {
        source: rawDescription.source,
        confidence: rawDescription.confidence,
        raw: rawDescription.raw,
      },
      price: {
        source: pricing.source,
        confidence: pricing.confidence,
        raw_label: pricing.raw_label,
        raw_value_text: pricing.raw_value_text,
        price_type: pricing.price_type,
        buy_now_price: pricing.buy_now_price,
        current_bid: pricing.current_bid,
        starting_bid: pricing.starting_bid,
      },
      shipping: {
        source: shipping.source,
        confidence: shipping.confidence,
        raw_shipping_texts: shipping.raw_shipping_texts,
      },
      buyers_premium: buyersPremium,
      location: {
        source: locationField.source,
        confidence: locationField.confidence,
        raw: locationField.raw,
        city: locationParts.city,
        state: locationParts.state,
        country: locationParts.country,
      },
      auction_end_time: {
        source: endTime.source,
        confidence: endTime.confidence,
        raw: endTime.raw,
      },
      page_signals,
    },
    record_lineage: {
      extractor: 'propertyroom',
      extractor_version: '2.0.0',
      extracted_at: new Date().toISOString(),
    },
  };

  if (debug) {
    log.debug('PropertyRoom detail extracted', {
      external_id: raw.external_id,
      title: raw.title?.slice(0, 80),
      price: raw.current_price,
      shipping: raw.estimated_shipping,
      premium_type: buyersPremium.interpreted_type,
      location: raw.location,
      page_state: pageSignals.page_state,
      image_count: raw.image_urls.length,
      trusted_attr_count: Object.keys(raw.attributes.trusted || {}).length,
      mined_attr_count: Object.keys(raw.attributes.mined || {}).length,
    });
  }

  return {
    blocked: false,
    page_state: pageSignals.page_state,
    raw,
  };
}