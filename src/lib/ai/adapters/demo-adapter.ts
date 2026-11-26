import {
  buildPolishStoryDraft,
  resolveDemoAssetPath,
} from '@/lib/polish/templates';
import {
  DEMO_ASSET_PATH_REGEX,
  type StoryBlueprint,
  type StoryInput,
} from '@/lib/types/story';
import type {
  GeneratedIllustration,
  IllustrationRequest,
  ProviderStatus,
  ReferencePhotoBinary,
  StoryProvider,
} from '@/lib/ai/provider';

export class DemoStoryProvider implements StoryProvider {
  readonly id = 'demo' as const;
  readonly name = 'Tryb Demo (akwarele)';
  readonly authStrategy = 'none' as const;
  readonly consumesQuota = false;
  readonly defaultModels = {
    textModel: 'demo-polish-craft-v1',
    imageModel: 'demo-watercolor-plates-v1',
  } as const;

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      authStrategy: this.authStrategy,
      consumesQuota: this.consumesQuota,
      configured: true,
      available: true,
      description:
        'Domyślny, darmowy tryb działający natychmiast bez klucza API — tworzy spersonalizowaną bajkę po polsku z kompletem spójnych akwarelowych ilustracji książkowych.',
      defaultModels: { ...this.defaultModels },
    };
  }

  async generateBlueprint(
    input: StoryInput,
    referencePhotos: ReferencePhotoBinary[],
  ): Promise<StoryBlueprint> {
    void referencePhotos;
    return buildPolishStoryDraft(input);
  }

  async generateIllustration(
    req: IllustrationRequest,
  ): Promise<GeneratedIllustration | null> {
    const demoAssetPath = resolveDemoAssetPath(req.slot, req.totalPages);
    if (!DEMO_ASSET_PATH_REGEX.test(demoAssetPath)) {
      throw new Error(`Invalid demo asset path generated: ${demoAssetPath}`);
    }

    return {
      kind: 'demo-asset',
      mimeType: 'image/jpeg',
      demoAssetPath,
      modelUsed: this.defaultModels.imageModel,
    };
  }
}
