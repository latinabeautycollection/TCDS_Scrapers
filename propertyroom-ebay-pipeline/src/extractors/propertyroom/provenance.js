export function makeFieldValue(value, source = 'unknown', confidence = 0.5, raw = null) {
  return {
    value,
    source,
    confidence,
    raw,
  };
}

export function chooseFirstField(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const val = c.value;
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' && !val.trim()) continue;
    return c;
  }
  return makeFieldValue('', 'missing', 0, null);
}