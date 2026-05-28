import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_BIN = path.join(ROOT, 'daemon', 'bin', 'magclaw-daemon.js');

function websocketAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeServerFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const length = data.length;
  const header = length < 126
    ? Buffer.alloc(2)
    : length < 65536
      ? Buffer.alloc(4)
      : Buffer.alloc(10);
  header[0] = 0x81;
  if (length < 126) {
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeClientFrames(connection, chunk) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  const frames = [];
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (connection.buffer.length < offset + 2) break;
      length = connection.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (connection.buffer.length < offset + 8) break;
      length = Number(connection.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (connection.buffer.length < offset + length) break;
    const payload = Buffer.from(connection.buffer.subarray(offset, offset + length));
    if (masked) {
      const mask = connection.buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    connection.buffer = connection.buffer.subarray(offset + length);
    frames.push({ opcode, text: payload.toString('utf8') });
  }
  return frames;
}

function waitFor(fn, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('timed out waiting for condition'));
          return;
        }
        setTimeout(tick, 60);
      } catch (error) {
        reject(error);
      }
    };
    tick();
  });
}

async function startRelay(options = {}) {
  const messages = [];
  const readAttachmentRequests = [];
  const sockets = new Set();
  let activeSocket = null;
  const clipboardAttachmentDataUrl = `data:image/png;base64,${Buffer.from('remote-clipboard-image').toString('base64')}`;
  const uploadAttachmentDataUrl = `data:image/jpeg;base64,${Buffer.from('remote-upload-image').toString('base64')}`;
  const avatarDataUrl = `data:image/png;base64,${Buffer.from('remote-avatar').toString('base64')}`;
  const peerAvatarDataUrl = `data:image/png;base64,${Buffer.from('peer-avatar').toString('base64')}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/agent-tools/attachments/read') {
      assert.equal(req.headers.authorization, 'Bearer mc_machine_test');
      assert.equal(url.searchParams.get('agentId'), options.agent?.id || 'agt_remote');
      const attachmentId = url.searchParams.get('attachmentId');
      readAttachmentRequests.push(attachmentId);
      const isUpload = attachmentId === 'att_upload';
      const isClipboard = attachmentId === 'att_clip';
      assert.equal(isUpload || isClipboard, true);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        attachment: {
          id: attachmentId,
          name: isUpload ? 'upload.jpeg' : 'clip.png',
          type: isUpload ? 'image/jpeg' : 'image/png',
          bytes: 12,
          source: isUpload ? 'upload' : 'clipboard',
        },
        file: {
          name: isUpload ? 'upload.jpeg' : 'clip.png',
          type: isUpload ? 'image/jpeg' : 'image/png',
          sizeBytes: 12,
          readBytes: 12,
          truncated: false,
        },
        dataUrl: isUpload ? uploadAttachmentDataUrl : clipboardAttachmentDataUrl,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    assert.equal(url.pathname, '/daemon/connect');
    assert.equal(url.searchParams.get('pair_token'), 'mc_pair_test');
    const key = String(req.headers['sec-websocket-key'] || '');
    const welcomeFrame = encodeServerFrame({
      type: 'pairing:accepted',
      computerId: 'cmp_remote_test',
      workspaceId: 'wsp_test',
      machineToken: 'mc_machine_test',
    });
    const handshake = Buffer.from([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));
    socket.write(options.welcomeInUpgradeHead ? Buffer.concat([handshake, welcomeFrame]) : handshake);
    activeSocket = socket;
    sockets.add(socket);
    const connection = { buffer: Buffer.alloc(0) };
    if (!options.welcomeInUpgradeHead) socket.write(welcomeFrame);
    socket.on('data', (chunk) => {
      for (const frame of decodeClientFrames(connection, chunk)) {
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.text);
        messages.push(message);
        if (message.type === 'ready') {
          socket.write(encodeServerFrame({ type: 'ready:ack', computerId: 'cmp_remote_test' }));
          socket.write(encodeServerFrame({
            type: 'agent:deliver',
            commandId: 'adl_test',
            seq: 1,
            agentId: options.agent?.id || 'agt_remote',
            workspaceId: 'wsp_test',
            payload: {
              agent: {
                id: options.agent?.id || 'agt_remote',
                name: options.agent?.name || 'Remote Codex',
                description: options.agent?.description || 'Remote agent that loves concise jokes',
                runtime: options.agent?.runtime || 'codex',
                model: options.agent?.model || 'gpt-test',
                reasoningEffort: 'low',
              },
              message: {
                id: 'msg_test',
                body: 'hello from cloud',
                spaceType: 'channel',
                spaceId: 'chan_all',
                parentMessageId: null,
                workItemId: 'wi_test',
                attachmentIds: ['att_upload', 'att_clip'],
                contextPack: {
                  targetAgentId: options.agent?.id || 'agt_remote',
                  targetAgent: {
                    id: options.agent?.id || 'agt_remote',
                    name: options.agent?.name || 'Remote Codex',
                    avatar: {
                      kind: 'data_url',
                      type: 'image/png',
                      dataUrl: avatarDataUrl,
                      visualInput: true,
                    },
                  },
                  space: { type: 'channel', id: 'chan_all', label: '#all', visibility: 'public', defaultChannel: false },
                  participants: [
                    { id: 'hum_test', name: 'Human', type: 'human', role: 'owner', status: 'online' },
                    {
                      id: options.agent?.id || 'agt_remote',
                      name: options.agent?.name || 'Remote Codex',
                      type: 'agent',
                      description: options.agent?.description || 'Remote agent that loves concise jokes',
                      runtime: options.agent?.runtime || 'codex',
                      status: 'idle',
                    },
                    {
                      id: 'agt_ka',
                      name: 'KA',
                      type: 'agent',
                      description: 'Likes telling jokes',
                      runtime: 'codex',
                      status: 'idle',
                      avatar: {
                        kind: 'data_url',
                        type: 'image/png',
                        dataUrl: peerAvatarDataUrl,
                        visualInput: true,
                      },
                    },
                  ],
                  suggestedMembers: [
                    { id: 'agt_research', name: 'Research', type: 'agent', description: 'Finds background information', runtime: 'codex', status: 'idle' },
                    { id: 'agt_design', name: 'Design', type: 'agent', description: 'Reviews visual flows', runtime: 'claude-code', status: 'idle' },
                  ],
                  currentMessage: {
                    id: 'msg_test',
                    authorType: 'human',
                    authorId: 'hum_test',
                    body: 'Who is good at jokes?',
                    mentionedAgentIds: [],
                    attachmentIds: ['att_upload', 'att_clip'],
                    createdAt: '2026-05-14T06:13:30.000Z',
                  },
                  recentMessages: [],
                  recentEvents: [{
                    id: 'evt_remote_join',
                    type: 'channel_member_added',
                    channelId: 'chan_all',
                    memberId: 'agt_ka',
                    message: 'Member added to #all',
                    createdAt: '2026-05-14T06:13:00.000Z',
                  }],
                  tasks: [],
                  attachments: [{
                    id: 'att_old',
                    name: 'old.png',
                    type: 'image/png',
                    bytes: 12,
                    url: '/api/attachments/att_old/old.png?workspaceId=wsp_test',
                    source: 'upload',
                    messageId: 'msg_old',
                  }, {
                    id: 'att_upload',
                    name: 'upload.jpeg',
                    type: 'image/jpeg',
                    bytes: 12,
                    url: '/api/attachments/att_upload/upload.jpeg?workspaceId=wsp_test',
                    dataUrl: uploadAttachmentDataUrl,
                    source: 'upload',
                    messageId: 'msg_test',
                  }, {
                    id: 'att_clip',
                    name: 'clip.png',
                    type: 'image/png',
                    bytes: 12,
                    path: '/var/lib/magclaw/uploads/2026/05/att_clip.png',
                    url: '/api/attachments/att_clip/clip.png?workspaceId=wsp_test',
                    source: 'clipboard',
                    messageId: 'msg_test',
                  }],
                  peerMemorySearch: { required: false, results: [] },
                },
              },
              workItem: { id: 'wi_test' },
            },
          }));
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    messages,
    readAttachmentRequests,
    send(payload) {
      activeSocket?.write(encodeServerFrame(payload));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('npm daemon pairs, starts fake Codex app-server, and returns an agent message', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-relay-'));
  const sourceHome = path.join(tmp, 'source-codex-home');
  const externalGlobalSkill = path.join(tmp, 'external-global-skills', 'itinerary-scout');
  await mkdir(path.join(sourceHome, 'skills'), { recursive: true });
  await mkdir(externalGlobalSkill, { recursive: true });
  await writeFile(path.join(externalGlobalSkill, 'SKILL.md'), [
    '---',
    'name: itinerary-scout',
    'description: Finds practical travel routes.',
    '---',
    '',
    '# Itinerary Scout',
  ].join('\n'));
  await symlink(externalGlobalSkill, path.join(sourceHome, 'skills', 'itinerary-scout'), 'dir');
  const fakeCodex = path.join(tmp, 'codex-fake.js');
  const logPath = path.join(tmp, 'codex-log.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
if (args[0] === '--version') {
  console.log('codex-cli fake-daemon-test');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  console.log('Usage: codex app-server --listen stdio://');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(2);
log({ mode: 'app-server', args, env: { CODEX_HOME: process.env.CODEX_HOME, MAGCLAW_SERVER_URL: process.env.MAGCLAW_SERVER_URL } });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ method: message.method, params: message.params });
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_remote_fake' } } });
    } else if (message.method === 'turn/start' || message.method === 'turn/steer') {
      send({ id: message.id, result: { turn: { id: 'turn_remote_fake' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_remote_fake' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'item_remote_fake', delta: 'remote fake response' } });
      send({ method: 'item/completed', params: { item: { id: 'item_remote_fake', type: 'agentMessage', text: 'remote fake response' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn_remote_fake', status: 'completed' } } });
    }
  }
});
`);
  await chmod(fakeCodex, 0o755);
  const relay = await startRelay({ welcomeInUpgradeHead: true });
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      MAGCLAW_CODEX_HOME_SOURCE: sourceHome,
      CODEX_PATH: fakeCodex,
      FAKE_CODEX_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const message = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message'));
    assert.equal(message.agentId, 'agt_remote');
    assert.equal(message.payload.body, 'remote fake response');
    assert.equal((message.payload.body.match(/remote fake response/g) || []).length, 1);
    assert.equal(message.payload.spaceType, 'channel');
    assert.equal(message.payload.spaceId, 'chan_all');
    assert.ok(relay.messages.some((item) => item.type === 'agent:deliver:ack' && item.commandId === 'adl_test'));
    assert.ok(relay.messages.some((item) => item.type === 'agent:session' && item.sessionId === 'thread_remote_fake'));
    relay.send({
      type: 'agent:deliver',
      commandId: 'adl_test',
      seq: 1,
      agentId: 'agt_remote',
      workspaceId: 'wsp_test',
      payload: {
        agent: {
          id: 'agt_remote',
          name: 'Remote Codex',
          description: 'Remote agent that loves concise jokes',
          runtime: 'codex',
          model: 'gpt-test',
          reasoningEffort: 'low',
        },
        message: {
          id: 'msg_test',
          body: 'hello from cloud',
          spaceType: 'channel',
          spaceId: 'chan_all',
          parentMessageId: null,
          workItemId: 'wi_test',
        },
        workItem: { id: 'wi_test' },
      },
    });
    await waitFor(() => relay.messages.filter((item) => item.type === 'agent:deliver:ack' && item.commandId === 'adl_test').length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const daemonAgentRoot = path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'agents', 'agt_remote');
    const workspaceSkillsRoot = path.join(daemonAgentRoot, 'workspace', 'skills');
    const localSkillRoot = path.join(workspaceSkillsRoot, 'route-coach');
    await mkdir(localSkillRoot, { recursive: true });
    await writeFile(path.join(localSkillRoot, 'SKILL.md'), [
      '---',
      'name: route-coach',
      'description: Agent-local route coaching skill.',
      '---',
      '',
      '# Route Coach',
    ].join('\n'));
    relay.send({ type: 'agent:skills:list', commandId: 'skills_test', agentId: 'agt_remote' });
    const skillResult = await waitFor(() => relay.messages.find((item) => item.type === 'agent:skills:list_result'));
    assert.equal(skillResult.commandId, 'skills_test');
    assert.ok(skillResult.skills.global.some((skill) => skill.name === 'itinerary-scout'));
    assert.equal(skillResult.skills.workspace.some((skill) => skill.name === 'itinerary-scout'), false);
    assert.ok(skillResult.skills.workspace.some((skill) => skill.name === 'route-coach'));
    const workspaceSkillsStat = await lstat(workspaceSkillsRoot);
    assert.equal(workspaceSkillsStat.isDirectory(), true);
    assert.equal(workspaceSkillsStat.isSymbolicLink(), false);
    assert.equal(
      await realpath(path.join(daemonAgentRoot, 'codex-home', 'skills', 'route-coach')),
      await realpath(localSkillRoot),
    );
    assert.ok(skillResult.skills.tools.includes('send_message'));
    relay.send({
      type: 'daemon:release_notice',
      commandId: 'notice_test',
      notice: {
        version: '0.50.0',
        title: 'Daemon release notice',
        body: 'Runtime migration notice available.',
      },
    });
    await waitFor(() => relay.messages.find((item) => item.type === 'daemon:release_notice:ack' && item.commandId === 'notice_test'));

    const saved = JSON.parse(await readFile(path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'config.json'), 'utf8'));
    assert.equal(saved.token, 'mc_machine_test');
    assert.equal(saved.pairToken, '');
    const releaseNotices = JSON.parse(await readFile(path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'release-notices.json'), 'utf8'));
    assert.equal(releaseNotices.notices[0].version, '0.50.0');
    const duplicate = spawn(process.execPath, [
      DAEMON_BIN,
      'connect',
      '--server-url',
      relay.baseUrl,
      '--pair-token',
      'mc_pair_test',
      '--profile',
      'cloud-test',
    ], {
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
        CODEX_PATH: fakeCodex,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let duplicateOutput = '';
    duplicate.stdout.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    duplicate.stderr.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    const duplicateCode = await new Promise((resolve) => duplicate.once('exit', resolve));
    assert.equal(duplicateCode, 1);
    assert.match(duplicateOutput, /already running/);
    const entries = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const appServer = entries.find((entry) => entry.mode === 'app-server');
    assert.match(appServer.env.CODEX_HOME, /daemon-home\/profiles\/cloud-test\/agents\/agt_remote\/codex-home$/);
    const agentRoot = path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'agents', 'agt_remote');
    const remoteMemory = await readFile(path.join(agentRoot, 'MEMORY.md'), 'utf8');
    assert.match(remoteMemory, /## 渐进式披露/);
    assert.match(remoteMemory, /默认只会先读取本文件/);
    assert.equal((await lstat(path.join(agentRoot, 'notes'))).isDirectory(), true);
    relay.send({ type: 'agent:workspace:list', commandId: 'workspace_list_test', agentId: 'agt_remote', path: '' });
    const workspaceList = await waitFor(() => relay.messages.find((item) => item.type === 'agent:workspace:list_result'));
    assert.equal(workspaceList.commandId, 'workspace_list_test');
    assert.ok(workspaceList.tree.entries.some((entry) => entry.path === 'MEMORY.md'));
    relay.send({ type: 'agent:workspace:file', commandId: 'workspace_file_test', agentId: 'agt_remote', path: 'MEMORY.md' });
    const workspaceFile = await waitFor(() => relay.messages.find((item) => item.type === 'agent:workspace:file_result'));
    assert.equal(workspaceFile.commandId, 'workspace_file_test');
    assert.match(workspaceFile.file.content, /## 渐进式披露/);
    const codexHooksJson = path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks.json');
    const codexHooksDir = path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks');
    assert.deepEqual(JSON.parse(await readFile(codexHooksJson, 'utf8')), { hooks: [] });
    assert.equal((await lstat(codexHooksDir)).isDirectory(), true);
    assert.equal(await realpath(path.join(appServer.env.CODEX_HOME, 'hooks.json')), await realpath(codexHooksJson));
    assert.equal(await realpath(path.join(appServer.env.CODEX_HOME, 'hooks')), await realpath(codexHooksDir));
    const agentCodexConfig = await readFile(path.join(appServer.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(agentCodexConfig, /wire_api\s*=\s*"responses"/);
    assert.match(agentCodexConfig, new RegExp(`\\[projects\\.${JSON.stringify(sourceHome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
    assert.match(agentCodexConfig, /trust_level\s*=\s*"trusted"/);
    assert.ok(appServer.args.some((arg) => String(arg).includes('mcp_servers.magclaw.args')));
    assert.equal(appServer.args.some((arg) => String(arg).includes('mc_machine_test')), false);
    assert.ok(entries.some((entry) => entry.method === 'turn/start'));
    assert.equal(entries.filter((entry) => entry.method === 'turn/start' || entry.method === 'turn/steer').length, 1);
    const deliveryLedger = JSON.parse(await readFile(path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'delivery-ledger.json'), 'utf8'));
    const ledgerRecord = deliveryLedger.records.find((record) => record.deliveryId === 'adl_test');
    assert.equal(ledgerRecord.status, 'completed');
    const turnStart = entries.find((entry) => entry.method === 'turn/start');
    const promptText = turnStart.params.input[0].text;
    assert.deepEqual(turnStart.params.input.slice(1), [
      { type: 'image', url: `data:image/jpeg;base64,${Buffer.from('remote-upload-image').toString('base64')}` },
      { type: 'image', url: `data:image/png;base64,${Buffer.from('remote-clipboard-image').toString('base64')}` },
      { type: 'image', url: `data:image/png;base64,${Buffer.from('remote-avatar').toString('base64')}` },
      { type: 'image', url: `data:image/png;base64,${Buffer.from('peer-avatar').toString('base64')}` },
    ]);
    assert.deepEqual(relay.readAttachmentRequests, ['att_clip']);
    assert.match(promptText, /Agent description: Remote agent that loves concise jokes/);
    assert.match(promptText, /Participants shown: @Human - human; role=owner; status=online, @Remote Codex \(you\) - agent; runtime=codex; status=idle; description=Remote agent that loves concise jokes, @KA - agent; runtime=codex; status=idle; description=Likes telling jokes/);
    assert.match(promptText, /Your profile avatar: image supplied as visual input/);
    assert.match(promptText, /Participant avatar visual inputs: @KA/);
    assert.match(promptText, /Visible attachment metadata and original-file tools:[\s\S]*upload\.jpeg image\/jpeg 12 bytes \(id=att_upload, from msg=msg_test, source=upload/);
    assert.match(promptText, /Visible attachment metadata and original-file tools:[\s\S]*clip\.png image\/png 12 bytes \(id=att_clip, from msg=msg_test, source=clipboard/);
    assert.match(promptText, /Server members not in this channel yet:/);
    assert.match(promptText, /Agents available to suggest adding:[\s\S]*@Research - agent; runtime=codex; status=idle; description=Finds background information/);
    assert.match(promptText, /These are server-scoped members across connected computers/);
    assert.match(promptText, /Recent channel activity/);
    assert.match(promptText, /@KA joined this channel/);
    assert.match(promptText, /Use channel activity to resolve implicit references/);
    assert.match(promptText, /Progressive context tools: list_agents, read_agent_profile, read_agent_avatar, read_history/);
    assert.match(promptText, /call list_agents without a target for the server-wide agent roster/);
    assert.match(promptText, /MAGCLAW_MACHINE_TOKEN/);
    assert.match(promptText, /Current message:\n\[msg=msg_test .* @Human: Who is good at jokes\?/);
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('npm daemon reports Codex responses websocket stderr as an agent error', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-codex-stderr-error-'));
  const fakeCodex = path.join(tmp, 'codex-fake.js');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
if (args[0] === '--version') {
  console.log('codex-cli fake-daemon-error-test');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  console.log('Usage: codex app-server --listen stdio://');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(2);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_remote_error' } } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_remote_error' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_remote_error' } } });
      setTimeout(() => {
        process.stderr.write('2026-05-28T08:48:14.957761Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection reset by peer (os error 104), url: wss://api.openai.com/v1/responses\\n');
      }, 20);
    }
  }
});
`);
  await chmod(fakeCodex, 0o755);
  const relay = await startRelay({ welcomeInUpgradeHead: true });
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-codex-error-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      CODEX_PATH: fakeCodex,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const status = await waitFor(() => relay.messages.find((item) => item.type === 'agent:status' && item.agentId === 'agt_remote' && item.status === 'error'), 5000);
    assert.equal(status.deliveryId, 'adl_test');
    assert.match(status.activity?.error || status.activity?.text || '', /responses_websocket/);
    assert.ok(relay.messages.some((item) => item.type === 'agent:error' && item.agentId === 'agt_remote'));
    const ledger = JSON.parse(await readFile(path.join(tmp, 'daemon-home', 'profiles', 'cloud-codex-error-test', 'delivery-ledger.json'), 'utf8'));
    const delivery = ledger.records.find((record) => record.deliveryId === 'adl_test');
    assert.equal(delivery.status, 'failed');
    assert.match(delivery.error, /responses_websocket/);
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('npm daemon applies MagClaw Codex permission policy instead of hanging the turn', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-approval-'));
  const fakeCodex = path.join(tmp, 'codex-fake.js');
  const logPath = path.join(tmp, 'codex-log.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
if (args[0] === '--version') {
  console.log('codex-cli fake-daemon-approval-test');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  console.log('Usage: codex app-server --listen stdio://');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(2);
log({ mode: 'app-server', args });
let buffer = '';
function requestCommandApproval() {
  send({
    id: 701,
    method: 'item/commandExecution/requestApproval',
    params: { command: 'kubectl get namespaces', cwd: '/workspace', reason: 'requires unsandboxed execution' },
  });
}
function requestFileApproval() {
  send({
    id: 702,
    method: 'item/fileChange/requestApproval',
    params: { reason: 'write outside the trusted workspace', changes: [{ path: '/tmp/outside.txt', action: 'write' }] },
  });
}
function requestPermissionsApproval() {
  send({
    id: 703,
    method: 'item/permissions/requestApproval',
    params: { permissions: { shell: { sandbox: 'danger-full-access' } }, scope: 'turn' },
  });
}
function finishTurn() {
  send({ method: 'item/agentMessage/delta', params: { itemId: 'item_approval_safe', delta: 'approval request was closed safely' } });
  send({ method: 'turn/completed', params: { turn: { id: 'turn_approval_safe', status: 'completed' } } });
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ method: message.method, id: message.id, params: message.params, result: message.result, error: message.error });
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_approval_safe' } } });
    } else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_approval_safe' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_approval_safe' } } });
      setTimeout(requestCommandApproval, 20);
    } else if (message.id === 701 && message.result?.decision === 'approve') {
      requestFileApproval();
    } else if (message.id === 702 && message.result?.decision === 'approve') {
      requestPermissionsApproval();
    } else if (message.id === 703 && message.result?.permissions?.shell?.sandbox === 'danger-full-access') {
      finishTurn();
    }
  }
});
`);
  await chmod(fakeCodex, 0o755);
  const relay = await startRelay({ welcomeInUpgradeHead: true });
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-approval-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      CODEX_PATH: fakeCodex,
      FAKE_CODEX_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const message = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message'), 5000);
    assert.equal(message.agentId, 'agt_remote');
    assert.equal(message.payload.body, 'approval request was closed safely');
    assert.equal(relay.messages.filter((item) => item.type === 'agent:message').length, 1);
    assert.ok(relay.messages.some((item) => item.type === 'agent:activity'
      && item.activity?.source === 'codex-permission'
      && item.activity?.decision === 'approve'
      && item.activity?.method === 'item/commandExecution/requestApproval'));
    const entries = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const threadStart = entries.find((entry) => entry.method === 'thread/start');
    const turnStart = entries.find((entry) => entry.method === 'turn/start');
    assert.equal(threadStart.params.approvalPolicy, 'never');
    assert.equal(threadStart.params.sandbox, 'danger-full-access');
    assert.match(threadStart.params.developerInstructions, /Operation permission profile/);
    assert.equal(turnStart.params.approvalPolicy, 'never');
    assert.match(turnStart.params.input[0].text, /默认允许常规开发操作/);
    assert.match(turnStart.params.input[0].text, /高风险动作必须先确认/);
    assert.ok(entries.some((entry) => entry.id === 701 && entry.result?.decision === 'approve'));
    assert.ok(entries.some((entry) => entry.id === 702 && entry.result?.decision === 'approve'));
    assert.ok(entries.some((entry) => entry.id === 703 && entry.result?.permissions?.shell?.sandbox === 'danger-full-access'));
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('npm daemon dispatches Claude Code agents through the Claude runner', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-claude-'));
  const fakeClaude = path.join(tmp, 'claude-fake.js');
  const logPath = path.join(tmp, 'claude-log.jsonl');
  await writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CLAUDE_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), env: { MAGCLAW_AGENT_ID: process.env.MAGCLAW_AGENT_ID } }) + '\\n');
if (args[0] === '--version') {
  console.log('2.1.71 (Claude Code)');
  process.exit(0);
}
if (args.includes('--output-format') && args.includes('stream-json')) {
  setTimeout(() => console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_stream_session', model: 'claude-sonnet-4-6' })), 5);
  setTimeout(() => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'remote ' }] } })), 20);
  setTimeout(() => console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude response' }] } })), 40);
  setTimeout(() => console.log(JSON.stringify({ type: 'result', session_id: 'claude_stream_session', usage: { input_tokens: 3, output_tokens: 4 } })), 60);
  setTimeout(() => process.exit(0), 80);
  return;
}
process.exit(2);
`);
  await chmod(fakeClaude, 0o755);
  const relay = await startRelay({
    agent: {
      id: 'agt_claude_remote',
      name: 'Remote Claude',
      runtime: 'claude-code',
      model: 'claude-sonnet-4-6',
    },
  });
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-claude-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      CODEX_PATH: '/bin/false',
      CLAUDE_PATH: fakeClaude,
      FAKE_CLAUDE_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const delta = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message_delta'));
    assert.equal(delta.agentId, 'agt_claude_remote');
    assert.equal(delta.payload.body, 'remote claude response');
    assert.equal(delta.deliveryId, 'adl_test');
    const message = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message'));
    assert.equal(message.agentId, 'agt_claude_remote');
    assert.equal(message.payload.body, 'remote claude response');
    assert.ok(relay.messages.some((item) => item.type === 'agent:deliver:ack' && item.commandId === 'adl_test'));
    assert.ok(relay.messages.some((item) => item.type === 'agent:status' && item.agentId === 'agt_claude_remote' && item.status === 'idle'));
    const entries = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(entries.some((entry) => entry.args.includes('--output-format') && entry.args.includes('stream-json')));
    assert.equal(entries.some((entry) => entry.args.includes('--print')), false);
    assert.equal(entries.some((entry) => entry.args.includes('app-server')), false);
    const run = entries.find((entry) => entry.args.includes('stream-json'));
    const claudeSettingsJson = path.join(run.cwd, 'runtime-hooks', 'claude-code', 'settings.json');
    const claudeHooksDir = path.join(run.cwd, 'runtime-hooks', 'claude-code', 'hooks');
    assert.deepEqual(JSON.parse(await readFile(claudeSettingsJson, 'utf8')), { hooks: {} });
    assert.equal((await lstat(claudeHooksDir)).isDirectory(), true);
    assert.equal(await realpath(path.join(run.cwd, '.claude', 'settings.json')), await realpath(claudeSettingsJson));
    assert.equal(await realpath(path.join(run.cwd, '.claude', 'hooks')), await realpath(claudeHooksDir));
    const workspaceSkillsRoot = path.join(run.cwd, 'skills');
    const workspaceSkillsStat = await lstat(workspaceSkillsRoot);
    assert.equal(workspaceSkillsStat.isDirectory(), true);
    assert.equal(workspaceSkillsStat.isSymbolicLink(), false);
    const localSkillRoot = path.join(workspaceSkillsRoot, 'claude-route-coach');
    await mkdir(localSkillRoot, { recursive: true });
    await writeFile(path.join(localSkillRoot, 'SKILL.md'), [
      '---',
      'name: claude-route-coach',
      'description: Agent-local skill for a Claude runtime agent.',
      '---',
      '',
      '# Claude Route Coach',
    ].join('\n'));
    relay.send({ type: 'agent:skills:list', commandId: 'claude_skills_test', agentId: 'agt_claude_remote' });
    const skillResult = await waitFor(() => relay.messages.find((item) => item.type === 'agent:skills:list_result' && item.commandId === 'claude_skills_test'));
    assert.ok(skillResult.skills.workspace.some((skill) => skill.name === 'claude-route-coach'));
    assert.equal(
      skillResult.skills.workspace.find((skill) => skill.name === 'claude-route-coach')?.path,
      'workspace/skills/claude-route-coach/SKILL.md',
    );
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('npm daemon finalizes streamed Claude Code text when the runner exits with an error', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-claude-error-'));
  const fakeClaude = path.join(tmp, 'claude-fake.js');
  await writeFile(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.150 (Claude Code)');
  process.exit(0);
}
if (args.includes('--output-format') && args.includes('stream-json')) {
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] }, error: 'billing_error' }));
  console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low', usage: { input_tokens: 0, output_tokens: 0 } }));
  process.exit(1);
}
process.exit(2);
`);
  await chmod(fakeClaude, 0o755);
  const relay = await startRelay({
    agent: {
      id: 'agt_claude_error',
      name: 'Remote Claude Error',
      runtime: 'claude-code',
    },
  });
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-claude-error-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      CODEX_PATH: '/bin/false',
      CLAUDE_PATH: fakeClaude,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const delta = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message_delta'));
    assert.equal(delta.agentId, 'agt_claude_error');
    assert.equal(delta.payload.body, 'Credit balance is too low');
    const message = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message'));
    assert.equal(message.agentId, 'agt_claude_error');
    assert.equal(message.payload.body, 'Credit balance is too low');
    assert.ok(relay.messages.some((item) => item.type === 'agent:error' && item.agentId === 'agt_claude_error'));
    assert.ok(relay.messages.some((item) => item.type === 'agent:status' && item.agentId === 'agt_claude_error' && item.status === 'error'));
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
