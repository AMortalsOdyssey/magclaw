import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemServices } from '../server/system-services.js';

function makeServices(configureState = null, options = {}) {
  const createdAt = '2026-05-18T00:00:00.000Z';
  const state = {
    connection: { workspaceId: 'local' },
    settings: {},
    channels: [
      { id: 'chan_all', workspaceId: 'local', name: 'all', memberIds: ['hum_1'], createdAt, updatedAt: createdAt },
      { id: 'chan_member', workspaceId: 'local', name: 'member-room', memberIds: ['hum_1'], createdAt, updatedAt: createdAt },
      { id: 'chan_outside', workspaceId: 'local', name: 'outside-room', memberIds: ['hum_other'], createdAt, updatedAt: createdAt },
    ],
    dms: [{ id: 'dm_1', workspaceId: 'local', participantIds: ['hum_1', 'agt_1'], createdAt, updatedAt: createdAt }],
    messages: [
      { id: 'msg_channel', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_all', body: 'channel hello', createdAt, updatedAt: createdAt },
      { id: 'msg_dm', workspaceId: 'local', spaceType: 'dm', spaceId: 'dm_1', body: 'dm hello', createdAt, updatedAt: createdAt },
    ],
    replies: [],
    tasks: [
      { id: 'task_member_done', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_member', title: 'Done for my channel', status: 'done', createdAt, updatedAt: createdAt },
      { id: 'task_outside_done', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_outside', title: 'Done outside', status: 'done', createdAt, updatedAt: createdAt },
    ],
    runs: [],
    workItems: [],
    events: [],
    routeEvents: [],
    systemNotifications: [],
    attachments: [],
  };
  if (typeof configureState === 'function') configureState(state);
  return createSystemServices({
    addSystemEvent: () => {},
    broadcastState: () => {},
    fanoutApiConfigured: () => false,
    getState: () => state,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    makeId: (prefix) => `${prefix}_test`,
    now: () => createdAt,
    persistState: async () => {},
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { workspaceId: 'local', humanId: 'hum_1', role: 'admin' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
    }),
    projectsForSpace: () => [],
    runningProcesses: new Map(),
    selectedDefaultSpaceId: (spaceType) => (spaceType === 'dm' ? 'dm_1' : 'chan_all'),
    DATA_DIR: '/tmp',
    PORT: 6543,
    ROOT: process.cwd(),
    ...options,
  });
}

test('bootstrap state reads active DM options from event stream requests', () => {
  const services = makeServices();
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);

  assert.equal(snapshot.bootstrap.spaceType, 'dm');
  assert.equal(snapshot.bootstrap.spaceId, 'dm_1');
  assert.equal(snapshot.bootstrap.messageLimit, 20);
  assert.equal(snapshot.bootstrap.threadRootLimit, 40);
  assert.deepEqual(snapshot.messages.map((message) => message.body), ['dm hello']);
});

test('bootstrap state includes visible off-space unread agent messages for rail refresh', () => {
  const unreadAt = '2026-05-18T00:05:00.000Z';
  const readAt = '2026-05-18T00:06:00.000Z';
  const services = makeServices((state) => {
    state.dms.push(
      { id: 'dm_other', workspaceId: 'local', participantIds: ['hum_1', 'agt_2'], createdAt: unreadAt, updatedAt: unreadAt },
      { id: 'dm_hidden', workspaceId: 'local', participantIds: ['hum_other', 'agt_3'], createdAt: unreadAt, updatedAt: unreadAt },
    );
    state.messages.push(
      {
        id: 'msg_unread_other_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_other',
        authorType: 'agent',
        authorId: 'agt_2',
        body: 'new unread off-space DM',
        readBy: [],
        createdAt: unreadAt,
        updatedAt: unreadAt,
      },
      {
        id: 'msg_read_other_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_other',
        authorType: 'agent',
        authorId: 'agt_2',
        body: 'old read off-space DM',
        readBy: ['hum_1'],
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: 'msg_hidden_unread_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_hidden',
        authorType: 'agent',
        authorId: 'agt_3',
        body: 'hidden unread DM',
        readBy: [],
        createdAt: unreadAt,
        updatedAt: unreadAt,
      },
    );
  });
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const messageIds = snapshot.messages.map((message) => message.id);

  assert.ok(messageIds.includes('msg_unread_other_dm'));
  assert.equal(messageIds.includes('msg_read_other_dm'), false);
  assert.equal(messageIds.includes('msg_hidden_unread_dm'), false);
});

test('bootstrap state bounds off-space unread hydration to newest records', () => {
  const services = makeServices((state) => {
    state.dms.push({
      id: 'dm_bulk',
      workspaceId: 'local',
      participantIds: ['hum_1', 'agt_bulk'],
      createdAt: '2026-05-18T00:10:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
    });
    const start = Date.parse('2026-05-18T00:10:00.000Z');
    for (let index = 0; index < 300; index += 1) {
      const timestamp = new Date(start + index * 1000).toISOString();
      state.messages.push({
        id: `msg_bulk_${String(index).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_bulk',
        authorType: 'agent',
        authorId: 'agt_bulk',
        body: `bulk unread ${index} ${'x'.repeat(4096)}`,
        readBy: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const messageIds = snapshot.messages.map((message) => message.id);
  const bulkIds = messageIds.filter((id) => id.startsWith('msg_bulk_'));

  assert.equal(bulkIds.length, 80);
  assert.ok(messageIds.includes('msg_bulk_299'));
  assert.ok(messageIds.includes('msg_bulk_220'));
  assert.equal(messageIds.includes('msg_bulk_219'), false);
  assert.equal(messageIds.includes('msg_bulk_000'), false);
  assert.deepEqual(snapshot.bootstrap.unreadHydration, {
    limit: 80,
    included: 80,
    truncated: true,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 500_000);
});

test('bootstrap state limits selected thread replies to the loaded page', () => {
  const services = makeServices((state) => {
    state.messages[0].replyCount = 101;
    state.replies = Array.from({ length: 101 }, (_, index) => {
      const position = index + 1;
      const replyTime = new Date(Date.parse(state.messages[0].createdAt) + position * 60_000).toISOString();
      return {
        id: `rep_${String(position).padStart(3, '0')}`,
        workspaceId: 'local',
        parentMessageId: 'msg_channel',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: `reply ${position}`,
        createdAt: replyTime,
        updatedAt: replyTime,
      };
    });
  });
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all&threadMessageId=msg_channel&messageLimit=80',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const replies = snapshot.replies.filter((reply) => reply.parentMessageId === 'msg_channel');

  assert.equal(replies.length, 80);
  assert.equal(replies[0].id, 'rep_022');
  assert.equal(replies.at(-1).id, 'rep_101');
  assert.equal(snapshot.bootstrap.threadReplies.hasMore, true);
  assert.equal(snapshot.bootstrap.threadReplies.nextBeforeId, 'rep_022');
  assert.equal(snapshot.replies.some((reply) => reply.id === 'rep_001'), false);
});

test('bootstrap state windows task hydration and keeps referenced task records', () => {
  const baseTime = Date.parse('2026-05-18T00:00:00.000Z');
  const services = makeServices((state) => {
    state.tasks = Array.from({ length: 120 }, (_, index) => {
      const position = index + 1;
      const updatedAt = new Date(baseTime + position * 60_000).toISOString();
      return {
        id: `task_${String(position).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        title: `Task ${position}`,
        status: 'todo',
        createdAt: updatedAt,
        updatedAt,
      };
    });
    state.messages.push({
      id: 'msg_old_task_reference',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      taskId: 'task_001',
      body: 'old referenced task',
      createdAt: new Date(baseTime + 130 * 60_000).toISOString(),
      updatedAt: new Date(baseTime + 130 * 60_000).toISOString(),
    });
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&taskLimit=40',
    headers: {},
  });
  const taskIds = snapshot.tasks.map((task) => task.id);

  assert.equal(snapshot.bootstrap.tasks.limit, 40);
  assert.equal(snapshot.bootstrap.tasks.openCount, 120);
  assert.equal(snapshot.bootstrap.tasks.space.hasMore, true);
  assert.equal(snapshot.bootstrap.tasks.space.nextBeforeId, 'task_081');
  assert.equal(snapshot.bootstrap.tasks.global.hasMore, true);
  assert.equal(taskIds.includes('task_120'), true);
  assert.equal(taskIds.includes('task_081'), true);
  assert.equal(taskIds.includes('task_080'), false);
  assert.equal(taskIds.includes('task_001'), true);
  assert.ok(snapshot.tasks.length <= 41);
});

test('bootstrap state formats Team Sharing interaction replies as paired questions and answers', () => {
  const services = makeServices((state) => {
    state.messages[0].replyCount = 1;
    state.replies.push({
      id: 'rep_team_sharing_interaction',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: [
        'Agent 提问：链接范围：这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？',
        'Agent 提问：机器绑定：Team Sharing CLI token 的机器绑定做到哪种强度？',
        '用户回答：机器绑定：软绑定 (Recommended)',
        '用户回答：链接范围：内容+工作区',
      ].join('\n'),
      metadata: {
        teamSharing: {
          presentation: {
            mode: 'interaction',
            source: 'codex',
            interaction: {
              questions: [
                {
                  id: 'links',
                  header: '链接范围',
                  question: '这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？',
                  options: [{ label: '内容+工作区', description: '保护会话内容与工作区入口。' }],
                },
                {
                  id: 'binding',
                  header: '机器绑定',
                  question: 'Team Sharing CLI token 的机器绑定做到哪种强度？',
                  options: [{ label: '软绑定 (Recommended)', description: '按设备信息提示风险，不硬拦正常使用。' }],
                },
              ],
              answers: [
                { id: 'binding', values: ['软绑定 (Recommended)'] },
                { id: 'links', values: ['内容+工作区'] },
              ],
            },
          },
        },
      },
      createdAt: '2026-05-18T00:01:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
    });
  });
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all&threadMessageId=msg_channel&messageLimit=80',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const reply = snapshot.replies.find((item) => item.id === 'rep_team_sharing_interaction');

  assert.ok(reply);
  assert.match(reply.body, /\*\*Agent 提问：链接范围\*\*：这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？/);
  assert.match(reply.body, /\*\*用户回答：\*\* 内容\+工作区 `（保护会话内容与工作区入口。）`/);
  assert.ok(reply.body.indexOf('内容+工作区') < reply.body.indexOf('**Agent 提问：机器绑定**'));
  assert.ok(reply.body.indexOf('**Agent 提问：机器绑定**') < reply.body.indexOf('软绑定 (Recommended)'));
  assert.doesNotMatch(reply.body, /^Agent 提问：/m);
});

test('bootstrap state includes terminal task updates for the current member channels', () => {
  const services = makeServices();
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);

  assert.equal(snapshot.tasks.some((task) => task.id === 'task_member_done'), true);
  assert.equal(snapshot.tasks.some((task) => task.id === 'task_outside_done'), false);
});

test('public state exposes configured public URL for share exports', () => {
  const previous = process.env.MAGCLAW_PUBLIC_URL;
  process.env.MAGCLAW_PUBLIC_URL = 'https://magclaw.multiego.me/';
  try {
    const services = makeServices();
    const snapshot = services.publicState();

    assert.equal(snapshot.connection.publicUrl, 'https://magclaw.multiego.me');
  } finally {
    if (previous === undefined) delete process.env.MAGCLAW_PUBLIC_URL;
    else process.env.MAGCLAW_PUBLIC_URL = previous;
  }
});

test('runtime snapshot exposes independent NPM latest versions for daemon and computer', () => {
  const services = makeServices(null, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => {
        if (packageName === '@magclaw/daemon') return '0.1.30';
        if (packageName === '@magclaw/computer') return '0.1.31';
        return fallback;
      },
      refreshAll: () => {},
    },
  });

  const runtime = services.runtimeSnapshot();

  assert.equal(runtime.daemonPackageName, '@magclaw/daemon');
  assert.equal(runtime.daemonLatestVersion, '0.1.30');
  assert.equal(runtime.computerPackageName, '@magclaw/computer');
  assert.equal(runtime.computerLatestVersion, '0.1.31');
});

