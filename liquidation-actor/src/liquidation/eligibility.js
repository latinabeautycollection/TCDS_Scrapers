import { cleanText } from './text.js';
export function detectEligibility(text){
  const t=cleanText(text); const l=t.toLowerCase();
  if(/account (?:is )?(?:suspended|locked)|restricted from bidding|not eligible to bid/.test(l)) return {bidding_allowed:false,bidding_eligibility:'RESTRICTED',bidding_restriction_message:t.match(/[^.]{0,120}(?:suspended|locked|restricted|not eligible)[^.]{0,180}/i)?.[0]||null,requires_account_review:true};
  if(/please sign in to continue|sign in to bid|must be registered/.test(l)) return {bidding_allowed:null,bidding_eligibility:'ACCOUNT_REQUIRED_TO_BID',bidding_restriction_message:null,requires_account_review:false};
  return {bidding_allowed:null,bidding_eligibility:'UNKNOWN',bidding_restriction_message:null,requires_account_review:false};
}