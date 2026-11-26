'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/', label: 'Kreator bajki' },
  { href: '/library', label: 'Biblioteka' },
  { href: '/settings', label: 'Ustawienia AI' },
] as const;

export function HeaderNav() {
  const pathname = usePathname();

  return (
    <header className="atelier-header">
      <div className="atelier-header-inner">
        <Link href="/" className="atelier-brand">
          <span className="atelier-brand-mark" aria-hidden="true">
            B
          </span>
          <span>
            <span className="atelier-brand-title">BajkoKreator</span>
            <span className="atelier-brand-sub">Pracownia książek dla dzieci</span>
          </span>
        </Link>

        <nav className="atelier-nav" aria-label="Nawigacja główna">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`atelier-nav-link${isActive ? ' is-active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
