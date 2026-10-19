// `npm run mocks`: start the three mock admin portals and create one demo tenant in each.
import { config } from '../config.ts';
import { seededRng } from '../shared/rng.ts';
import { startMocks, APP_NAMES, APP_ROLES } from './index.ts';
import { APP_IDS, sampleMess } from './mess.ts';
import { seedPeople } from './people.ts';

const mocks = await startMocks(config.ports);
const rng = seededRng(Date.now());
console.log('Mock apps (local only):');
for (const app of APP_IDS) {
  const t = await mocks.createTenant(app, { mess: sampleMess(app, rng), users: seedPeople(rng, 23, APP_ROLES[app]) });
  console.log(`\n  ${APP_NAMES[app]}  ${mocks.origins[app]}`);
  console.log(`    demo tenant  ${t.baseUrl}/`);
  console.log(`    sign in as   ${t.admin.email} / ${t.admin.password}`);
  if (t.admin.totpSecret) console.log(`    TOTP secret  ${t.admin.totpSecret}`);
}
console.log('\nCreate more tenants with POST <origin>/__admin/tenants. Ctrl+C to stop.');
