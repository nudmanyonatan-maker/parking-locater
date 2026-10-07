// Street cleaning on the blocks around home: when each side is cleaned next,
// and which side you can leave a car on the longest.

import { Brush } from 'lucide-react';
import { betweenText, prettyStreet, sideWord } from '../../shared/cleaning';
import { cleaningNear, getHome, longestFree, whenText } from '../lib/car';
import './street-cleaning.css';

const timeOf = (ms: number, now: number) => whenText(ms, now).replace(/^Today /, '');

export function StreetCleaningCard({ now }: { now: number }) {
  const rows = cleaningNear(getHome(), now);
  if (!rows.length) return null;
  const best = longestFree(rows);
  return (
    <section className="sc card" aria-labelledby="sc-title">
      <h2 id="sc-title">
        <Brush size={18} aria-hidden="true" /> Street cleaning near home
      </h2>
      {best?.next && (
        <p className="sc-best">
          Longest without cleaning: <strong>{prettyStreet(best.face.street)}, {sideWord(best.face)} side</strong> ({betweenText(best.face)}), until{' '}
          {whenText(best.next.start, now)}
        </p>
      )}
      <ul>
        {rows.map((r) => (
          <li key={r.face.id} className={r.next?.active ? 'sc-now' : undefined}>
            <div>
              <strong>
                {prettyStreet(r.face.street)} · {sideWord(r.face)} side
              </strong>
              <span>
                {betweenText(r.face)} · {r.schedule}
              </span>
            </div>
            <span className="sc-when">{r.next ? (r.next.active ? `Now, until ${timeOf(r.next.end, now)}` : whenText(r.next.start, now).split(' ')[0]) : '–'}</span>
          </li>
        ))}
      </ul>
      <p className="sc-note">From NYC DOT signs. Suspended on holidays (check @NYCASP).</p>
    </section>
  );
}
