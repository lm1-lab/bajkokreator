import { ApiError, Modality, type GenerateContentResponse } from '@google/genai';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { DemoStoryProvider } from '@/lib/ai/adapters/demo-adapter';
import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  DEFAULT_GEMINI_TEXT_MODEL,
  GeminiApiStoryProvider,
  buildBlueprintResponseJsonSchema,
  type GeminiClientLike,
} from '@/lib/ai/adapters/gemini-api-adapter';
import { ManualStoryProvider } from '@/lib/ai/adapters/manual-adapter';
import {
  AIProviderError,
  getActiveProviderId,
  getProvider,
  listProviderStatuses,
  type ReferencePhotoBinary,
} from '@/lib/ai/provider';
import {
  GoogleSubscriptionProvider,
  SUBSCRIPTION_OAUTH_SENTINEL_API_KEY,
  buildSubscriptionClientOptions,
  resolveSubscriptionConfig,
} from '@/lib/ai/subscription-adapter';
import { PRINT_SAFETY_CLAUSE } from '@/lib/polish/prompts';
import { buildPolishStoryDraft } from '@/lib/polish/templates';
import {
  DEMO_ASSET_PATH_REGEX,
  ModelIdSchema,
  StoryBlueprintSchema,
  type StoryInput,
} from '@/lib/types/story';

const SAMPLE_INPUT: StoryInput = {
  childName: 'Zosia',
  childAge: 5,
  gender: 'girl',
  companion: 'rudy kotek Mruczek',
  theme: 'wyprawa do zaczarowanego lasu złotych latarni',
  artStyle: 'watercolor',
  mood: 'magical-adventure',
  pageCount: 10,
  dedicationFrom: 'Mama i Tata',
};

const TINY_JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff,
  0xd9,
]);

const TINY_PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const SAMPLE_PHOTOS: ReferencePhotoBinary[] = [
  {
    filename: 'ref-1.jpg',
    mimeType: 'image/jpeg',
    buffer: TINY_JPEG_HEADER,
  },
];

describe('Provider registry and active provider resolution', () => {
  it('resolves all 4 providers, lists statuses, and defaults to demo when unconfigured', () => {
    expect(getActiveProviderId(undefined, {})).toBe('demo');
    expect(getActiveProviderId({ activeProvider: 'manual' }, {})).toBe('manual');
    expect(getActiveProviderId(undefined, { AI_PROVIDER: 'gemini-api' })).toBe(
      'gemini-api',
    );
    expect(getActiveProviderId(undefined, { AI_PROVIDER: 'invalid-provider' })).toBe(
      'demo',
    );

    const statuses = listProviderStatuses();
    expect(statuses.map((s) => s.id)).toEqual([
      'demo',
      'manual',
      'gemini-api',
      'google-subscription',
    ]);

    for (const status of statuses) {
      expect(ModelIdSchema.safeParse(status.defaultModels.textModel).success).toBe(true);
      expect(ModelIdSchema.safeParse(status.defaultModels.imageModel).success).toBe(true);
      expect(getProvider(status.id).id).toBe(status.id);
    }
  });
});

