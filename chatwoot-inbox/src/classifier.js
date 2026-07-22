// Dependency-free rules engine.
//
// classify(text) -> { category, priority, escalate, matched }
//
// Tune the keyword lists below to your business. Order matters only for the
// `matched` trace; category precedence is explicit in classify().

const RULES = {
  // Someone who wants to buy / is interested.
  lead: [
    'pricing', 'price', 'quote', 'buy', 'purchase', 'interested', 'demo',
    'trial', 'sign up', 'subscribe', 'how much', 'cost', 'plan', 'upgrade',
  ],
  // Something is broken / they need help.
  support: [
    'help', 'issue', 'problem', 'error', 'bug', 'not working', 'broken',
    'cannot', "can't", 'how do i', 'how to', 'stuck', 'support', 'fix',
    'login', 'password', 'reset', 'crash',
  ],
  // Unhappy customer.
  complaint: [
    'complaint', 'angry', 'terrible', 'worst', 'awful', 'unacceptable',
    'disappointed', 'frustrated', 'scam', 'rip off', 'ripoff', 'never again',
    'unhappy', 'poor service',
  ],
  // Junk.
  spam: [
    'crypto', 'bitcoin', 'forex', 'seo services', 'click here', 'free money',
    'work from home', 'make money fast', 'viagra', 'casino', 'loan offer',
  ],
};

// Any of these forces an escalation regardless of category.
const ESCALATION_TERMS = [
  'refund', 'chargeback', 'charge back', 'dispute', 'legal', 'lawyer',
  'attorney', 'lawsuit', 'sue', 'gdpr', 'data deletion', 'fraud',
];

// category -> Chatwoot priority. Chatwoot accepts: urgent | high | medium | low | (null to clear).
const PRIORITY_BY_CATEGORY = {
  complaint: 'high',
  lead: 'medium',
  support: 'medium',
  general: 'low',
  spam: 'low',
};

const CATEGORY_PRECEDENCE = ['spam', 'complaint', 'lead', 'support', 'general'];

function findMatches(haystack, terms) {
  return terms.filter((t) => haystack.includes(t));
}

export function classify(text) {
  const haystack = String(text || '').toLowerCase();

  const matched = {};
  for (const [category, terms] of Object.entries(RULES)) {
    const hits = findMatches(haystack, terms);
    if (hits.length) matched[category] = hits;
  }

  const escalationHits = findMatches(haystack, ESCALATION_TERMS);
  const escalate = escalationHits.length > 0;

  // Pick the highest-precedence category that matched; default to general.
  let category = 'general';
  for (const c of CATEGORY_PRECEDENCE) {
    if (matched[c]) {
      category = c;
      break;
    }
  }

  // An escalation is never "general" — treat it as at least a complaint-level ticket.
  let priority = PRIORITY_BY_CATEGORY[category] ?? 'low';
  if (escalate) {
    priority = 'urgent';
    if (category === 'general' || category === 'spam') category = 'complaint';
  }

  return {
    category,
    priority,
    escalate,
    matched: { ...matched, ...(escalate ? { escalation: escalationHits } : {}) },
  };
}

export default { classify };
