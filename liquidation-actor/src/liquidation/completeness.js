function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function completenessFields(record) {
  return {
    external_id: record.external_id,
    title: record.title,
    listing_url: record.listing_url,
    current_price: record.current_price,
    price_type: record.price_type ?? record.attributes?.price_type,
    estimated_shipping: record.estimated_shipping,
    shipping_method: record.shipping_method,
    auction_start_time_source: record.auction_start_time_source ?? record.attributes?.auction_start_time_source,
    auction_end_time: record.auction_end_time,
    location: record.location,
    seller_name: record.seller_name,
    condition: record.condition && record.condition !== 'UNKNOWN' ? record.condition : null,
  };
}

export function updateCompleteness(stats, record, prefix) {
  const totalKey = `${prefix}_completeness_total`;
  const dataKey = `${prefix}_completeness`;
  const applicableKey = `${prefix}_completeness_applicable`;
  stats[totalKey] = Number(stats[totalKey] || 0) + 1;
  stats[dataKey] ||= {};
  stats[applicableKey] ||= {};
  const fields = completenessFields(record);
  const hasPublishedShippingCost = record.shipping_method === 'shipping'
    && (record.source_meta?.minimum_shipping_fee != null
      || (record.source_record?.shipping_options || []).some((option) => Number.isFinite(Number(option?.amount))));
  for (const [field, value] of Object.entries(fields)) {
    const applicable = !((field === 'auction_end_time' && record.listing_type === 'FIXED_PRICE')
      || (field === 'current_price' && record.listing_type === 'SEALED_BID' && record.current_price == null)
      || (field === 'price_type' && record.current_price == null)
      || (field === 'estimated_shipping' && !hasPublishedShippingCost));
    stats[dataKey][field] = Number(stats[dataKey][field] || 0);
    stats[applicableKey][field] = Number(stats[applicableKey][field] || 0);
    if (!applicable) continue;
    stats[applicableKey][field] += 1;
    if (hasValue(value)) stats[dataKey][field] += 1;
  }
}