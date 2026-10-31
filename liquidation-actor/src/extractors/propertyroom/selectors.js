export const PROPERTYROOM_CONSTANTS = Object.freeze({
  DOMAIN: 'https://www.propertyroom.com',
  DEFAULT_CURRENCY: 'USD',
  DEFAULT_COUNTRY: 'US',
  MAX_HTML_SNIPPET_LENGTH: 3000,
});

export const DETAIL_URL_PATTERNS = Object.freeze([
  /\/l\/[^/]+\/\d+/,
  /\/s\/\d+/,
]);

export const SELECTORS = Object.freeze({
  detailReady: [
    'h1',
    '.sp-wrap',
    '.bodyContent',
    '[itemprop="name"]',
  ],
  indexReady: [
    'a[href*="/l/"]',
    '.ListingContainer',
    '.product-info',
    '.item',
    '.listing',
  ],
  title: [
    'h1',
    '.item-title',
    'h1[class*="title"]',
    '[itemprop="name"]',
    '.listing-title',
  ],
  description: [
    '.bodyContent',
    '.disclaimerContent',
    '[itemprop="description"]',
    '.item-description',
    '#item-description',
    '.description-text',
    '.lot-description',
    '.product-description',
  ],
  condition: [
    '[itemprop="itemCondition"]',
    '.item-condition',
    '.condition-value',
  ],
  category: [
    '[itemprop="category"]',
    '.item-category',
  ],
  location: [
    '[itemprop="addressLocality"]',
    '.item-location',
    '.seller-location',
  ],
  image: [
    '.sp-wrap img',
    '.sp-thumbs img',
    '.gallery img',
    '.photo-gallery img',
    '.carousel img',
    '.slider img',
    '.thumbnail-list img',
    '[class*="gallery"] img',
    '[class*="photo"] img',
    '[class*="image"] img',
    '[class*="slide"] img',
    '[class*="carousel"] img',
    '.product-image img',
    '.product-image-container img',
    '.item-images img',
    '[itemprop="image"]',
    '#MainContent img[src*="content.propertyroom.com"]',
    'img[src*="content.propertyroom.com"]',
  ],
});

export const JS_VAR_NAMES = Object.freeze([
  'LISTING_ID',
  'LISTING_TITLE',
  'LISTING_FORMAT',
  'HAS_FREE_SHIPPING',
  'CONTENT_IMAGE_PATH',
]);

export const LABELS = Object.freeze({
  condition: [
    'Physical Condition',
    'Condition',
    'Item Condition',
  ],
  location: [
    'Shipping From',
    'Ships From',
  ],
  buyersPremium: [
    "Buyer's Premium",
    'Buyers Premium',
    'Buyer Premium',
    'Premium',
    'BP',
  ],
});

export const BOILERPLATE_HEADINGS = Object.freeze([
  'Shipping and Returns',
  'Payment and Sales Tax',
  'Warranties and Disclaimer',
  'Contact Information',
  'Please Click on the Logo Below',
  'View information on item conditions',
]);

export const SHIPPING_SLOT_IDS = Object.freeze([
  { id: 'MainContent_lblCustomerPrickupShipPrice', method: 'Customer Pick-up' },
  { id: 'MainContent_lblStandardShipPrice', method: 'Standard Shipping' },
  { id: 'MainContent_lblExpeditedShipPrice', method: 'Expedited Shipping' },
]);

export const PRICE_LABEL_IDS = Object.freeze({
  label: '#MainContent_uxTypeOfPrice',
  value: '#MainContent_uxPrice',
});

export const BLOCK_INDICATORS = Object.freeze([
  /access denied/i,
  /temporarily unavailable/i,
  /forbidden/i,
  /verify you are human/i,
  /captcha/i,
  /unusual traffic/i,
  /bot/i,
  /please enable javascript/i,
]);

export const UNAVAILABLE_INDICATORS = Object.freeze([
  /item not found/i,
  /listing not found/i,
  /auction closed/i,
  /auction ended/i,
  /no longer available/i,
  /item has ended/i,
]);