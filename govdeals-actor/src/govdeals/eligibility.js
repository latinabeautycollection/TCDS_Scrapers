import { cleanText } from './text.js';

const RULES = [
  [/your account is locked from bidding on this asset/i, 'LOCKED'],
  [/complete your account setup/i, 'ACCOUNT_SETUP_REQUIRED'],
  [/not authorized to bid|not eligible to bid/i, 'NOT_ELIGIBLE'],
  [/sign in.*bid|sign in to bid/i, 'AUTHENTICATION_REQUIRED'],
  [/captcha|verify you are human/i, 'CAPTCHA_REQUIRED'],
];

export function detectEligibility(text) {
  const raw = cleanText(text);
  for (const [re, code] of RULES) {
    if (re.test(raw)) {
      return {
        bidding_allowed: false,
        bidding_eligibility: code,
        bidding_restriction_message: raw.match(re)?.[0] || code,
        requires_account_review: ['LOCKED', 'ACCOUNT_SETUP_REQUIRED', 'NOT_ELIGIBLE'].includes(code),
        account_restriction_detected: true,
        seller_restriction_detected: false,
      };
    }
  }
  return {
    bidding_allowed: null,
    bidding_eligibility: 'UNKNOWN',
    bidding_restriction_message: null,
    requires_account_review: false,
    account_restriction_detected: false,
    seller_restriction_detected: false,
  };
}