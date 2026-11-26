import { DemoStoryProvider } from '@/lib/ai/adapters/demo-adapter';
import { GeminiApiStoryProvider } from '@/lib/ai/adapters/gemini-api-adapter';
import { ManualStoryProvider } from '@/lib/ai/adapters/manual-adapter';
import { AIProviderError } from '@/lib/ai/cost-guard';
import { GoogleSubscriptionProvider } from '@/lib/ai/subscription-adapter';
import {
  PROVIDER_IDS,
  ProviderIdSchema,
  type AllowedImageMime,
  type ArtStyle,
  type AuthStrategy,
  type BookFormat,
  type ProviderId,
  type RuntimeSettings,
  type StoryBlueprint,
  type StoryInput,
} from '@/lib/types/story';

export type { StoryBlueprint };
export { AIProviderError };

// =============================================================================
// StoryProvider Abstraction & Registry
// =============================================================================

export interface ReferencePhotoBinary {
  filename: string;
  mimeType: AllowedImageMime;
  buffer: Buffer;
}

export interface BlueprintGenerationOptions {
  textModel?: string;
}

export interface IllustrationRequest {
  slot: 'cover' | number;
  prompt: string;
  characterBible: string;
  artStyle: ArtStyle;
  bookFormat: BookFormat;
  referencePhotos: ReferencePhotoBinary[];
  coverStyleAnchor?: ReferencePhotoBinary | null;
  totalPages?: number;
  imageModel?: string;
}

export interface GeneratedIllustration {
  kind: 'binary' | 'demo-asset';
  mimeType: 'image/jpeg' | 'image/png';
  buffer?: Buffer;
  demoAssetPath?: string;
  modelUsed: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  authStrategy: AuthStrategy | 'none';
  consumesQuota: boolean;
  configured: boolean;
  available: boolean;
  description: string;
  defaultModels: {
    textModel: string;
    imageModel: string;
  };
}

export interface StoryProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly authStrategy: AuthStrategy | 'none';
  readonly consumesQuota: boolean;
  readonly defaultModels: {
    textModel: string;
    imageModel: string;
  };
  getStatus(): ProviderStatus;
  generateBlueprint(
    input: StoryInput,
    referencePhotos: ReferencePhotoBinary[],
    options?: BlueprintGenerationOptions,
  ): Promise<StoryBlueprint>;
  generateIllustration(
    req: IllustrationRequest,
  ): Promise<GeneratedIllustration | null>;
}

const PROVIDER_REGISTRY: Readonly<Record<ProviderId, StoryProvider>> = {
  demo: new DemoStoryProvider(),
  manual: new ManualStoryProvider(),
  'gemini-api': new GeminiApiStoryProvider(),
  'google-subscription': new GoogleSubscriptionProvider(),
};

export function getProvider(id: ProviderId): StoryProvider {
  const parsed = ProviderIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new AIProviderError(`Nieznany dostawca AI: ${String(id)}`, {
      httpStatus: 400,
      retryable: false,
      code: 'UNKNOWN_PROVIDER',
    });
  }
  return PROVIDER_REGISTRY[parsed.data];
}

export function listProviderStatuses(): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id].getStatus());
}

/**
 * Resolves the active provider ID from runtime settings or AI_PROVIDER env var,
 * defaulting safely to 'demo' whenever unconfigured or invalid.
 */
export function getActiveProviderId(
  settings?: Partial<RuntimeSettings>,
  env: Record<string, string | undefined> = process.env,
): ProviderId {
  if (settings?.activeProvider) {
    const parsed = ProviderIdSchema.safeParse(settings.activeProvider);
    if (parsed.success) {
      return parsed.data;
    }
  }

  const rawEnv = env.AI_PROVIDER?.trim();
  if (rawEnv) {
    const parsed = ProviderIdSchema.safeParse(rawEnv);
    if (parsed.success) {
      return parsed.data;
    }
  }

  return 'demo';
}
