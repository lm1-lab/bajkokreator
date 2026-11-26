import { buildPolishStoryDraft } from '@/lib/polish/templates';
import type { StoryBlueprint, StoryInput } from '@/lib/types/story';
import type {
  GeneratedIllustration,
  IllustrationRequest,
  ProviderStatus,
  ReferencePhotoBinary,
  StoryProvider,
} from '@/lib/ai/provider';

export class ManualStoryProvider implements StoryProvider {
  readonly id = 'manual' as const;
  readonly name = 'Tryb Ręczny (prompty Nano Banana)';
  readonly authStrategy = 'none' as const;
  readonly consumesQuota = false;
  readonly defaultModels = {
    textModel: 'manual-polish-craft-v1',
    imageModel: 'manual-user-upload',
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
        'Tworzy pełny polski scenariusz bajki oraz gotowe angielskie prompty z niezmienną Biblią Postaci do kopiowania 1 kliknięciem (pod Nano Banana / Gemini) i ręcznego wgrania ilustracji.',
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
    void req;
    return null;
  }
}
