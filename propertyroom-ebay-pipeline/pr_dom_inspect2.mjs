/**
 * Inspect PropertyRoom listing pages - check for redirects and wait properly
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
    viewport: { width: 1280, height: 800 },
  });

  for (const url of URLS) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`NAVIGATING TO: ${url}`);
    console.log(`${'='.repeat(80)}\n`);

    const page = await context.newPage();

    // Listen for all requests and responses to detect redirects
    const responses = [];
    page.on('response', (resp) => {
      if (resp.url().includes('propertyroom.com')) {
        responses.push({ url: resp.url(), status: resp.status(), headers: resp.headers() });
      }
    });

    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

      console.log('INITIAL RESPONSE:');
      console.log(`  Status: ${response.status()}`);
      console.log(`  URL: ${response.url()}`);
      console.log(`  Final URL: ${page.url()}`);
      console.log(`  Page Title: ${await page.title()}`);
      console.log('');

      // Check for meta refresh redirects
      const metaRefresh = await page.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        return meta ? meta.content : null;
      });
      if (metaRefresh) console.log(`META REFRESH: ${metaRefresh}`);

      // Check for JS-based location changes
      const jsLocationChange = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        const allText = scripts.map(s => s.textContent || '').join('\n');
        // Look for window.location or location.href assignments
        const matches = allText.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/g);
        return matches || [];
      });
      if (jsLocationChange.length) {
        console.log('JS LOCATION CHANGES:', jsLocationChange);
      }

      // Wait extra time and check if page changes
      await page.waitForTimeout(5000);
      console.log(`AFTER 5s WAIT - URL: ${page.url()}`);
      console.log(`AFTER 5s WAIT - Title: ${await page.title()}`);

      // Check if there's an auction that has ended and it redirected us
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log(`\nBODY TEXT (first 500 chars):\n${bodyText}`);

      // Print all propertyroom.com responses
      console.log('\nALL PROPERTYROOM RESPONSES:');
      for (const r of responses.slice(0, 20)) {
        console.log(`  ${r.status} ${r.url.slice(0, 120)}`);
      }

    } catch (err) {
      console.error(`ERROR: ${err.message}`);
    } finally {
      await page.close();
    }
  }

  // Now try some ACTIVE listings from the homepage
  console.log('\n\n' + '='.repeat(80));
  console.log('ATTEMPTING TO FIND AND LOAD AN ACTIVE LISTING');
  console.log('='.repeat(80));

  const page = await context.newPage();
  try {
    await page.goto('https://www.propertyroom.com', { waitUntil: 'networkidle', timeout: 45000 });

    // Get listing links from homepage
    const listingLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/l/"]'));
      return links
        .map(a => ({ href: a.href, text: (a.textContent?.trim() || '').slice(0, 60) }))
        .filter(l => /\/l\/[^/]+\/\d+/.test(l.href))
        .slice(0, 5);
    });

    console.log('\nFOUND LISTING LINKS ON HOMEPAGE:');
    for (const link of listingLinks) {
      console.log(`  ${link.text} → ${link.href}`);
    }

    if (listingLinks.length > 0) {
      const targetUrl = listingLinks[0].href;
      console.log(`\nNAVIGATING TO FIRST ACTIVE LISTING: ${targetUrl}`);

      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      console.log(`FINAL URL: ${page.url()}`);
      console.log(`TITLE: ${await page.title()}`);

      // Check if we landed on a detail page
      const isDetailPage = await page.evaluate(() => {
        // PropertyRoom detail pages should have LISTING_ID or similar
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        const allText = scripts.map(s => s.textContent || '').join('\n');
        const hasListingId = allText.includes('LISTING_ID');
        const hasCurrentPrice = document.body.innerText.includes('Current Price');
        const hasCurrentBid = document.body.innerText.includes('Current Bid');
        return { hasListingId, hasCurrentPrice, hasCurrentBid };
      });
      console.log('DETAIL PAGE MARKERS:', JSON.stringify(isDetailPage));

      if (isDetailPage.hasListingId || isDetailPage.hasCurrentPrice || isDetailPage.hasCurrentBid) {
        // We're on a detail page - extract the full DOM structure
        console.log('\n=== SUCCESSFULLY LANDED ON DETAIL PAGE ===');

        // Extract JS variables
        const jsVars = await page.evaluate(() => {
          const result = {};
          const scripts = Array.from(document.querySelectorAll('script:not([src])'));
          const allText = scripts.map(s => s.textContent || '').join('\n');
          const varNames = [
            'LISTING_ID', 'LISTING_TITLE', 'LISTING_FORMAT',
            'HAS_FREE_SHIPPING', 'CONTENT_IMAGE_PATH',
            'CURRENT_PRICE', 'STARTING_BID', 'BUY_NOW_PRICE',
          ];
          for (const name of varNames) {
            const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(?:['"](.+?)['"]|(\\d+\\.?\\d*)|([^;\\n]+))\\s*[;\\n]`);
            const m = allText.match(re);
            if (m) result[name] = (m[1] ?? m[2] ?? m[3] ?? '').trim();
          }
          return result;
        });
        console.log('\nJS VARIABLES:', JSON.stringify(jsVars, null, 2));

        // Get ALL inline script text related to listing
        const listingScripts = await page.evaluate(() => {
          const scripts = Array.from(document.querySelectorAll('script:not([src])'));
          const relevant = [];
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes('LISTING') || text.includes('listing') ||
                text.includes('price') || text.includes('Price') ||
                text.includes('bid') || text.includes('Bid') ||
                text.includes('shipping') || text.includes('Shipping') ||
                text.includes('buy') || text.includes('Buy')) {
              relevant.push(text.trim().slice(0, 3000));
            }
          }
          return relevant;
        });
        console.log('\nRELEVANT INLINE SCRIPTS:');
        for (let i = 0; i < listingScripts.length; i++) {
          console.log(`\n--- Script ${i+1} ---`);
          console.log(listingScripts[i]);
        }

        // Get all elements matching price/bid patterns with their HTML
        const priceHTML = await page.evaluate(() => {
          const results = [];
          // Look for elements with small text content matching price patterns
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            if (el.children.length > 5) continue; // skip large containers
            const text = el.textContent?.trim() || '';
            if (text.length > 200) continue;

            if (/current\s*(?:price|bid)|buy\s*now|starting\s*bid|winning\s*bid|minimum\s*bid|\$\s*\d/i.test(text)) {
              // Skip if parent already captured
              const html = el.outerHTML;
              if (html.length > 1500) continue;

              results.push({
                tag: el.tagName.toLowerCase(),
                id: el.id,
                className: typeof el.className === 'string' ? el.className : '',
                text: text,
                html: html,
              });
            }
          }
          return results;
        });
        console.log('\nPRICE/BID HTML ELEMENTS:');
        for (const el of priceHTML) {
          console.log(`\n[${el.tag}#${el.id}.${el.className}] text="${el.text}"`);
          console.log(el.html);
        }

        // Get shipping section HTML
        const shippingHTML = await page.evaluate(() => {
          const results = [];
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            const text = el.textContent?.trim() || '';
            if (text.length > 800) continue;
            if (!/shipping|pick[\s-]*up|expedited|delivery/i.test(text)) continue;
            const html = el.outerHTML;
            if (html.length > 3000) continue;

            results.push({
              tag: el.tagName.toLowerCase(),
              id: el.id,
              className: typeof el.className === 'string' ? el.className : '',
              text: text.slice(0, 300),
              html: html,
            });
          }
          return results;
        });
        console.log('\nSHIPPING HTML ELEMENTS:');
        for (const el of shippingHTML) {
          console.log(`\n[${el.tag}#${el.id}.${el.className}] text="${el.text}"`);
          console.log(el.html);
        }

        // Get the main content div
        const mainHTML = await page.evaluate(() => {
          const main = document.querySelector('#MainContent') || document.querySelector('main');
          if (!main) return 'NO MAIN CONTENT';
          return main.innerHTML.slice(0, 20000);
        });
        console.log('\nMAIN CONTENT HTML (20k chars):');
        console.log(mainHTML);

      } else {
        console.log('\nNOT A DETAIL PAGE - probably redirected to homepage');
        const bodyText2 = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`Body text: ${bodyText2}`);
      }
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  } finally {
    await page.close();
  }

  await browser.close();
})();