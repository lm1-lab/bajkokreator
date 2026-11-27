import type { KnowledgeBaseSearchMatch } from './knowledge-base';

// =============================================================================
// Customer Support Guardrails: Deterministic PII Redaction & Mandatory Escalation
// Never relies on LLM judgement for refund, RODO, legal, or defect escalation.
// =============================================================================

export type EscalationReason =
  | 'refund_or_compensation'
  | 'damaged_or_defective_print'
  | 'rodo_data_subject_request'
  | 'legal_or_chargeback_threat'
  | 'low_kb_confidence';

export type SupportPriority = 'normal' | 'high' | 'urgent';

export interface SupportPolicyEvaluation {
  shouldEscalate: boolean;
  reasons: EscalationReason[];
  priority: SupportPriority;
}

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PESEL_REGEX = /(?<!\d)\d{11}(?!\d)/g;
const IBAN_REGEX = /\bPL\s?\d{2}(?:[\s-]?\d{4}){6}\b/gi;
const PHONE_REGEX = /(?:\+48[\s-]?)?(?<!\d)\d{3}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g;
const CARD_REGEX = /(?<!\d)(?:\d{4}[\s-]?){3}\d{4}(?!\d)/g;

/**
 * Redacts sensitive Polish PII (PESEL, phone numbers, email addresses, IBANs,
 * payment cards) before persisting or returning support ticket transcripts.
 */
export function redactSupportPii(raw: string): string {
  return raw
    .replace(IBAN_REGEX, '[REDACTED_IBAN]')
    .replace(CARD_REGEX, '[REDACTED_CARD]')
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(PESEL_REGEX, '[REDACTED_PESEL]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]');
}

export function maskEmailForTicket(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return '[REDACTED_EMAIL]';
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

const ESCALATION_RULES: Array<{
  reason: EscalationReason;
  priority: SupportPriority;
  pattern: RegExp;
}> = [
  {
    reason: 'legal_or_chargeback_threat',
    priority: 'urgent',
    pattern:
      /\b(?:chargeback|uokik|prawnik|adwokat|radca\s+prawny|pozew|s[aą]d(?:u|em|zie)?|rzecznik\s+konsument|sp[oó]r\s+bankow|policj|prokuratur)\w*/i,
  },
  {
    reason: 'rodo_data_subject_request',
    priority: 'urgent',
    pattern:
      /\b(?:rodo|gdpr|prawo\s+do\s+bycia\s+zapomnian|usuni[eę]ci\w*\s+(?:wszystkich\s+)?(?:moich\s+)?danych|usu[nń]\w*\s+(?:moje\s+)?dane\s+osobow|dane\s+osobow\w*\s+.*usu[nń]|zdj[eę]c\w*\s+dzieck\w*\s+.*rodo)\b/i,
  },
  {
    reason: 'refund_or_compensation',
    priority: 'high',
    pattern:
      /\b(?:zwrot\w*\s*(?:[sś]rodk|pieni[eę]dz|got[oó]wk|kwot|za\s+zam[oó]w|\d+\s*z[lł])|refund|oddaj\w*\s+pieni|rekompensat|odszkodowan|anuluj\w*\s+i\s+zwr[oó][cć])\w*/i,
  },
  {
    reason: 'damaged_or_defective_print',
    priority: 'high',
    pattern:
      /\b(?:uszkodzon|reklamacj|rozklejon|rozmazan|podart|zniszczon|wadliw|b[lł][aąeę]d\w*\s+druk|brakuj[aą]c\w*\s+stron|brudn\w*\s+stron|z[lł]a\s+jako[sś][cć]\s+druk)\w*/i,
  },
];

const PRIORITY_RANK: Record<SupportPriority, number> = {
  normal: 0,
  high: 1,
  urgent: 2,
};

export function evaluateSupportPolicy(params: {
  subject: string;
  message: string;
  kbMatches: readonly KnowledgeBaseSearchMatch[];
  minKbConfidenceScore?: number;
}): SupportPolicyEvaluation {
  const combined = `${params.subject}\n${params.message}`;
  const reasons: EscalationReason[] = [];
  let priority: SupportPriority = 'normal';

  for (const rule of ESCALATION_RULES) {
    if (rule.pattern.test(combined)) {
      reasons.push(rule.reason);
      if (PRIORITY_RANK[rule.priority] > PRIORITY_RANK[priority]) {
        priority = rule.priority;
      }
    }
  }

  const minKbScore = params.minKbConfidenceScore ?? 4;
  const bestKbScore = params.kbMatches[0]?.score ?? 0;
  if (reasons.length === 0 && bestKbScore < minKbScore) {
    reasons.push('low_kb_confidence');
  }

  return {
    shouldEscalate: reasons.length > 0,
    reasons,
    priority,
  };
}
