/**
 * Quick Playwright script to inspect PropertyRoom listing DOM structure
 * for pricing and shipping elements.
 */
import { chromium } from 'playwright';

const URLS = [
  'https://www.propertyroom.com/l/apple-cell-phone-mu693lla/18533554',
  'https://www.propertyroom.com/l/hdmi-bi-direction-switch-hub-splitter/18571918',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  for (const url of URLS) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`INSPECTING: ${url}`);
    console.log(`${'='.repeat(100)}\n`);

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait a bit for any JS rendering
      await page.waitForTimeout(3000);

      const title = await page.title();
      console.log(`PAGE TITLE: ${title}\n`);

      // 1. Extract all JS variables related to listing
      const jsVars = await page.evaluate(() => {
        const result = {};
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        const allText = scripts.map(s => s.textContent || '').join('\n');

        const varNames = [
          'LISTING_ID', 'LISTING_TITLE', 'LISTING_FORMAT',
          'HAS_FREE_SHIPPING', 'CONTENT_IMAGE_PATH',
          'CURRENT_PRICE', 'STARTING_BID', 'BUY_NOW_PRICE',
          'LISTING_TYPE', 'IS_BUY_NOW', 'SHIPPING_COST',
          'listingFormat', 'listingId', 'listingType',
        ];

        for (const name of varNames) {
          const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(?:['"](.+?)['"]|(\\d+\\.?\\d*)|([^;\\n]+))\\s*[;\\n]`);
          const m = allText.match(re);
          if (m) {
            result[name] = (m[1] ?? m[2] ?? m[3] ?? '').trim();
          }
        }
        return result;
      });
      console.log('=== JS VARIABLES ===');
      console.log(JSON.stringify(jsVars, null, 2));
      console.log('');

      // 2. Find ALL elements containing price/bid/buy-now related text
      const priceElements = await page.evaluate(() => {
        const results = [];
        const patterns = [
          /current\s*price/i,
          /current\s*bid/i,
          /buy\s*now/i,
          /starting\s*bid/i,
          /winning\s*bid/i,
          /your\s*bid/i,
          /minimum\s*bid/i,
          /bid\s*amount/i,
          /price/i,
        ];

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent?.trim() || '';
          if (text.length > 500) continue; // skip large containers

          for (const pat of patterns) {
            if (pat.test(text)) {
              // Get the outer HTML of this element (truncated)
              const html = node.outerHTML;
              if (html.length > 2000) continue;

              results.push({
                tag: node.tagName.toLowerCase(),
                id: node.id || '',
                className: node.className || '',
                text: text.slice(0, 200),
                html: html.slice(0, 1000),
                parentTag: node.parentElement?.tagName?.toLowerCase() || '',
                parentClass: node.parentElement?.className || '',
                parentId: node.parentElement?.id || '',
              });
              break;
            }
          }
        }
        return results;
      });

      console.log('=== PRICE/BID ELEMENTS ===');
      for (const el of priceElements) {
        console.log(`\n--- ${el.tag}${el.id ? '#'+el.id : ''}.${el.className} ---`);
        console.log(`  Text: ${el.text}`);
        console.log(`  Parent: ${el.parentTag}${el.parentId ? '#'+el.parentId : ''}.${el.parentClass}`);
        console.log(`  HTML: ${el.html}`);
      }
      console.log('');

      // 3. Find shipping-related elements
      const shippingElements = await page.evaluate(() => {
        const results = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent?.trim() || '';
          if (text.length > 1000) continue;

          if (/shipping|pick[\s-]*up|expedited|delivery method/i.test(text)) {
            // Only get elements that are somewhat specific (not the whole body)
            const html = node.outerHTML;
            if (html.length > 3000) continue;

            results.push({
              tag: node.tagName.toLowerCase(),
              id: node.id || '',
              className: node.className || '',
              text: text.slice(0, 300),
              html: html.slice(0, 2000),
            });
          }
        }
        return results;
      });

      console.log('=== SHIPPING ELEMENTS ===');
      for (const el of shippingElements) {
        console.log(`\n--- ${el.tag}${el.id ? '#'+el.id : ''}.${el.className} ---`);
        console.log(`  Text: ${el.text}`);
        console.log(`  HTML: ${el.html}`);
      }
      console.log('');

      // 4. Search for elements with class names containing price/bid/shipping
      const classElements = await page.evaluate(() => {
        const results = [];
        const selectors = [
          '[class*="price"]', '[class*="Price"]',
          '[class*="bid"]', '[class*="Bid"]',
          '[class*="shipping"]', '[class*="Shipping"]',
          '[class*="cost"]', '[class*="Cost"]',
          '[class*="fee"]', '[class*="Fee"]',
          '[class*="premium"]', '[class*="Premium"]',
          '[class*="buy"]', '[class*="Buy"]',
          '[id*="price"]', '[id*="Price"]',
          '[id*="bid"]', '[id*="Bid"]',
          '[id*="shipping"]', '[id*="Shipping"]',
          '.uxPrice', '#uxPrice',
          '[id*="ux"]',
        ];

        for (const sel of selectors) {
          try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const html = el.outerHTML;
              if (html.length > 2000) continue;
              results.push({
                selector: sel,
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                className: el.className || '',
                text: (el.textContent?.trim() || '').slice(0, 300),
                html: html.slice(0, 1500),
              });
            }
          } catch {}
        }
        return results;
      });

      console.log('=== ELEMENTS WITH PRICE/BID/SHIPPING CLASS NAMES ===');
      for (const el of classElements) {
        console.log(`\n--- Matched: ${el.selector} → ${el.tag}#${el.id}.${el.className} ---`);
        console.log(`  Text: ${el.text}`);
        console.log(`  HTML: ${el.html}`);
      }
      console.log('');

      // 5. Dump the main content area HTML for reference
      const mainContent = await page.evaluate(() => {
        const main = document.querySelector('#MainContent')
          || document.querySelector('main')
          || document.querySelector('[role="main"]')
          || document.querySelector('.main-content');
        if (!main) return 'NO MAIN CONTENT FOUND';
        return main.innerHTML.slice(0, 15000);
      });
      console.log('=== MAIN CONTENT AREA (first 15000 chars) ===');
      console.log(mainContent);
      console.log('');

    } catch (err) {
      console.error(`ERROR loading ${url}: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
})();