describe('DemoStoryProvider', () => {
  it('generates instant valid Polish story drafts and valid /demo-art/ plates for 4..12 pages', async () => {
    const demo = new DemoStoryProvider();
    expect(demo.getStatus().available).toBe(true);
    expect(demo.consumesQuota).toBe(false);
    expect(ModelIdSchema.safeParse(demo.defaultModels.textModel).success).toBe(true);
    expect(ModelIdSchema.safeParse(demo.defaultModels.imageModel).success).toBe(true);

    const blueprint = await demo.generateBlueprint(SAMPLE_INPUT, SAMPLE_PHOTOS);
    const validated = StoryBlueprintSchema.parse(blueprint);
    expect(validated.pages).toHaveLength(10);

    const cover = await demo.generateIllustration({
      slot: 'cover',
      prompt: validated.coverPrompt,
      characterBible: validated.characterBible,
      artStyle: SAMPLE_INPUT.artStyle,
      bookFormat: 'square',
      referencePhotos: SAMPLE_PHOTOS,
      totalPages: 10,
    });
    expect(cover).toEqual({
      kind: 'demo-asset',
      mimeType: 'image/jpeg',
      demoAssetPath: '/demo-art/cover.jpg',
      modelUsed: demo.defaultModels.imageModel,
    });

    // Verify all 1..12 pages map to existing /demo-art/page-01..10.jpg plates
    for (const totalPages of [4, 10, 11, 12]) {
      for (let page = 1; page <= totalPages; page += 1) {
        const result = await demo.generateIllustration({
          slot: page,
          prompt: validated.pages[0].imagePrompt,
          characterBible: validated.characterBible,
          artStyle: SAMPLE_INPUT.artStyle,
          bookFormat: 'square',
          referencePhotos: SAMPLE_PHOTOS,
          totalPages,
        });
        expect(result?.kind).toBe('demo-asset');
        expect(result?.demoAssetPath).toMatch(DEMO_ASSET_PATH_REGEX);
        expect(result?.demoAssetPath).toMatch(/^\/demo-art\/page-(?:0[1-9]|10)\.jpg$/);
      }
    }
  });
});

describe('ManualStoryProvider', () => {
  it('generates full Polish script with invariant Character Bible prompts and returns null for illustrations', async () => {
    const manual = new ManualStoryProvider();
    expect(manual.getStatus().available).toBe(true);
    expect(manual.consumesQuota).toBe(false);

    const blueprint = await manual.generateBlueprint(SAMPLE_INPUT, SAMPLE_PHOTOS);
    const validated = StoryBlueprintSchema.parse(blueprint);

    expect(validated.characterBible).toContain('Zosia');
    expect(validated.coverPrompt).toContain('[CHARACTER BIBLE]');
    expect(validated.coverPrompt).toContain(PRINT_SAFETY_CLAUSE);
    for (const page of validated.pages) {
      expect(page.imagePrompt).toContain('[CHARACTER BIBLE]');
      expect(page.imagePrompt).toContain(PRINT_SAFETY_CLAUSE);
    }

    const illustration = await manual.generateIllustration({
      slot: 1,
      prompt: validated.pages[0].imagePrompt,
      characterBible: validated.characterBible,
      artStyle: SAMPLE_INPUT.artStyle,
      bookFormat: 'square',
      referencePhotos: SAMPLE_PHOTOS,
    });
    expect(illustration).toBeNull();
  });
});

