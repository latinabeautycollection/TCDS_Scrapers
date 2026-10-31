import { cleanText } from './text.js';
export function extractLogisticsSignals(text){
  const t=cleanText(text); const lower=t.toLowerCase();
  let shippingAvailable=null,pickupRequired=null;
  if (/will you ship this item\s*:?\s*no\b|\bno shipping\b|\bshipping (?:is )?not available\b|\bpickup only\b/.test(lower)) { shippingAvailable=false; pickupRequired=true; }
  else if (/will you ship this item\s*:?\s*yes\b|\bshipping available\b|\bwill ship\b/.test(lower)) shippingAvailable=true;
  const pickup=(t.match(/Pickup Location Details\s+(.+?)(?=Questions & Answers|Seller.?s Terms|$)/i)?.[1]||'').trim()||null;
  const inspection=(t.match(/In person item inspection information\s+(.+?)(?=Pickup Location Details|Questions & Answers|$)/i)?.[1]||'').trim()||null;
  const payment=(t.match(/Payment Details\s+(.+?)(?=Item Description|Seller.?s Terms|Additional Information|$)/i)?.[1]||'').trim()||null;
  return {shipping_available:shippingAvailable,pickup_required:pickupRequired,pickup_location:pickup,inspection_available:inspection?true:null,inspection_details:inspection,payment_terms:payment,removal_requirements:/remove|removal|pickup/i.test(t)?(t.match(/(?:Pickup Info|Removal)[\s:]+(.+?)(?=Condition:|Additional Information|Questions & Answers|$)/i)?.[1]||null):null};
}