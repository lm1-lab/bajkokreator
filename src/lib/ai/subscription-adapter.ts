import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';
import {
  GEMINI_HTTP_TIMEOUT_MS,
  GeminiApiStoryProvider,
  resolveGeminiModels,
  type GeminiClientLike,
} from '@/lib/ai/adapters/gemini-api-adapter';
import { AIProviderError } from '@/lib/ai/cost-guard';
import type {
  BlueprintGenerationOptions,
  GeneratedIllustration,
  IllustrationRequest,
  ProviderStatus,
  ReferencePhotoBinary,
  StoryProvider,
} from '@/lib/ai/provider';
import {
  AuthStrategySchema,
  type AuthStrategy,
  type StoryBlueprint,
  type StoryInput,
} from '@/lib/types/story';

export type { AuthStrategy };

// =============================================================================
// Google AI Pro / Ultra Subscription Adapter (~2 grudnia 2026 Readiness)
// =============================================================================

export type SubscriptionTier = 'ai-pro' | 'ai-ultra';

export const SUBSCRIPTION_PLANNED_DATE_PL = '~2 grudnia 2026';

export const SUBSCRIPTION_OAUTH_SENTINEL_API_KEY = 'subscription-oauth-bearer';

export interface SubscriptionConfig {
  authStrategy: AuthStrategy;
  endpoint: string | null;
  token: string | null;
  clientId: string | null;
  tier: SubscriptionTier;
  apiKey: string | null;
  configured: boolean;
  readyReason: string;
  plannedLaunchDate: string;
  requiredEnvVars: ReadonlyArray<string>;
}

function readTrimmedEnv(env: Record<string, string | undefined>, key: string): string | null {
  const val = env[key]?.trim();
  return val && val.length > 0 ? val : null;
}

export function resolveSubscriptionConfig(
  env: Record<string, string | undefined> = process.env,
): SubscriptionConfig {
  const rawStrategy = readTrimmedEnv(env, 'GOOGLE_AI_AUTH_STRATEGY');
  const parsedStrategy = rawStrategy
    ? AuthStrategySchema.safeParse(rawStrategy)
    : null;
  const authStrategy: AuthStrategy = parsedStrategy?.success
    ? parsedStrategy.data
    : 'subscription_oauth_stub';

  const endpoint = readTrimmedEnv(env, 'GOOGLE_SUBSCRIPTION_ENDPOINT');
  const token = readTrimmedEnv(env, 'GOOGLE_SUBSCRIPTION_TOKEN');
  const clientId = readTrimmedEnv(env, 'GOOGLE_SUBSCRIPTION_CLIENT_ID');
  const rawTier = readTrimmedEnv(env, 'GOOGLE_SUBSCRIPTION_TIER');
  const tier: SubscriptionTier = rawTier === 'ai-ultra' ? 'ai-ultra' : 'ai-pro';
  const apiKey = readTrimmedEnv(env, 'GEMINI_API_KEY');

  if (authStrategy === 'api_key') {
    const configured = Boolean(apiKey);
    return {
      authStrategy,
      endpoint,
      token,
      clientId,
      tier,
      apiKey,
      configured,
      plannedLaunchDate: SUBSCRIPTION_PLANNED_DATE_PL,
      requiredEnvVars: ['GOOGLE_AI_AUTH_STRATEGY=api_key', 'GEMINI_API_KEY'],
      readyReason: configured
        ? 'Adapter subskrypcyjny działa w strategii api_key (gotowy do płynnego przełączenia na OAuth po otwarciu subskrypcji Google AI Pro/Ultra ~2 grudnia 2026).'
        : 'Wybrano strategię api_key dla adaptera google-subscription, ale brakuje zmiennej GEMINI_API_KEY.',
    };
  }

  const configured = Boolean(endpoint && token);
  const missing: string[] = [];
  if (!endpoint) missing.push('GOOGLE_SUBSCRIPTION_ENDPOINT');
  if (!token) missing.push('GOOGLE_SUBSCRIPTION_TOKEN');

  return {
    authStrategy,
    endpoint,
    token,
    clientId,
    tier,
    apiKey,
    configured,
    plannedLaunchDate: SUBSCRIPTION_PLANNED_DATE_PL,
    requiredEnvVars: [
      'GOOGLE_AI_AUTH_STRATEGY=subscription_oauth_stub',
      'GOOGLE_SUBSCRIPTION_ENDPOINT',
      'GOOGLE_SUBSCRIPTION_TOKEN',
      'GOOGLE_SUBSCRIPTION_CLIENT_ID (opcjonalnie)',
      'GOOGLE_SUBSCRIPTION_TIER (ai-pro | ai-ultra)',
    ],
    readyReason: configured
      ? `Połączono przez adapter subskrypcyjny Google AI (${tier}, OAuth Bearer) z punktem końcowym ${endpoint}.`
      : `Adapter przygotowany pod zapowiedziane otwarcie płatnych subskrypcji Google AI Pro/Ultra dla zewnętrznych agentów (${SUBSCRIPTION_PLANNED_DATE_PL}). Brakujące zmienne środowiskowe: ${missing.join(', ')}. Po ich dodaniu aplikacja przełączy się bez refaktoryzacji.`,
  };
}

