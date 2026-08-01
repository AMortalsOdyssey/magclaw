#!/usr/bin/env node
import { profilePaths } from '../src/cli.js';
import {
  addNotifyGroup,
  addNotifyPerson,
  configureNotifyHandler,
  confirmNotifyMapping,
  installNotifyHandlerSkill,
  notifyHandlerStatus,
  registerNotifyRoute,
  syncNotifyDirectory,
} from '../src/notify-handler.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { command: positional[0] || 'status', flags };
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  const paths = profilePaths(flags.profile || 'default');
  let result;
  if (command === 'install-skill') {
    result = await installNotifyHandlerSkill({ targets: list(flags.targets || flags.target || 'openclaw') });
  } else if (command === 'configure') {
    result = await configureNotifyHandler(paths, {
      ...(flags.enabled !== undefined ? { enabled: flags.enabled !== 'false' } : {}),
      agentProvider: {
        ...(flags.agentProvider ? { kind: flags.agentProvider } : {}),
        ...(flags.agentCommand ? { command: flags.agentCommand } : {}),
        ...(flags.agentId ? { agentId: flags.agentId } : {}),
      },
      deliveryProvider: {
        ...(flags.deliveryProvider ? { kind: flags.deliveryProvider } : {}),
        ...(flags.deliveryCommand ? { command: flags.deliveryCommand } : {}),
        ...(flags.deliveryAccount !== undefined ? { account: flags.deliveryAccount } : {}),
        ...(flags.deliveryEnabled !== undefined ? { enabled: flags.deliveryEnabled !== 'false' } : {}),
        ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun !== 'false' } : {}),
      },
      confirmationProvider: {
        ...(flags.confirmationProvider ? { kind: flags.confirmationProvider } : {}),
        ...(flags.confirmationCommand ? { command: flags.confirmationCommand } : {}),
        ...(flags.confirmationAccount !== undefined ? { account: flags.confirmationAccount } : {}),
        ...(flags.confirmationTarget !== undefined ? { target: flags.confirmationTarget } : {}),
        ...(flags.confirmationEnabled !== undefined ? { enabled: flags.confirmationEnabled !== 'false' } : {}),
        ...(flags.confirmationDryRun !== undefined ? { dryRun: flags.confirmationDryRun !== 'false' } : {}),
      },
    });
  } else if (command === 'add-group') {
    result = await addNotifyGroup(paths, { name: flags.name, chatId: flags.chatId || '', aliases: list(flags.aliases || flags.alias) });
  } else if (command === 'add-person') {
    result = await addNotifyPerson(paths, { name: flags.name, openId: flags.openId || '', aliases: list(flags.aliases || flags.alias), groupChatIds: list(flags.groupChatIds || flags.groupChatId) });
  } else if (command === 'confirm') {
    if (Boolean(flags.approve) === Boolean(flags.reject)) throw new Error('Choose exactly one of --approve or --reject.');
    result = await confirmNotifyMapping(paths, flags.id, flags.approve ? 'approve' : 'reject', {
      personMappings: list(flags.personMap || flags.personMaps),
    });
  } else if (command === 'sync-directory') {
    result = await syncNotifyDirectory(paths);
  } else if (command === 'register-route') {
    result = await registerNotifyRoute(paths);
  } else if (command === 'status') {
    result = await notifyHandlerStatus(paths);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
