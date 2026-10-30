/**
 * MemGuard L0: deterministic, local secret/PII/injection detectors.
 * Runs before any text leaves the process (including to third-party classifiers like Jev).
 *
 * severity "block"  -> must never be stored or echoed (credentials, payment secrets)
 * severity "redact" -> may be stored only with the value masked (government IDs)
 */

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DETECTORS = [
  {
    type: "payment_card",
    severity: "block",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  { type: "card_cvv", severity: "block", re: /\b(?:cvv2?|cvc|card security code)\b\D{0,15}\d{3,4}\b/gi },
  { type: "pin", severity: "block", re: /\b(?:atm\s+|debit\s+|card\s+|bank\s+|upi\s+)?pin(?:\s*(?:code|number))?\b[^\d.!?\n]{0,40}\d{4,6}\b/gi },
  { type: "otp", severity: "block", re: /\b(?:otp|one[- ]time\s+(?:pass(?:word|code)?|code)|verification\s+code|2fa\s+code|auth(?:entication)?\s+code)\b[^\d.!?\n]{0,40}\d{4,8}\b/gi },
  {
    type: "password",
    severity: "block",
    re: /\b(?:password|passcode|passwd|pwd|passphrase)\b\s*(?:is|was|:|=|-)?\s*["'`]?[^\s"'`,.]{4,}/gi,
    accept: (m) => !/\b(?:password|passcode|passwd|pwd|passphrase)\b\s*(?:is|was)?\s*(?:manager|reset|change|policy|strong|weak|forgot|forget|same|different|secure)\b/i.test(m),
  },
  { type: "bank_account", severity: "block", re: /\b(?:account|acct|a\/c)\s*(?:no\.?|number|#)?\s*(?:is|:)?\s*\d{8,18}\b/gi },
  { type: "iban", severity: "block", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g },
  { type: "seed_phrase", severity: "block", re: /\b(?:seed|recovery|mnemonic)\s+(?:phrase|words?)\b[^\n]{0,20}?(?:\b[a-z]{3,8}\b[\s,]+){11,23}\b[a-z]{3,8}\b/gi },
  { type: "private_key", severity: "block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { type: "api_key", severity: "block", re: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g },
  { type: "us_ssn", severity: "redact", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "aadhaar", severity: "redact", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, accept: (m, ctx) => /[ -]/.test(m) || /aadh?aar|uidai/i.test(ctx) },
  { type: "india_pan", severity: "redact", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: "passport", severity: "redact", re: /\bpassport\s*(?:no\.?|number|#)?\s*(?:is|:)?\s*[A-Z0-9]{6,9}\b/gi },
];

/**
 * @param {string} text
 * @returns {{findings: {type:string, severity:string, match:string, index:number}[], hasBlock: boolean, hasRedact: boolean}}
 */
export function scanText(text) {
  const s = String(text || "");
  const findings = [];
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of s.matchAll(d.re)) {
      const ctx = s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      if (d.accept && !d.accept(m[0], ctx)) continue;
      findings.push({ type: d.type, severity: d.severity, match: m[0], index: m.index });
    }
  }
  return {
    findings,
    hasBlock: findings.some((f) => f.severity === "block"),
    hasRedact: findings.some((f) => f.severity === "redact"),
  };
}

/** Replace every finding with a typed placeholder, e.g. "my pin is [REDACTED:pin]". */
export function redact(text, findings = scanText(text).findings) {
  let s = String(text || "");
  const sorted = [...findings].sort((a, b) => b.index - a.index);
  for (const f of sorted) {
    s = s.slice(0, f.index) + `[REDACTED:${f.type}]` + s.slice(f.index + f.match.length);
  }
  return s;
}

/** Digits/tokens of every secret, so later stages can check nothing leaked downstream. */
export function secretFingerprints(findings) {
  return findings
    .map((f) => {
      const digits = f.match.replace(/\D/g, "");
      if (digits.length >= 4) return digits;
      const tail = f.match.split(/[\s:=]+/).pop();
      return tail && tail.length >= 4 ? tail.toLowerCase() : null;
    })
    .filter(Boolean);
}

const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,20}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(?:instructions?|rules|guidelines|prompts?)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\bfrom now on\b[^.\n]{0,40}\b(?:you|the assistant|ai)\b[^.\n]{0,20}\b(?:must|should|will|always|never)\b/i,
  /\b(?:you|the assistant|ai)\s+(?:must|should)\s+(?:always|never)\b/i,
  /\bwhen(?:ever)?\s+(?:asked|the user asks|anyone asks)\b[^.\n]{0,80}\b(?:say|answer|respond|reply|recommend|tell)\b/i,
  /\b(?:send|transfer|wire|pay)\b[^.\n]{0,30}\b(?:money|funds|payment|crypto|bitcoin|usdt)\b[^.\n]{0,40}\bto\b/i,
  /\b(?:always|only)\s+(?:recommend|suggest|use)\s+(?:the\s+)?(?:site|website|link|url|wallet|app)\b/i,
  /\bhttps?:\/\/\S+/i,
  /\b(?:remember|memorize|store|save)\s+(?:this|that)\s*(?:fact|permanently|forever)?\s*:/i,
];

/** Heuristic prompt-injection signal for text that is about to become a memory. */
export function injectionSignals(text) {
  const s = String(text || "");
  const hits = INJECTION_PATTERNS.filter((re) => re.test(s)).map((re) => re.source.slice(0, 40));
  return { hit: hits.length > 0, hits };
}
