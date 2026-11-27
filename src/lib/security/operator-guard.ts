import crypto from 'node:crypto';

// =============================================================================
// Vendor-Agnostic Operator Authentication Guard Port & Env Bearer Implementation
// Swap in Clerk / Auth.js / Supabase Auth via `setOperatorAuthGuard()` without
// modifying any route handlers.
// =============================================================================

export const OPERATOR_ROLES = ['admin', 'agent', 'ops-readonly'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export interface OperatorIdentity {
  id: string;
  role: OperatorRole;
  authMethod: 'token' | 'dev-bypass' | 'external-idp';
}

export interface OperatorAuthGuard {
  authenticate(
    request: Request,
    requiredRoles?: readonly OperatorRole[],
  ): Promise<OperatorIdentity>;
}

export class UnauthorizedError extends Error {
  readonly httpStatus: 401 | 403;
  readonly code: string;

  constructor(
    message = 'Brak autoryzacji operatora.',
    code = 'UNAUTHORIZED',
    httpStatus: 401 | 403 = 401,
  ) {
    super(message);
    this.name = 'UnauthorizedError';
    this.code = code;
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * Constant-time token comparison via SHA-256 digests so different-length tokens
 * never throw RangeError and never leak expected token length via timing.
 */
export function constantTimeTokenEqual(provided: string, expected: string): boolean {
  if (expected.length === 0 || provided.length === 0) {
    return false;
  }
  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function resolveConfiguredRole(env: Record<string, string | undefined>): OperatorRole {
  const raw = env.BAJKOKREATOR_OPS_TOKEN_ROLE?.trim();
  if (raw && (OPERATOR_ROLES as readonly string[]).includes(raw)) {
    return raw as OperatorRole;
  }
  return 'admin';
}

function assertRoleAllowed(
  identity: OperatorIdentity,
  requiredRoles?: readonly OperatorRole[],
): void {
  if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(identity.role)) {
    throw new UnauthorizedError(
      'Brak wystarczających uprawnień operatora.',
      'INSUFFICIENT_OPERATOR_ROLE',
      403,
    );
  }
}

export class EnvBearerTokenGuard implements OperatorAuthGuard {
  private readonly env?: Record<string, string | undefined>;

  constructor(env?: Record<string, string | undefined>) {
    this.env = env;
  }

  async authenticate(
    request: Request,
    requiredRoles?: readonly OperatorRole[],
  ): Promise<OperatorIdentity> {
    const sourceEnv = this.env ?? process.env;
    const configuredToken = sourceEnv.BAJKOKREATOR_OPS_TOKEN?.trim() ?? '';
    const requireAuth =
      sourceEnv.BAJKOKREATOR_REQUIRE_OPS_AUTH?.trim().toLowerCase() === 'true';
    const allowUnauthenticated =
      sourceEnv.BAJKOKREATOR_ALLOW_UNAUTHENTICATED_OPS?.trim().toLowerCase() === 'true';

    if (configuredToken.length > 0) {
      const authHeader = request.headers.get('authorization')?.trim() ?? '';
      const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
      if (!match) {
        throw new UnauthorizedError(
          'Wymagany nagłówek Authorization: Bearer <token>.',
          'MISSING_OPERATOR_TOKEN',
          401,
        );
      }

      if (!constantTimeTokenEqual(match[1], configuredToken)) {
        throw new UnauthorizedError(
          'Nieprawidłowy token operatora.',
          'INVALID_OPERATOR_TOKEN',
          401,
        );
      }

      const identity: OperatorIdentity = {
        id: 'env-token-operator',
        role: resolveConfiguredRole(sourceEnv),
        authMethod: 'token',
      };
      assertRoleAllowed(identity, requiredRoles);
      return identity;
    }

    if (requireAuth && !allowUnauthenticated) {
      throw new UnauthorizedError(
        'Wymagana autoryzacja operatora (BAJKOKREATOR_REQUIRE_OPS_AUTH=true), ale nie skonfigurowano BAJKOKREATOR_OPS_TOKEN.',
        'OPERATOR_AUTH_NOT_CONFIGURED',
        401,
      );
    }

    const identity: OperatorIdentity = {
      id: 'dev-bypass',
      role: 'admin',
      authMethod: 'dev-bypass',
    };
    assertRoleAllowed(identity, requiredRoles);
    return identity;
  }
}

const defaultGuard: OperatorAuthGuard = new EnvBearerTokenGuard();
let activeGuard: OperatorAuthGuard = defaultGuard;

export function getOperatorAuthGuard(): OperatorAuthGuard {
  return activeGuard;
}

export function setOperatorAuthGuard(guard: OperatorAuthGuard): void {
  activeGuard = guard;
}

export function resetOperatorAuthGuard(): void {
  activeGuard = defaultGuard;
}

export async function requireOperatorAuth(
  request: Request,
  requiredRoles?: readonly OperatorRole[],
): Promise<OperatorIdentity> {
  return getOperatorAuthGuard().authenticate(request, requiredRoles);
}
