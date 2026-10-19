// Plausible fake people for seeding the mock apps. Domains use the reserved .test TLD.
import type { Rng } from '../shared/rng.ts';
import type { SeedUser } from './core.ts';

const FIRST = ['Ada', 'Bilal', 'Chen', 'Dara', 'Elif', 'Femi', 'Gita', 'Hugo', 'Ines', 'Jonah', 'Kemal', 'Lena', 'Mateo', 'Noor',
  'Oskar', 'Priya', 'Quinn', 'Rosa', 'Sami', 'Tariq', 'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zoe'];
const LAST = ['Abara', 'Bergstrom', 'Castillo', 'Dubois', 'Eriksen', 'Fontaine', 'Gupta', 'Haddad', 'Ivanova', 'Jensen', 'Kowalski',
  'Laine', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quispe', 'Rahman', 'Silva', 'Tanaka', 'Underwood', 'Varga', 'Weber', 'Yilmaz'];

export function personName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

export function emailFor(name: string, salt: string | number): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${salt}@example.test`;
}

export function seedPeople(rng: Rng, n: number, roles: string[]): SeedUser[] {
  const out: SeedUser[] = [];
  for (let i = 0; i < n; i++) {
    const name = personName(rng);
    out.push({ name, email: emailFor(name, `${i}${rng.int(10, 99)}`), role: rng.pick(roles) });
  }
  return out;
}
