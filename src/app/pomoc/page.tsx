import { HelpCenter } from '@/components/HelpCenter';
import {
  getAllKnowledgeBaseArticles,
  getKnowledgeBaseCategories,
} from '@/lib/support/knowledge-base';

export const dynamic = 'force-dynamic';

export default function PomocPage() {
  const articles = getAllKnowledgeBaseArticles();
  const categories = getKnowledgeBaseCategories();

  return (
    <div>
      <section className="page-intro">
        <span className="eyebrow">Obsługa klienta i baza wiedzy</span>
        <h1 className="page-title">Centrum Pomocy BajkoKreatora</h1>
        <p className="page-lead">
          Odpowiedzi na najczęstsze pytania, sprawdzanie statusu zamówienia oraz bezpośredni
          kontakt z pracownią.
        </p>
      </section>

      <HelpCenter initialArticles={articles} categories={categories} />
    </div>
  );
}