test('runtime snapshot ignores legacy state package versions and uses NPM latest', () => {
  const services = makeServices((state) => {
    state.packageVersions = {
      '@magclaw/daemon': { latest: '0.1.40', source: 'db' },
      '@magclaw/computer': { version: '0.1.41', source: 'db' },
    };
  }, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => {
        if (packageName === '@magclaw/daemon') return '0.1.30';
        if (packageName === '@magclaw/computer') return '0.1.31';
        return fallback;
      },
      refreshAll: () => {},
    },
  });

  const runtime = services.runtimeSnapshot();

  assert.equal(runtime.daemonLatestVersion, '0.1.30');
  assert.equal(runtime.computerLatestVersion, '0.1.31');
});

test('package version snapshot refreshes NPM once per 10 minute web cache window', async () => {
  let nowMs = 1_000;
  const calls = [];
  let refreshCount = 0;
  const services = makeServices(null, {
    nowMs: () => nowMs,
    npmPackageVersions: {
      latest: (packageName) => {
        calls.push(['latest', packageName, refreshCount]);
        if (packageName === '@magclaw/daemon') return `0.1.${49 + refreshCount}`;
        if (packageName === '@magclaw/computer') return `0.1.${50 + refreshCount}`;
        return '';
      },
      maybeRefreshAll: () => {
        refreshCount += 1;
        calls.push(['refresh', refreshCount]);
      },
    },
  });

  const first = await services.packageVersionSnapshot();
  const second = await services.packageVersionSnapshot({ serverSlug: 'other-server' });
  nowMs += 9 * 60_000;
  const third = await services.packageVersionSnapshot();
  nowMs += 60_000;
  const fourth = await services.packageVersionSnapshot();

  assert.equal(first.packages['@magclaw/daemon'].latest, '0.1.50');
  assert.equal(second.packages['@magclaw/computer'].latest, '0.1.51');
  assert.equal(third.cacheTtlMs, 10 * 60_000);
  assert.equal(refreshCount, 2);
  assert.equal(calls.filter((call) => call[0] === 'refresh').length, 2);
  assert.equal(fourth.packages['@magclaw/daemon'].source, 'npm-cache');
  assert.equal(fourth.packages['@magclaw/daemon'].latest, '0.1.51');
});

