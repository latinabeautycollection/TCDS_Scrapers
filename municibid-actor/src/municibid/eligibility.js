import { cleanText } from './text.js';
export function detectEligibility(text){
  const t=cleanText(text); const l=t.toLowerCase();
  if (/account is (?:needed|required) to place a bid|create a free account|sign in/.test(l)) return {bidding_allowed:null,bidding_eligibility:'ACCOUNT_REQUIRED_TO_BID',bidding_restriction_message:null,requires_account_review:false};
  if (/not eligible|restricted from bidding|account locked/.test(l)) return {bidding_allowed:false,bidding_eligibility:'RESTRICTED',bidding_restriction_message:t.match(/[^.]{0,100}(?:restricted|locked|not eligible)[^.]{0,160}/i)?.[0]||null,requires_account_review:true};
  return {bidding_allowed:null,bidding_eligibility:'UNKNOWN',bidding_restriction_message:null,requires_account_review:false};
}