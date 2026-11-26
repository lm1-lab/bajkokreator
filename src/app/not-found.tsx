import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <div className="paper-card" style={{ textAlign: 'center', padding: '48px 24px' }}>
      <span className="eyebrow">Błąd 404</span>
      <h1 className="page-title" style={{ marginBottom: 10 }}>
        Nie znaleziono tej strony lub bajki
      </h1>
      <p className="page-lead" style={{ margin: '0 auto 22px' }}>
        Książeczka mogła zostać usunięta z biblioteki albo adres zawiera literówkę.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Link href="/" className="btn btn-primary">
          Wróć do kreatora
        </Link>
        <Link href="/library" className="btn btn-secondary">
          Otwórz bibliotekę
        </Link>
      </div>
    </div>
  );
}