test('package version polling refreshes NPM every 10 minutes without broadcasting updates', async () => {
  let daemonLatest = '';
  let computerLatest = '';
  let refreshCount = 0;
  const broadcasts = [];
  const timers = [];
  const cleared = [];
  const services = makeServices(null, {
    broadcastState: () => broadcasts.push('state'),
    packageVersionPollIntervalMs: 10 * 60_000,
    setIntervalFn: (callback, intervalMs) => {
      const timer = {
        callback,
        intervalMs,
        unrefed: false,
        unref() {
          this.unrefed = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
    npmPackageVersions: {
      latest: (packageName) => {
        if (packageName === '@magclaw/daemon') return daemonLatest;
        if (packageName === '@magclaw/computer') return computerLatest;
        return '';
      },
      maybeRefreshAll: () => {
        refreshCount += 1;
        daemonLatest = `0.1.${40 + refreshCount}`;
        computerLatest = `0.1.${50 + refreshCount}`;
      },
    },
  });

  const timer = services.startPackageVersionPolling();
  await new Promise((resolve) => setImmediate(resolve));
  await timer.callback();
  services.stopPackageVersionPolling();

  assert.equal(timers.length, 1);
  assert.equal(timer.intervalMs, 10 * 60_000);
  assert.equal(timer.unrefed, true);
  assert.equal(refreshCount, 2);
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(cleared, [timer]);
});

test('package version snapshot falls back to local versions when NPM is unavailable', async () => {
  const services = makeServices((state) => {
    state.packageVersions = {
      '@magclaw/daemon': { latest: '0.1.60', source: 'state' },
    };
  }, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => (packageName === '@magclaw/computer' ? '0.1.61' : fallback),
      refreshAll: () => {},
    },
  });

  const snapshot = await services.packageVersionSnapshot();

  assert.notEqual(snapshot.packages['@magclaw/daemon'].latest, '0.1.60');
  assert.equal(snapshot.packages['@magclaw/daemon'].source, 'local');
  assert.equal(snapshot.packages['@magclaw/computer'].latest, '0.1.61');
  assert.equal(snapshot.packages['@magclaw/computer'].source, 'npm-cache');
});

test('bootstrap state omits large internal server indexes from public payloads', () => {
  const services = makeServices((state) => {
    state.teamSharing = {
      sessions: { sess_big: { title: 'Large internal session' } },
      events: { sess_big: [{ eventId: 'evt_big', cleanText: 'internal raw transcript' }] },
      vectorDocuments: [{ id: 'vec_big', text: 'internal vector text'.repeat(1000) }],
    };
    state.agentRuntimeSessions = Array.from({ length: 20 }, (_, index) => ({
      id: `runtime_${index}`,
      rawLog: 'internal runtime log'.repeat(500),
    }));
    state.conversationGrants = [{ tokenHash: 'internal-token-hash' }];
    state.packageVersions = { '@magclaw/daemon': { latest: '9.9.9' } };
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });

  assert.equal(snapshot.teamSharing, undefined);
  assert.equal(snapshot.agentRuntimeSessions, undefined);
  assert.equal(snapshot.conversationGrants, undefined);
  assert.equal(snapshot.packageVersions, undefined);
  assert.equal(snapshot.messages.some((message) => message.id === 'msg_channel'), true);
});

test('bootstrap state projects record metadata to frontend display fields only', () => {
  const services = makeServices((state) => {
    state.messages.push({
      id: 'msg_feishu_public',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'system',
      authorId: 'system',
      body: 'Imported from Feishu\n\nContext:\n- 张三: 需要跟进',
      metadata: {
        systemKind: 'external_import',
        origin: {
          provider: 'feishu',
          traceId: 'trace_public',
          chatId: 'oc_chat',
          chatName: '产品群',
          chatType: 'group',
          senderName: '张三',
          senderAvatar: 'avatar.png',
          senderOpenId: 'ou_public',
          internalRawPayload: 'x'.repeat(5000),
        },
        externalImport: {
          provider: 'feishu',
          syncEnabled: true,
          rawRequest: 'x'.repeat(5000),
        },
        feishu: {
          attachmentCount: 2,
          internalEvent: 'x'.repeat(5000),
          contextRecords: [{
            id: 'ctx_1',
            senderName: '李四',
            text: '上下文消息',
            createdAt: '2026-05-18T00:02:00.000Z',
            rawEvent: 'x'.repeat(5000),
          }],
        },
      },
      createdAt: '2026-05-18T00:02:00.000Z',
      updatedAt: '2026-05-18T00:02:00.000Z',
    });
    state.replies.push({
      id: 'rep_team_public',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'team_sharing_codex',
      body: 'Team Sharing display body',
      metadata: {
        systemKind: 'team_sharing_event',
        teamSharing: {
          runtime: 'codex',
          sessionId: 'sess_public',
          eventId: 'evt_internal',
          sourceAnchor: 'raw/source#123',
          ordinal: 99,
          uploader: {
            id: 'hum_1',
            name: 'Owner',
            email: 'owner@example.com',
            avatar: 'owner.png',
            privateToken: 'secret',
          },
          presentation: {
            mode: 'plan',
            interaction: { questions: [{ question: 'internal' }] },
          },
          contentSegments: [
            { type: 'body', text: 'Team Sharing display body' },
            { type: 'quote', label: '选取片段', text: '保留引用段' },
          ],
        },
      },
      createdAt: '2026-05-18T00:03:00.000Z',
      updatedAt: '2026-05-18T00:03:00.000Z',
    });
    state.tasks.push({
      id: 'task_internal_metadata',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      title: 'Task with internal startup metadata',
      status: 'todo',
      metadata: {
        systemKind: 'external_import',
        startupCollaboration: {
          status: 'running',
          deliveries: [{ agentId: 'agt_a', raw: 'x'.repeat(5000) }],
          fallbackReason: { raw: 'x'.repeat(5000) },
        },
        origin: { provider: 'feishu', raw: 'x'.repeat(5000) },
      },
      createdAt: '2026-05-18T00:04:00.000Z',
      updatedAt: '2026-05-18T00:04:00.000Z',
    });
    state.agents = [
      {
        id: 'agt_public',
        workspaceId: 'local',
        name: 'Public Agent',
        description: 'Shown in members',
        avatar: 'agent.png',
        runtime: 'codex',
        runtimeId: 'codex',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        computerId: 'cmp_local',
        status: 'working',
        statusUpdatedAt: '2026-05-18T00:04:30.000Z',
        activeWorkItemIds: ['wi_1'],
        envVars: [{ key: 'PUBLIC_MODE', value: 'on' }],
        createdAt: '2026-05-18T00:04:00.000Z',
        updatedAt: '2026-05-18T00:04:30.000Z',
        metadata: {
          promptCache: 'x'.repeat(5000),
          runtimeSession: { raw: 'x'.repeat(5000) },
        },
      },
    ];
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160',
    headers: {},
  });
  const message = snapshot.messages.find((item) => item.id === 'msg_feishu_public');
  const reply = snapshot.replies.find((item) => item.id === 'rep_team_public');
  const task = snapshot.tasks.find((item) => item.id === 'task_internal_metadata');
  const agent = snapshot.agents.find((item) => item.id === 'agt_public');

  assert.equal(message.metadata.systemKind, 'external_import');
  assert.equal(message.metadata.origin.senderName, '张三');
  assert.equal(message.metadata.origin.internalRawPayload, undefined);
  assert.equal(message.metadata.externalImport, undefined);
  assert.equal(message.metadata.feishu.attachmentCount, 2);
  assert.equal(message.metadata.feishu.contextRecords[0].text, '上下文消息');
  assert.equal(message.metadata.feishu.contextRecords[0].rawEvent, undefined);
  assert.equal(reply.body, 'Team Sharing display body');
  assert.equal(reply.metadata.teamSharing.sessionId, 'sess_public');
  assert.equal(reply.metadata.teamSharing.eventId, undefined);
  assert.equal(reply.metadata.teamSharing.sourceAnchor, undefined);
  assert.deepEqual(reply.metadata.teamSharing.presentation, { mode: 'plan' });
  assert.deepEqual(reply.metadata.teamSharing.contentSegments, [{ type: 'quote', label: '选取片段', text: '保留引用段' }]);
  assert.equal(reply.metadata.teamSharing.uploader.privateToken, undefined);
  assert.deepEqual(task.metadata, { systemKind: 'external_import' });
  assert.equal(agent.name, 'Public Agent');
  assert.equal(agent.model, 'gpt-test');
  assert.equal(agent.metadata, undefined);
});

test('bootstrap state compacts member directory churn fields without changing full public state', () => {
  const createdAt = '2026-05-18T00:04:00.000Z';
  const updatedAt = '2026-05-18T00:05:00.000Z';
  const services = makeServices((state) => {
    state.agents = [{
      id: 'agt_compact',
      workspaceId: 'local',
      name: 'Compact Agent',
      description: 'Still searchable',
      role: 'agent',
      status: 'working',
      runtime: 'codex',
      runtimeId: 'codex',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      activeWorkItemIds: ['wi_1'],
      statusUpdatedAt: updatedAt,
      heartbeatAt: updatedAt,
      createdAt,
      updatedAt,
    }];
    state.humans = [{
      id: 'hum_1',
      workspaceId: 'local',
      name: 'Owner',
      role: 'owner',
      status: 'online',
      lastSeenAt: updatedAt,
      presenceUpdatedAt: updatedAt,
      createdAt,
      updatedAt,
    }];
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { workspaceId: 'local', humanId: 'hum_1', role: 'admin' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [{
        id: 'mem_1',
        workspaceId: 'local',
        userId: 'usr_1',
        humanId: 'hum_1',
        role: 'owner',
        status: 'active',
        createdAt,
        updatedAt,
        user: { id: 'usr_1', email: 'owner@example.test' },
        human: {
          id: 'hum_1',
          workspaceId: 'local',
          name: 'Owner',
          role: 'owner',
          status: 'online',
          lastSeenAt: updatedAt,
          presenceUpdatedAt: updatedAt,
          createdAt,
          updatedAt,
        },
      }],
    }),
  });

  const full = services.publicState();
  const bootstrap = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });

  assert.equal(full.agents[0].workspaceId, 'local');
  assert.equal(full.agents[0].statusUpdatedAt, updatedAt);
  assert.equal(full.humans[0].lastSeenAt, updatedAt);

  assert.equal(bootstrap.agents[0].workspaceId, undefined);
  assert.equal(bootstrap.agents[0].role, undefined);
  assert.equal(bootstrap.agents[0].statusUpdatedAt, undefined);
  assert.equal(bootstrap.agents[0].heartbeatAt, undefined);
  assert.equal(bootstrap.agents[0].updatedAt, undefined);
  assert.equal(bootstrap.agents[0].description, 'Still searchable');
  assert.equal(bootstrap.agents[0].runtime, 'codex');
  assert.equal(bootstrap.agents[0].model, 'gpt-test');
  assert.equal(bootstrap.agents[0].createdAt, createdAt);

  assert.equal(bootstrap.humans[0].workspaceId, undefined);
  assert.equal(bootstrap.humans[0].lastSeenAt, undefined);
  assert.equal(bootstrap.humans[0].presenceUpdatedAt, undefined);
  assert.equal(bootstrap.humans[0].updatedAt, undefined);
  assert.equal(bootstrap.humans[0].role, 'owner');
  assert.equal(bootstrap.humans[0].createdAt, createdAt);
  assert.equal(bootstrap.cloud.members[0].human.workspaceId, undefined);
  assert.equal(bootstrap.cloud.members[0].human.lastSeenAt, undefined);
  assert.equal(bootstrap.cloud.members[0].human.createdAt, createdAt);
});

