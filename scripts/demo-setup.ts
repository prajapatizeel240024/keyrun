// `npm run demo:setup`: with `npm run mocks` and `npm run server` already running, create demo
// tenants, enroll this machine as a device, upload encrypted credentials and queue a few tasks.
// Then start the agent with `npm run agent -- run`.
import { config, HOST } from '../src/config.ts';
import { demoSetup } from './demo-lib.ts';

const origins = {
  hr: `http://${HOST}:${config.ports.hr}`,
  helpdesk: `http://${HOST}:${config.ports.helpdesk}`,
  directory: `http://${HOST}:${config.ports.directory}`,
};
const { tenants } = await demoSetup({ serverUrl: config.serverUrl, adminToken: config.adminToken, mockOrigins: origins, agentHome: config.agentHome });
for (const [app, t] of Object.entries(tenants)) console.log(`${app.padEnd(10)} ${t.baseUrl}/`);
console.log(`\nDashboard: ${config.serverUrl}  (admin token: ${config.adminToken === 'dev-admin-token' ? 'dev-admin-token' : 'KEYRUN_ADMIN_TOKEN'})`);
console.log('Next: npm run agent -- run   (add --headed to watch the browser)');
