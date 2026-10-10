// Single source of truth for how Albena's approval gate is described on the public site.
// Every page that makes a claim about approvals must use these strings so the wording agrees.
// Tiers: R0 read, R1 low-risk (owner rules), R2 messages/purchases/locks etc. (ask), R3 highest risk (ask + PIN).
export const APPROVAL_POLICY =
  'Albena asks before anything that matters: reads run freely, low-risk actions like lights follow your rules, and messages, purchases, locks or anything risky need your approval, with a PIN for the highest-risk ones.';
export const APPROVAL_HEADING = 'Albena asks before anything that matters';
export const APPROVAL_SHORT = 'asks before anything that matters';
