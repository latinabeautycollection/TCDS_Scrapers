import { cleanText, money } from './text.js';
export function extractLogisticsSignals(text){
  const t=cleanText(text); const lower=t.toLowerCase();
  let shippingAvailable=null,pickupRequired=null;
  const negative=t.match(/(?:for )?pick[ -]?up only|shipping (?:is )?not available|\bno shipping\b(?!\s+damage)/i);
  const free=t.match(/\bfree shipping\b/i);
  const offer=t.match(/liquidation\.com arranges shipping|seller arranges shipping|buyer may arrange shipping|buyer must arrange shipping|shipping (?:is )?available|will ship|can ship|shipping estimate\s*\(?get a quote/i);
  if(negative){shippingAvailable=false;pickupRequired=true;}
  else if(free||offer){shippingAvailable=true;pickupRequired=/buyer (?:may|must) arrange shipping/.test(lower)?null:false;}
  const shippingTerms=(t.match(/Shipping Terms\s+(.+?)(?=Shipping Estimate|Total Weight|Quantity In Lot|Buyer'?s Premium|Auction Type|$)/i)?.[1]||'').trim()||null;
  const shippingOptions=[];
  const costPattern=/(Minimum Shipping Fee|Shipping Estimate|Estimated Shipping|Shipping Cost|Freight Cost|Pickup Fee)\s*(?:\([^)]*\))?\s*:?\s*((?:(?:US\s*)?\$|C\$|CAD\s*\$?|USD\s*\$?)\s*[\d,.]+(?:\s*\([A-Z]{3}\))?)/gi;
  let costMatch;
  while((costMatch=costPattern.exec(t))){
    const amount=money(costMatch[2]);
    if(amount!=null)shippingOptions.push({label:cleanText(costMatch[1]),value:cleanText(costMatch[2]),amount});
  }
  const minFee=shippingOptions.find((o)=>o.label==='Minimum Shipping Fee')?.amount??null;
  const estimatedShipping=shippingOptions.length?Math.min(...shippingOptions.map((o)=>o.amount)):null;
  const shippingMethod=pickupRequired&&shippingAvailable===false?'pickup_only':free?'free_shipping':estimatedShipping!=null?(estimatedShipping===0?'free_shipping':'shipping'):shippingAvailable===true?'shipping_quote':null;
  const shippingEvidence=negative?.[0]||free?.[0]||(shippingOptions[0]?`${shippingOptions[0].label}: ${shippingOptions[0].value}`:null)||offer?.[0]||null;
  const weight=(t.match(/Total Weight\s+(.+?)(?=Quantity In Lot|Shipping Estimate|Minimum Shipping Fee|Buyer'?s Premium|$)/i)?.[1]||'').trim()||null;
  const restrictions=(t.match(/Shipping Restrictions\s+(.+?)(?=Terms & Conditions|PAYMENT|REMOVAL|$)/i)?.[1]||'').trim()||null;
  const payment=(t.match(/PAYMENT\s+(.+?)(?=REMOVAL|Exclusions relating|$)/i)?.[1]||'').trim()||null;
  const removal=(t.match(/REMOVAL\s+(.+?)(?=Exclusions relating|By bidding|$)/i)?.[1]||'').trim()||null;
  return {shipping_available:negative?false:estimatedShipping!=null?true:shippingAvailable,pickup_required:pickupRequired,pickup_location:null,inspection_available:null,inspection_details:null,payment_terms:payment,removal_requirements:removal,shipping_terms:shippingTerms,minimum_shipping_fee:minFee,estimated_shipping:negative?null:free?0:estimatedShipping,shipping_method:shippingMethod,shipping_evidence:shippingEvidence,shipping_options:shippingOptions,shipping_weight:weight,shipping_restrictions:restrictions};
}