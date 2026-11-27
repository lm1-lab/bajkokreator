// =============================================================================
// Structured PII-Safe Operational Logger (100% browser-safe, zero node:* imports)
// =============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  module: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

export interface OperationalLogger {
  log(entry: Omit<LogEntry, 'timestamp'> & { timestamp?: string }): void;
  debug(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void;
  info(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void;
  warn(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void;
  error(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void;
}

const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(?:email|e[-_]?mail|phone|telefon|pesel|password|passwd|secret|token|authorization|cookie|api[-_]?key|address|street|ulica|line1|line2|postal|recipient|payment[-_]?ref|iban|card|cvv)/i;

const MAX_REDACTION_DEPTH = 6;
const MAX_REDACTED_ARRAY_ITEMS = 50;

/**
 * Redacts PII and secrets from arbitrary strings in deterministic specificity order:
 * auth tokens -> JWTs -> API keys -> generic secret prefixes -> emails -> Polish IBAN ->
 * payment refs -> Polish phones -> 11-digit PESEL (without touching 13-digit timestamps).
 */
export function redactPii(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }

  return input
    // 1. Authorization Bearer / Basic headers
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED_TOKEN]')
    // 2. JWT tokens
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    // 3. Google / Gemini API keys (AIza...)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    // 4. Generic secret prefixes (sk_, pk_, rk_, whsec_)
    .replace(/\b(?:sk|pk|rk|whsec)_(?:live|test)?_[0-9A-Za-z]{12,}\b/gi, '[REDACTED_SECRET]')
    // 5. Email addresses
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    // 6. Polish IBAN
    .replace(/\bPL\s?\d{2}(?:\s?\d{4}){6}\b/gi, '[REDACTED_IBAN]')
    // 7. Payment references
    .replace(/\b(?:pi|ch|cs|py|re|txn|pay|p24)_[A-Za-z0-9]{8,}\b/g, '[REDACTED_PAYMENT_REF]')
    // 8. Polish phone numbers (+48 123 456 789, 123-456-789, +48123456789)
    .replace(
      /(?<!\d)(?:\+?48[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}|\d{3}[\s.-]\d{3}[\s.-]\d{3})(?!\d)/g,
      '[REDACTED_PHONE]',
    )
    // 9. Polish PESEL (exactly 11 consecutive digits, bounded so 13-digit epoch ms are untouched)
    .replace(/(?<!\d)\d{11}(?!\d)/g, '[REDACTED_PESEL]');
}

/**
 * Recursively redacts strings, sensitive object keys, Error instances, arrays,
 * and guards against deep nesting and circular references.
 */
export function redactPiiValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactPii(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[INVALID_DATE]' : value.toISOString();
  }

  if (value instanceof Error) {
    const record: Record<string, unknown> = {
      name: value.name,
      message: redactPii(value.message),
    };
    const maybeCode = (value as { code?: unknown }).code;
    if (typeof maybeCode === 'string') {
      record.code = maybeCode;
    }
    const maybeHttpStatus = (value as { httpStatus?: unknown }).httpStatus;
    if (typeof maybeHttpStatus === 'number') {
      record.httpStatus = maybeHttpStatus;
    }
    return record;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (depth > MAX_REDACTION_DEPTH) {
    return '[TRUNCATED]';
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_REDACTED_ARRAY_ITEMS).map((item) =>
      redactPiiValue(item, depth + 1, seen),
    );
    if (value.length > MAX_REDACTED_ARRAY_ITEMS) {
      capped.push(`[...${value.length - MAX_REDACTED_ARRAY_ITEMS} more]`);
    }
    return capped;
  }

  const out: Record<string, unknown> = {};
  for (const [key, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      if (rawVal === null || rawVal === undefined || typeof rawVal === 'boolean') {
        out[key] = rawVal;
      } else {
        out[key] = '[REDACTED]';
      }
    } else {
      out[key] = redactPiiValue(rawVal, depth + 1, seen);
    }
  }
  return out;
}

function resolveEnvLogLevel(defaultLevel: LogLevel): LogLevel {
  const raw =
    typeof process !== 'undefined' && process.env
      ? process.env.LOG_LEVEL?.trim().toLowerCase()
      : undefined;
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return defaultLevel;
}

export class JsonConsoleLogger implements OperationalLogger {
  private readonly explicitMinLevel?: LogLevel;

  constructor(options?: { minLevel?: LogLevel }) {
    this.explicitMinLevel = options?.minLevel;
  }

  private getMinLevel(): LogLevel {
    return this.explicitMinLevel ?? resolveEnvLogLevel('info');
  }

  log(entry: Omit<LogEntry, 'timestamp'> & { timestamp?: string }): void {
    const minLevel = this.getMinLevel();
    if (LOG_LEVEL_WEIGHT[entry.level] < LOG_LEVEL_WEIGHT[minLevel]) {
      return;
    }

    const payload: LogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level,
      event: redactPii(entry.event),
      module: redactPii(entry.module),
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(entry.data !== undefined
        ? { data: redactPiiValue(entry.data) as Record<string, unknown> }
        : {}),
    };

    const line = JSON.stringify(payload);
    switch (entry.level) {
      case 'debug':
        console.debug(line);
        break;
      case 'info':
        console.info(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      case 'error':
        console.error(line);
        break;
    }
  }

  debug(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
    this.log({ level: 'debug', module, event, data, requestId });
  }

  info(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
    this.log({ level: 'info', module, event, data, requestId });
  }

  warn(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
    this.log({ level: 'warn', module, event, data, requestId });
  }

  error(module: string, event: string, data?: Record<string, unknown>, requestId?: string): void {
    this.log({ level: 'error', module, event, data, requestId });
  }
}

const defaultLogger: OperationalLogger = new JsonConsoleLogger();
let activeLogger: OperationalLogger = defaultLogger;

export function getOperationalLogger(): OperationalLogger {
  return activeLogger;
}

export function setOperationalLogger(logger: OperationalLogger): void {
  activeLogger = logger;
}

export function resetOperationalLogger(): void {
  activeLogger = defaultLogger;
}
