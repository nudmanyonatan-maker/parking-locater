// Two tabs: Find parking (cameras + street cleaning) and My car.

import { Car, SquareParking } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import './tabbar.css';

const TABS = [
  { href: '/', label: 'Find parking', Icon: SquareParking },
  { href: '/car', label: 'My car', Icon: Car },
] as const;

export function TabBar() {
  const [location] = useLocation();
  return (
    <nav className="tabbar glass" aria-label="Sections">
      {TABS.map(({ href, label, Icon }) => (
        <Link key={href} href={href} className="tabbar-item" aria-current={location === href ? 'page' : undefined}>
          <Icon size={24} aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