test('public state for signed-in non-members keeps empty collection fields stable', () => {
  const services = makeServices(null, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_pending' },
        currentMember: null,
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
    }),
  });

  const snapshot = services.publicState();

  for (const key of ['messages', 'replies', 'tasks', 'events', 'workItems', 'attachments', 'projects', 'runs']) {
    assert.deepEqual(snapshot[key], [], key);
  }
  assert.equal(snapshot.teamSharing, undefined);
});

test('public state includes minimal identities for visible external human mentions', () => {
  const services = makeServices((state) => {
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Owner', email: 'owner@example.com' },
      {
        id: 'hum_external',
        workspaceId: 'other',
        name: 'External Human',
        email: 'external@example.com',
        avatar: 'avatar-data',
      },
    ];
    state.messages.push({
      id: 'msg_external_mention',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'Talk to <@hum_external>',
      mentionedHumanIds: ['hum_external'],
      createdAt: '2026-05-18T00:01:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
    });
  });

  const snapshot = services.publicState();
  const external = snapshot.humans.find((human) => human.id === 'hum_external');

  assert.equal(Boolean(external), true);
  assert.equal(external.name, 'External Human');
  assert.equal(external.identityReference, true);
  assert.equal(external.avatar, 'avatar-data');
  assert.equal(external.email, undefined);
});
