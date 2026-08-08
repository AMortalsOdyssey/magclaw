import { applyNotifyUpdate } from '../../notify/src/update.js';

const [home, npmPath, targetVersion, currentVersion] = process.argv.slice(2);
try {
  const result = await applyNotifyUpdate(targetVersion, { npmPath, currentVersion }, { ...process.env, MAGCLAW_NOTIFY_HOME: home });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
