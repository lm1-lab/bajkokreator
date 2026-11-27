import Link from 'next/link';
import { OrderLookupWidget } from '@/components/OrderLookupWidget';

export const dynamic = 'force-dynamic';

export default function OrdersPage() {
  return (
    <div>
      <section className="page-intro">
        <span className="eyebrow">Realizacja druku i śledzenie</span>
        <h1 className="page-title">Status zamówienia książki</h1>
        <p className="page-lead">
          Sprawdź aktualny etap realizacji swojej spersonalizowanej bajki — od szkicu i
          akceptacji podglądu przez kontrolę techniczną Pre-Flight aż po druk i wysyłkę.
        </p>
      </section>

      <OrderLookupWidget />

      <section className="paper-card" style={{ marginTop: 20 }}>
        <h2 className="section-heading">Jak przebiega realizacja druku?</h2>
        <p className="section-note">
          Każde zamówienie przechodzi bezpieczne, deterministyczne etapy: szkic → płatność →
          Twoje zatwierdzenie podglądu → automatyczny Pre-Flight poligraficzny → przekazanie do
          drukarni → wysyłka. Masz pytania?{' '}
          <Link href="/pomoc" style={{ textDecoration: 'underline' }}>
            Otwórz Centrum Pomocy
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
