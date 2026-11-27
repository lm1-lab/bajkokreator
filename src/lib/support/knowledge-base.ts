import { z } from 'zod';
import rawKnowledgeBase from '@/content/knowledge-base.json';

// =============================================================================
// Structured Polish Customer Support Knowledge Base (100% browser-safe)
// =============================================================================

export const POLICY_STATUSES = ['confirmed', 'tbd_business_decision'] as const;
export const PolicyStatusSchema = z.enum(POLICY_STATUSES);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const KnowledgeBaseArticleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  title: z.string().trim().min(3).max(160),
  category: z.string().trim().min(2).max(60),
  summary: z.string().trim().min(5).max(400),
  content: z.string().trim().min(10).max(4000),
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  policyStatus: PolicyStatusSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

export const KnowledgeBaseDocumentSchema = z.object({
  version: z.number().int().min(1),
  articles: z
    .array(KnowledgeBaseArticleSchema)
    .min(1)
    .refine(
      (items) => new Set(items.map((a) => a.id)).size === items.length,
      'Identyfikatory artykułów w bazie wiedzy muszą być unikalne.',
    ),
});

export type KnowledgeBaseArticle = z.infer<typeof KnowledgeBaseArticleSchema>;
export type KnowledgeBaseDocument = z.infer<typeof KnowledgeBaseDocumentSchema>;

const validatedKb: KnowledgeBaseDocument = KnowledgeBaseDocumentSchema.parse(rawKnowledgeBase);

function normalizeForSearch(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'l')
    .toLowerCase()
    .trim();
}

export function getAllKnowledgeBaseArticles(): readonly KnowledgeBaseArticle[] {
  return validatedKb.articles;
}

export function getKnowledgeBaseCategories(): string[] {
  return Array.from(new Set(validatedKb.articles.map((a) => a.category)));
}

export interface KnowledgeBaseSearchMatch {
  article: KnowledgeBaseArticle;
  score: number;
}

export function searchKnowledgeBaseWithScores(options: {
  q?: string;
  category?: string;
  limit?: number;
}): KnowledgeBaseSearchMatch[] {
  const categoryFilter = options.category?.trim().toLowerCase();
  const rawQuery = options.q?.trim() ?? '';
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));

  let pool = [...validatedKb.articles];
  if (categoryFilter) {
    pool = pool.filter((a) => a.category.toLowerCase() === categoryFilter);
  }

  if (!rawQuery) {
    return pool.slice(0, limit).map((article) => ({ article, score: 1 }));
  }

  const normalizedQuery = normalizeForSearch(rawQuery);
  const tokens = normalizedQuery
    .split(/[\s,.;:!?()[\]"'/-]+/)
    .filter((token) => token.length >= 2);

  if (tokens.length === 0) {
    return pool.slice(0, limit).map((article) => ({ article, score: 1 }));
  }

  const scored: KnowledgeBaseSearchMatch[] = [];
  for (const article of pool) {
    const titleNorm = normalizeForSearch(article.title);
    const summaryNorm = normalizeForSearch(article.summary);
    const contentNorm = normalizeForSearch(article.content);
    const keywordsNorm = article.keywords.map(normalizeForSearch);

    let score = 0;
    if (titleNorm.includes(normalizedQuery)) score += 10;
    if (summaryNorm.includes(normalizedQuery)) score += 6;

    for (const token of tokens) {
      if (keywordsNorm.some((kw) => kw === token || kw.includes(token) || token.includes(kw))) {
        score += 5;
      }
      if (titleNorm.includes(token)) {
        score += 4;
      }
      if (summaryNorm.includes(token)) {
        score += 2;
      }
      if (contentNorm.includes(token)) {
        score += 1;
      }
    }

    if (score > 0) {
      scored.push({ article, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id));
  return scored.slice(0, limit);
}

export function searchKnowledgeBase(options: {
  q?: string;
  category?: string;
  limit?: number;
}): { articles: KnowledgeBaseArticle[]; total: number } {
  const matches = searchKnowledgeBaseWithScores(options);
  return {
    articles: matches.map((m) => m.article),
    total: matches.length,
  };
}
