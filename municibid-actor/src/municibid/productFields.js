import { publishedValue } from './qaFields.js';

// Only use seller-provided fields or bounded description lines as product IDs.
export function productFields($, description = '', payload = {}, title = '') {
  const read = labels => publishedValue($, labels) || String(description).split(/\n/).map(line => {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = line.trim().match(new RegExp(`^${escaped}\\s*[:#]\\s*(.{1,100})$`, 'i'));
      if (match) return match[1].trim();
    }
    return null;
  }).find(Boolean) || null;
  const serial = read(['Serial Number', 'Serial #', 'Serial']);
  const vin = read(['VIN', 'Vehicle Identification Number']);
  // A seller may publish the model in the title instead of a separate field.
  // Require the literal Model label and a digit in its single code token.
  const titleToken = String(title).match(/\bmodel\b(?:\s+(?:number|no\.?))?\s*[:#]?\s+([A-Z0-9][A-Z0-9._/-]{0,63})\b/i)?.[1] || null;
  const titleModel = titleToken && /\d/.test(titleToken) ? titleToken : null;
  const model = read(['Model', 'Model Number', 'Model #']) || titleModel;
  const explicit = read(['MPN', 'Manufacturer Part Number', 'Part Number', 'Part #', 'Model Number', 'Model #', 'Catalog Number', 'Catalogue Number']);
  const candidate = explicit || (model && /\d/.test(model) ? model : null);
  const mpn = candidate && ![serial, vin].filter(Boolean).some(v => v.toLowerCase() === candidate.toLowerCase()) ? candidate : null;
  const labelled = read(['Condition', 'Item Condition', 'Condition Description']);
  const payloadCondition = [payload?.condition, payload?.itemCondition, payload?.conditionDescription].find(v => typeof v === 'string' && v.trim());
  // Preserve a seller's actual operational-condition sentence when no field exists.
  const sentence = String(description).split(/[\n]|(?<=[.!?])\s+/).map(v => v.trim()).filter(v =>
    v.length <= 300 && /\b(?:in (?:good|fair|poor|excellent|working|operating) condition|runs and drives|does not run|non[- ]?operational|inoperable|not tested|untested|for parts only|no (?:known|know) issues|patrol ready)\b/i.test(v)).join('\n') || null;
  const condition = labelled || payloadCondition?.trim() || sentence || null;
  return { model, mpn, serial_number: serial, vin, condition, condition_source: labelled ? 'published_condition_field' : payloadCondition ? 'embedded_condition_field' : sentence ? 'seller_description' : 'not_published_by_site' };
}