describe('GoogleSubscriptionProvider (~2 grudnia 2026 readiness)', () => {
  it('reports unconfigured status with ~2 grudnia 2026 guidance and throws non-retryable AIProviderError when called', async () => {
    const provider = new GoogleSubscriptionProvider({ env: {} });
    const status = provider.getStatus();

    expect(status.configured).toBe(false);
    expect(status.available).toBe(false);
    expect(status.authStrategy).toBe('subscription_oauth_stub');
    expect(status.description).toContain('2 grudnia 2026');
    expect(status.description).toContain('GOOGLE_SUBSCRIPTION_ENDPOINT');

    await expect(
      provider.generateBlueprint(SAMPLE_INPUT, SAMPLE_PHOTOS),
    ).rejects.toMatchObject({
      name: 'AIProviderError',
      code: 'SUBSCRIPTION_NOT_CONFIGURED',
      retryable: false,
      providerId: 'google-subscription',
    });
  });

  it('constructs safe Bearer + baseUrl options without ADC fallback or auth_tokens/ trap for subscription_oauth_stub', () => {
    const config = resolveSubscriptionConfig({
      GOOGLE_AI_AUTH_STRATEGY: 'subscription_oauth_stub',
      GOOGLE_SUBSCRIPTION_ENDPOINT: 'https://subscription.example.google/genai',
      GOOGLE_SUBSCRIPTION_TOKEN: 'oauth-token-secret-xyz',
      GOOGLE_SUBSCRIPTION_CLIENT_ID: 'bajkokreator-client',
      GOOGLE_SUBSCRIPTION_TIER: 'ai-ultra',
    });

    expect(config.configured).toBe(true);
    expect(config.tier).toBe('ai-ultra');

    const options = buildSubscriptionClientOptions(config);
    expect(options.apiKey).toBe(SUBSCRIPTION_OAUTH_SENTINEL_API_KEY);
    expect(options.apiKey?.startsWith('auth_tokens/')).toBe(false);
    expect(options.httpOptions?.baseUrl).toBe(
      'https://subscription.example.google/genai',
    );
    expect(options.httpOptions?.headers).toEqual({
      Authorization: 'Bearer oauth-token-secret-xyz',
      'X-Goog-Api-Client-Id': 'bajkokreator-client',
    });
    expect(options.httpOptions?.retryOptions).toEqual({ attempts: 1 });
    expect(options.httpOptions?.timeout).toBe(60_000);
  });

  it('supports api_key strategy and delegates configured calls cleanly through injected client', async () => {
    const sampleDraft = buildPolishStoryDraft(SAMPLE_INPUT);
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify(sampleDraft),
    } as unknown as GenerateContentResponse);

    const provider = new GoogleSubscriptionProvider({
      env: {
        GOOGLE_AI_AUTH_STRATEGY: 'api_key',
        GEMINI_API_KEY: 'test-api-key-123',
      },
      createClient: () => ({
        models: { generateContent },
      }),
    });

    expect(provider.getStatus().configured).toBe(true);
    expect(provider.getStatus().authStrategy).toBe('api_key');

    const blueprint = await provider.generateBlueprint(SAMPLE_INPUT, SAMPLE_PHOTOS);
    expect(blueprint.pages).toHaveLength(10);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('GeminiApiStoryProvider (mocked @google/genai client)', () => {
  it('calls gemini-3.8-flash with structured JSON schema, reference photos, and validates exact page count', async () => {
    const sampleDraft = buildPolishStoryDraft({ ...SAMPLE_INPUT, pageCount: 6 });
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify(sampleDraft),
    } as unknown as GenerateContentResponse);

    const mockClient: GeminiClientLike = {
      models: { generateContent },
    };

    const provider = new GeminiApiStoryProvider({
      env: {},
      createClient: () => mockClient,
    });

    const schema = buildBlueprintResponseJsonSchema(6);
    expect(schema).not.toHaveProperty('$schema');
    expect((schema.properties as Record<string, { minItems: number; maxItems: number }>).pages.minItems).toBe(6);
    expect((schema.properties as Record<string, { minItems: number; maxItems: number }>).pages.maxItems).toBe(6);

    const blueprint = await provider.generateBlueprint(
      { ...SAMPLE_INPUT, pageCount: 6 },
      SAMPLE_PHOTOS,
    );

    expect(blueprint.pages).toHaveLength(6);
    expect(generateContent).toHaveBeenCalledTimes(1);

    const callArg = generateContent.mock.calls[0][0] as {
      model: string;
      contents: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;
      config: {
        responseMimeType: string;
        responseJsonSchema: Record<string, unknown>;
        automaticContinuation: boolean;
      };
    };

    expect(callArg.model).toBe(DEFAULT_GEMINI_TEXT_MODEL);
    expect(callArg.config.responseMimeType).toBe('application/json');
    expect(callArg.config.automaticContinuation).toBe(false);
    expect(callArg.contents.some((part) => part.inlineData?.mimeType === 'image/jpeg')).toBe(
      true,
    );
  });

  it('passes reference photos AND coverStyleAnchor for pages 2-10, forbids outputMimeType/personGeneration, skips thought parts, and supports gemini-3-pro-image', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                thought: true,
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: TINY_JPEG_HEADER.toString('base64'),
                },
              },
              {
                thought: false,
                inlineData: {
                  mimeType: 'image/png',
                  data: TINY_PNG_HEADER.toString('base64'),
                },
              },
            ],
          },
        },
      ],
    } as unknown as GenerateContentResponse);

    const provider = new GeminiApiStoryProvider({
      env: {},
      createClient: () => ({ models: { generateContent } }),
    });

    const coverAnchor: ReferencePhotoBinary = {
      filename: 'cover.jpg',
      mimeType: 'image/jpeg',
      buffer: TINY_JPEG_HEADER,
    };

    const result = await provider.generateIllustration({
      slot: 5,
      prompt: 'Zosia crossing a misty wooden bridge',
      characterBible: 'Zosia, a 5-year-old girl in a terracotta cardigan',
      artStyle: 'watercolor',
      bookFormat: 'a4-landscape',
      referencePhotos: SAMPLE_PHOTOS,
      coverStyleAnchor: coverAnchor,
      imageModel: 'gemini-3-pro-image',
    });

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('binary');
    // Skipped thought JPEG and picked non-thought PNG
    expect(result?.mimeType).toBe('image/png');
    expect(result?.modelUsed).toBe('gemini-3-pro-image');
    expect(result?.buffer?.equals(TINY_PNG_HEADER)).toBe(true);

    const callArg = generateContent.mock.calls[0][0] as {
      model: string;
      contents: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;
      config: {
        responseModalities: string[];
        imageConfig: Record<string, unknown>;
        automaticContinuation: boolean;
      };
    };

    expect(callArg.model).toBe('gemini-3-pro-image');
    expect(callArg.config.responseModalities).toEqual([Modality.TEXT, Modality.IMAGE]);
    expect(callArg.config.imageConfig).toEqual({
      aspectRatio: '4:3',
      imageSize: '1K',
    });
    expect(callArg.config.imageConfig).not.toHaveProperty('outputMimeType');
    expect(callArg.config.imageConfig).not.toHaveProperty('personGeneration');
    expect(callArg.config.automaticContinuation).toBe(false);

    // Must include both reference photo inlineData AND coverStyleAnchor inlineData
    const inlineParts = callArg.contents.filter((p) => Boolean(p.inlineData));
    expect(inlineParts).toHaveLength(2);
    expect(
      callArg.contents.some((p) => p.text?.includes('COVER STYLE ANCHOR')),
    ).toBe(true);
  });

  it('transcodes WebP output from Gemini into JPEG using sharp', async () => {
    const webpBuffer = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 240, g: 225, b: 195 },
      },
    })
      .webp()
      .toBuffer();

    const generateContent = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'image/webp',
                  data: webpBuffer.toString('base64'),
                },
              },
            ],
          },
        },
      ],
    } as unknown as GenerateContentResponse);

    const provider = new GeminiApiStoryProvider({
      env: {},
      createClient: () => ({ models: { generateContent } }),
    });

    const result = await provider.generateIllustration({
      slot: 'cover',
      prompt: 'Cover illustration',
      characterBible: 'Zosia character bible',
      artStyle: 'watercolor',
      bookFormat: 'square',
      referencePhotos: SAMPLE_PHOTOS,
    });

    expect(result?.mimeType).toBe('image/jpeg');
    expect(result?.modelUsed).toBe(DEFAULT_GEMINI_IMAGE_MODEL);
    // JPEG magic bytes FF D8 FF
    expect(result?.buffer?.[0]).toBe(0xff);
    expect(result?.buffer?.[1]).toBe(0xd8);
    expect(result?.buffer?.[2]).toBe(0xff);
  });

  it('performs ZERO retries on real ApiError HTTP 400, 402, and 403', async () => {
    for (const status of [400, 402, 403] as const) {
      const generateContent = vi.fn().mockRejectedValue(
        new ApiError({
          message: `Gemini API failed with status ${status}`,
          status,
        }),
      );

      const provider = new GeminiApiStoryProvider({
        env: {},
        createClient: () => ({ models: { generateContent } }),
      });

      let caught: unknown;
      try {
        await provider.generateIllustration({
          slot: 2,
          prompt: 'Page 2 prompt',
          characterBible: 'Bible',
          artStyle: 'watercolor',
          bookFormat: 'square',
          referencePhotos: SAMPLE_PHOTOS,
        });
      } catch (err: unknown) {
        caught = err;
      }

      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(caught).toBeInstanceOf(AIProviderError);
      expect((caught as AIProviderError).httpStatus).toBe(status);
      expect((caught as AIProviderError).retryable).toBe(false);
    }
  });
});
