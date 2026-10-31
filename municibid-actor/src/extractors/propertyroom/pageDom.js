export async function firstText(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = (await el.textContent())?.trim() || '';
      if (text) return text;
    } catch {
      // ignore selector errors
    }
  }
  return '';
}

export async function metaContent(page, key) {
  try {
    return (
      await page.evaluate((k) => {
        const el =
          document.querySelector(`meta[name="${k}"]`) ||
          document.querySelector(`meta[property="${k}"]`);
        return el?.content ?? '';
      }, key)
    ) ?? '';
  } catch {
    return '';
  }
}

export async function extractJsonLd(page, targetType) {
  try {
    return await page.evaluate((type) => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts) {
        try {
          const obj = JSON.parse(s.textContent ?? '');
          const arr = Array.isArray(obj) ? obj : [obj];
          for (const item of arr) {
            if (item?.['@type'] === type) return item;
          }
        } catch {
          // ignore malformed JSON
        }
      }
      return null;
    }, targetType);
  } catch {
    return null;
  }
}

export async function extractJsVars(page, varNames) {
  try {
    return await page.evaluate((names) => {
      const result = {};
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      const allText = scripts.map((s) => s.textContent ?? '').join('\n');

      for (const name of names) {
        const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*(?:['"](.+?)['"]|(\\d+\\.?\\d*)|([^;]+))\\s*;`);
        const m = allText.match(re);
        if (m) result[name] = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      }

      return result;
    }, varNames);
  } catch {
    return {};
  }
}

export async function extractTextAfterLabel(page, labels) {
  try {
    const result = await page.evaluate((labelList) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent ?? '';
        for (const label of labelList) {
          const idx = text.toLowerCase().indexOf(label.toLowerCase());
          if (idx === -1) continue;

          const afterLabel = text.slice(idx + label.length);
          const m = afterLabel.match(/^[:\s]+(.+?)(?:\n|$)/);
          if (m) {
            const val = m[1].trim();
            if (val && val.length < 200) return val;
          }

          const parentText = node.parentElement?.textContent ?? '';
          const pIdx = parentText.toLowerCase().indexOf(label.toLowerCase());
          if (pIdx !== -1) {
            const afterParent = parentText.slice(pIdx + label.length);
            const pm = afterParent.match(/^[:\s]+(.+?)(?:\n|$)/);
            if (pm) {
              const pv = pm[1].trim();
              if (pv && pv.length < 200) return pv;
            }
          }
        }
      }

      return '';
    }, labels);

    return result ?? '';
  } catch {
    return '';
  }
}

export async function extractNumberAfterLabel(page, labels) {
  try {
    const result = await page.evaluate((labelList) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        const text = node.textContent ?? '';

        for (const label of labelList) {
          const idx = text.toLowerCase().indexOf(label.toLowerCase());
          if (idx === -1) continue;

          const after = text.slice(idx + label.length);
          const m = after.match(/^[:\s]*[\$£€]?\s*([\d,]+(?:\.\d+)?)/);
          if (m) {
            const n = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(n) && n > 0) return n;
          }

          const parentText = node.parentElement?.textContent ?? '';
          const pIdx = parentText.toLowerCase().indexOf(label.toLowerCase());
          if (pIdx !== -1) {
            const afterParent = parentText.slice(pIdx + label.length);
            const pm = afterParent.match(/^[:\s]*[\$£€]?\s*([\d,]+(?:\.\d+)?)/);
            if (pm) {
              const pn = parseFloat(pm[1].replace(/,/g, ''));
              if (Number.isFinite(pn) && pn > 0) return pn;
            }
          }
        }
      }

      return null;
    }, labels);

    return result;
  } catch {
    return null;
  }
}

export async function allImageSrcs(page, selectors) {
  return page.evaluate((selectorList) => {
    const seen = new Set();
    const results = [];

    const JUNK_IMG_RE = /\/(thumbnails-navigation|icon-magnifying|quick-links|pagination-|logo|favicon|sprite|placeholder|loading|banner)/i;
    const MERCHANT_BANNER_RE = /\/banners\/merchants\//i;

    function add(url) {
      if (!url) return;
      const cleaned = String(url).trim();
      if (!cleaned || cleaned.startsWith('data:') || seen.has(cleaned)) return;
      if (JUNK_IMG_RE.test(cleaned)) return;
      if (MERCHANT_BANNER_RE.test(cleaned)) return;
      if (cleaned.endsWith('/undefined') || cleaned.endsWith('/null')) return;
      if (/^\/images\//i.test(cleaned)) return;
      if (/^https?:\/\/[^/]+\/images\/\d+$/.test(cleaned)) return;

      seen.add(cleaned);
      results.push(cleaned);
    }

    function bestFromSrcset(srcset) {
      if (!srcset) return '';
      let best = '';
      let bestW = 0;

      for (const entry of srcset.split(',')) {
        const parts = entry.trim().split(/\s+/);
        const url = parts[0] || '';
        const w = Number.parseInt((parts[1] || '').replace(/[^\d]/g, ''), 10) || 0;
        if (url && w > bestW) {
          bestW = w;
          best = url;
        }
      }

      return best || (srcset.split(',')[0] || '').trim().split(/\s+/)[0] || '';
    }

    for (const sel of selectorList) {
      try {
        const imgs = Array.from(document.querySelectorAll(sel));
        for (const img of imgs) {
          add(img.src);
          add(img.dataset?.src);
          add(img.dataset?.lazySrc);
          add(img.dataset?.lazysrc);
          add(img.dataset?.original);
          add(bestFromSrcset(img.srcset || img.dataset?.srcset));
        }
      } catch {
        // ignore
      }
    }

    const bgSelectors = [
      '.sp-wrap [style]',
      '.gallery [style]',
      '[class*="slide"] [style]',
      '[class*="carousel"] [style]',
      '[class*="photo"] [style]',
    ];

    for (const sel of bgSelectors) {
      try {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const bg = el.style.backgroundImage || '';
          const m = bg.match(/url\(["']?(.+?)["']?\)/);
          if (m?.[1]) add(m[1]);
        }
      } catch {
        // ignore
      }
    }

    try {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts) {
        try {
          const obj = JSON.parse(s.textContent ?? '');
          const items = Array.isArray(obj) ? obj : [obj];
          for (const item of items) {
            if (item?.['@type'] === 'Product' || item?.['@type'] === 'Offer') {
              const imgs = item.image;
              if (typeof imgs === 'string') add(imgs);
              else if (Array.isArray(imgs)) imgs.forEach((u) => add(typeof u === 'string' ? u : u?.url));
            }
          }
        } catch {
          // ignore malformed JSON
        }
      }
    } catch {
      // ignore
    }

    try {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg?.content) add(ogImg.content);
    } catch {
      // ignore
    }

    return results;
  }, selectors);
}

export async function getBodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || '');
  } catch {
    return '';
  }
}

export async function getHtmlSnippet(page, maxLength = 3000) {
  try {
    const html = await page.content();
    return html.slice(0, maxLength);
  } catch {
    return '';
  }
}