import { cleanText } from './text.js';

const RULES = [
  [/account (?:is )?(?:locked|suspended)/i, 'LOCKED'],
  [/not (?:authorized|eligible) to bid/i, 'NOT_ELIGIBLE'],
  [/must (?:log in|login|sign in) to (?:place a )?bid/i, 'AUTHENTICATION_REQUIRED'],
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
        requires_account_review: ['LOCKED', 'NOT_ELIGIBLE'].includes(code),
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