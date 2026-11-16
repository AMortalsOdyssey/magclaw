import { applyServerYamlConfig } from '../config-yaml.js';
import { createCloudPostgresStore } from './postgres-store.js';

const action = process.argv[2];
if (!['status', 'enable', 'restore'].includes(action)) {
  console.error('Usage: node server/cloud/team-share-bodies-cli.js status|enable|restore');
  process.exitCode = 1;
} else {
  applyServerYamlConfig();
  const store = createCloudPostgresStore();
  if (!store) throw new Error('MAGCLAW_DATABASE_URL is required.');
  try {
    console.log(JSON.stringify(await store.manageShareBodyStorage(action)));
  } finally {
    await store.close();
  }
}
