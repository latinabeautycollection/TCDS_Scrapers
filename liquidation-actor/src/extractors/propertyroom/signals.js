/**
 * signals.js — Detect page-level signals (blocked, unavailable, active).
 *
 * Scans the visible page text against BLOCK_INDICATORS and
 * UNAVAILABLE_INDICATORS from selectors.js to classify page state.
 */

import { BLOCK_INDICATORS, UNAVAILABLE_INDICATORS } from './selectors.js';

/**
 * Detect whether the page is blocked, unavailable, or active.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{blocked: boolean, unavailable: boolean, page_state: string}>}
 */
export async function detectPageSignals(page) {
  const bodyText = await page.evaluate(() => {
    return (document.body?.innerText || '').slice(0, 5000);
  });

  // Check for block/challenge pages (captcha, access denied, etc.)
  for (const pattern of BLOCK_INDICATORS) {
    if (pattern.test(bodyText)) {
      return { blocked: true, unavailable: false, page_state: 'blocked' };
    }
  }

  // Check for ended/removed/closed listings
  for (const pattern of UNAVAILABLE_INDICATORS) {
    if (pattern.test(bodyText)) {
      return { blocked: false, unavailable: true, page_state: 'unavailable' };
    }
  }

  // Page is live and accessible
  return { blocked: false, unavailable: false, page_state: 'active' };
}