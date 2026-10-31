export async function extractAttributes(page) {
  const mined = await page.evaluate(() => {
    const trusted = {};
    const minedAttrs = {};

    const JUNK_KEY_PATTERNS = /^(home|back|next|previous|sign in|log in|register|add to cart|bid now|buy now|share|print|report|help|menu|search|loading|copyright|follow us|subscribe|×|close|ok|cancel|submit|see all|payment|disclaimer|warranties)/i;

    function cleanKey(key) {
      return String(key || '').trim().replace(/\s+/g, ' ').replace(/[:.;]+$/, '').trim();
    }

    function cleanVal(val) {
      return String(val || '').trim().replace(/\s+/g, ' ');
    }

    function shouldSkip(k, v) {
      if (!k || !v) return true;
      if (k.length > 60 || v.length > 300) return true;
      if (JUNK_KEY_PATTERNS.test(k)) return true;
      if (/^\d+$/.test(k)) return true;
      if (k.includes('@') || k.startsWith('http')) return true;
      return false;
    }

    function addTrusted(k, v) {
      const key = cleanKey(k);
      const val = cleanVal(v);
      if (shouldSkip(key, val)) return;
      trusted[key] = val;
    }

    function addMined(k, v) {
      const key = cleanKey(k);
      const val = cleanVal(v);
      if (shouldSkip(key, val)) return;
      if (!(key in trusted)) minedAttrs[key] = val;
    }

    const allLis = document.querySelectorAll('li');
    for (const li of allLis) {
      if (li.querySelector('ul, ol, li')) continue;
      const text = li.textContent?.trim() ?? '';
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0 && colonIdx < 60 && text.length < 300) {
        addTrusted(text.slice(0, colonIdx), text.slice(colonIdx + 1));
      }
    }

    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('th, td');
        if (cells.length >= 2) {
          const key = cells[0].textContent?.trim() ?? '';
          const val = cells[1].textContent?.trim() ?? '';
          addMined(key, val);
        }
      }
    }

    const allDts = document.querySelectorAll('dt');
    for (const dt of allDts) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') addMined(dt.textContent, dd.textContent);
    }

    return { trusted, mined: minedAttrs };
  });

  return {
    trusted_attributes: mined.trusted || {},
    mined_attributes: mined.mined || {},
  };
}