/**
 * Constructs safe GoogleGenAIOptions for GoogleSubscriptionProvider without triggering
 * GCP Application Default Credentials (ADC) fallback when GEMINI_API_KEY is unset.
 *
 * Future cutover note (~2 Dec 2026): if the final official subscription gateway ever rejects
 * a sentinel `x-goog-api-key` header, swap `apiKey` for a custom `googleAuthOptions.authClient`
 * returning `new Headers({ Authorization: \`Bearer \${config.token}\` })` from `getRequestHeaders()`.
 */
export function buildSubscriptionClientOptions(
  config: SubscriptionConfig,
): GoogleGenAIOptions {
  if (!config.configured) {
    throw new AIProviderError(config.readyReason, {
      httpStatus: 503,
      retryable: false,
      code: 'SUBSCRIPTION_NOT_CONFIGURED',
      providerId: 'google-subscription',
    });
  }

  if (config.authStrategy === 'api_key') {
    return {
      apiKey: config.apiKey ?? undefined,
      httpOptions: {
        ...(config.endpoint ? { baseUrl: config.endpoint } : {}),
        retryOptions: { attempts: 1 },
        timeout: GEMINI_HTTP_TIMEOUT_MS,
      },
    };
  }

  // Non-empty non-'auth_tokens/' placeholder prevents @google/genai NodeAuth from
  // attempting GCP ADC lookup and suppresses duplicate "API key should be set" warnings.
  const safeApiKey =
    config.apiKey && !config.apiKey.startsWith('auth_tokens/')
      ? config.apiKey
      : SUBSCRIPTION_OAUTH_SENTINEL_API_KEY;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token ?? ''}`,
    ...(config.clientId ? { 'X-Goog-Api-Client-Id': config.clientId } : {}),
  };

  return {
    apiKey: safeApiKey,
    httpOptions: {
      baseUrl: config.endpoint ?? undefined,
      headers,
      retryOptions: { attempts: 1 },
      timeout: GEMINI_HTTP_TIMEOUT_MS,
    },
  };
}

export interface GoogleSubscriptionProviderOptions {
  env?: Record<string, string | undefined>;
  textModel?: string;
  imageModel?: string;
  createClient?: (
    config: SubscriptionConfig,
    clientOptions: GoogleGenAIOptions,
  ) => GeminiClientLike;
}

export class GoogleSubscriptionProvider implements StoryProvider {
  readonly id = 'google-subscription' as const;
  readonly name = 'Subskrypcja Google AI (Pro / Ultra)';
  readonly consumesQuota = true;

  private readonly env: Record<string, string | undefined>;
  private readonly explicitTextModel?: string;
  private readonly explicitImageModel?: string;
  private readonly createClient?: (
    config: SubscriptionConfig,
    clientOptions: GoogleGenAIOptions,
  ) => GeminiClientLike;

  constructor(options: GoogleSubscriptionProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.explicitTextModel = options.textModel;
    this.explicitImageModel = options.imageModel;
    this.createClient = options.createClient;
  }

  get authStrategy(): AuthStrategy {
    return resolveSubscriptionConfig(this.env).authStrategy;
  }

  get defaultModels(): { textModel: string; imageModel: string } {
    const resolved = resolveGeminiModels(this.env);
    return {
      textModel: this.explicitTextModel ?? resolved.textModel,
      imageModel: this.explicitImageModel ?? resolved.imageModel,
    };
  }

  getSubscriptionConfig(): SubscriptionConfig {
    return resolveSubscriptionConfig(this.env);
  }

  getStatus(): ProviderStatus {
    const config = this.getSubscriptionConfig();
    return {
      id: this.id,
      name: this.name,
      authStrategy: config.authStrategy,
      consumesQuota: this.consumesQuota,
      configured: config.configured,
      available: config.configured,
      description: config.readyReason,
      defaultModels: this.defaultModels,
    };
  }

  private buildDelegate(): GeminiApiStoryProvider {
    const config = this.getSubscriptionConfig();
    const clientOptions = buildSubscriptionClientOptions(config);

    return new GeminiApiStoryProvider({
      providerId: this.id,
      name: this.name,
      authStrategy: config.authStrategy,
      env: this.env,
      textModel: this.explicitTextModel,
      imageModel: this.explicitImageModel,
      createClient: () =>
        this.createClient
          ? this.createClient(config, clientOptions)
          : new GoogleGenAI(clientOptions),
      statusResolver: () => this.getStatus(),
    });
  }

  async generateBlueprint(
    input: StoryInput,
    referencePhotos: ReferencePhotoBinary[],
    options?: BlueprintGenerationOptions,
  ): Promise<StoryBlueprint> {
    return this.buildDelegate().generateBlueprint(input, referencePhotos, options);
  }

  async generateIllustration(
    req: IllustrationRequest,
  ): Promise<GeneratedIllustration | null> {
    return this.buildDelegate().generateIllustration(req);
  }
}
