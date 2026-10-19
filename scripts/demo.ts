// `npm run demo`: everything in one process for a quick look. Starts the three mock apps, the
// control plane and a local agent, creates demo tenants, uploads encrypted credentials and
// queues a few tasks. Open the dashboard, approve the tasks that need it, and watch them run.
// Flags: --headed (watch the browser)
import path from 'node:path';
import { Agent } from '../src/agent/agent.ts';
import { config } from '../src/config.ts';
import { closeAllPools, pool } from '../src/db/pool.ts';
import { startMocks } from '../src/mocks/index.ts';
import { startControlPlane } from '../src/server/main.ts';
import { demoSetup } from './demo-lib.ts';

const mocks = await startMocks(config.ports);
const { server, url } = await startControlPlane(pool(config.databaseUrl));
const { tenants } = await demoSetup({ serverUrl: url, adminToken: config.adminToken, mockOrigins: mocks.origins, agentHome: config.agentHome, log: () => {} });

console.log('Keyrun demo (everything on 127.0.0.1)\n');
for (const [app, t] of Object.entries(tenants)) {
  console.log(`  ${app.padEnd(10)} ${t.baseUrl}/   sign in as ${t.admin.email}${t.admin.totpSecret ? ' (+TOTP)' : ''}`);
}
console.log(`\n  Dashboard  ${url}   admin token: ${config.adminToken}`);
console.log(`  Editor     ${url}/builder`);
console.log('\nQueued: HR sign-in, Helpdesk invite + password rotation (run now), HR removal and Directory invite (need approval).');
console.log('Approve them on the dashboard as someone other than "alex". Ctrl+C to stop.\n');

const agent = await new Agent({ home: config.agentHome, serverUrl: url, headless: !process.argv.includes('--headed'), artifactsDir: path.resolve('artifacts/agent') }).init();
const ctrl = new AbortController();
process.once('SIGINT', async () => {
  ctrl.abort();
  console.log('\nStopping…');
});
await agent.loop(ctrl.signal);
server.close();
await mocks.close();
await closeAllPools();
