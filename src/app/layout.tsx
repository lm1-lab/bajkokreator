import type { Metadata } from 'next';
import { HeaderNav } from '@/components/HeaderNav';
import './globals.css';
import '@/styles/atelier.css';

export const metadata: Metadata = {
  title: 'BajkoKreator — Pracownia spersonalizowanych bajek dla dzieci',
  description:
    'Generator spersonalizowanych 10-stronicowych ilustrowanych bajek dla dzieci po polsku z eksportem do druku PDF (Kwadrat 21×21 cm oraz A4 poziomy).',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pl">
      <body>
        <div className="atelier-shell">
          <HeaderNav />
          <main className="atelier-main">{children}</main>
          <footer className="atelier-footer">
            <div className="atelier-footer-inner">
              <span>BajkoKreator — Papierowa pracownia książek dla dzieci</span>
              <span>
                Eksport PDF 21×21 cm i A4 poziomy • Polskie fonty TTF • Gotowe na Vercel
              </span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
