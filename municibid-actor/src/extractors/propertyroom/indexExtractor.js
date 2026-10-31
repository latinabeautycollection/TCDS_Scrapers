import { normalizeDetailUrl } from './urlHelpers.js';

export async function collectDetailUrls(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const seen = new Set();
    const results = [];

    for (const a of anchors) {
      const href = a.href || '';
      if (/\/l\/[^/]+\/\d+/.test(href) || /\/s\/\d+/.test(href)) {
        const clean = href.split('?')[0].split('#')[0];
        if (!seen.has(clean)) {
          seen.add(clean);
          results.push(clean);
        }
      }
    }

    return results;
  });
}

export async function findNextPageUrl(page, currentUrl) {
  return page.evaluate((curUrl) => {
    const paginationDiv = document.querySelector('.pagination, [class*="pagination"]');

    if (paginationDiv) {
      const links = Array.from(paginationDiv.querySelectorAll('a[href]'));

      for (const a of links) {
        const img = a.querySelector('img');
        if (img && /right|next/i.test(img.src || img.alt || '')) {
          const href = a.href;
          if (href && !href.endsWith('#') && !href.endsWith('/#')) {
            return href.split('#')[0];
          }
        }
      }

      let foundCurrent = false;
      for (const a of paginationDiv.querySelectorAll('a')) {
        const text = a.textContent?.trim();
        if (!text || !/^\d+$/.test(text)) continue;

        if (!a.href || a.href === curUrl || a.getAttribute('href') === '#') {
          foundCurrent = true;
          continue;
        }

        if (foundCurrent && a.href) return a.href.split('#')[0];
      }
    }

    const linkNext = document.querySelector('link[rel="next"]');
    if (linkNext?.href) return linkNext.href;

    const ariaNext = document.querySelector(
      'a[rel="next"], a[aria-label="Next"], a[aria-label="Next page"], .pager a.next',
    );
    if (ariaNext?.href) return ariaNext.href;

    if (paginationDiv) {
      for (const a of paginationDiv.querySelectorAll('a')) {
        const text = a.textContent?.trim();
        if ((text === '>' || text === '»' || /^next$/i.test(text)) && a.href) {
          return a.href.split('#')[0];
        }
      }
    }

    return null;
  }, currentUrl);
}

export function normalizeDetailUrlList(urls) {
  return Array.from(new Set(urls.map(normalizeDetailUrl).filter(Boolean)));
}