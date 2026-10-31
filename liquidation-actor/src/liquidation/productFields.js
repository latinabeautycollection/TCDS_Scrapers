const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = value => clean(value).replace(/[:.]+$/g, '').replace(/\s*#$/, '#').trim().toLowerCase();
const usable = value => value && value.length <= 100 && !/^(?:n\/?a|none|unknown|not available|not specified)$/i.test(value);

export function productFields(pairs = [], description = '', title = '') {
  const rows = [...pairs];
  for (const line of String(description).split(/[\r\n]+/)) {
    const match = line.trim().match(/^([^:]{1,40}):\s*(.{1,100})$/);
    if (match) rows.push({ label: match[1], value: match[2] });
  }
  const read = labels => {
    for (const label of labels) {
      const row = rows.find(row => key(row.label) === key(label) && usable(clean(row.value)));
      if (row) return clean(row.value);
    }
    return null;
  };
  const serial_number = read(['Serial Number', 'Serial #', 'Serial', 'S/N']);
  const vin = read(['VIN', 'Vehicle Identification Number']);
  const titleCode = String(title || '').match(/\bmodel\b(?:\s+(?:number|no\.?))?\s*[:#]?\s+([A-Z0-9][A-Z0-9._/-]{0,63})\b/i)?.[1];
  const model_number = read(['Model Number', 'Model #']);
  const model = read(['Model']) || model_number || (titleCode && /\d/.test(titleCode) ? titleCode : null);
  const explicit = read(['MPN', 'Manufacturer Part Number', 'Part Number', 'Part #', 'Part', 'Catalog Number', 'Catalogue Number', 'Catalog #', 'Catalogue #']) || model_number;
  const candidate = explicit || (model && /\d/.test(model) && /^[a-z0-9][a-z0-9._/-]*$/i.test(model) ? model : null);
  const mpn = candidate && ![serial_number, vin].filter(Boolean).some(value => value.toLowerCase() === candidate.toLowerCase()) ? candidate : null;
  return { brand: read(['Brand', 'Manufacturer']), model, model_number, mpn, serial_number, vin };
}