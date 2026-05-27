import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleProjectApi } from '../server/api/project-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
  };
}

function makeStreamResponse() {
  const res = new Writable({
    write(chunk, _encoding, callback) {
      res.chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = null;
  res.data = null;
  res.error = null;
  res.headers = null;
  res.chunks = [];
  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.body = () => Buffer.concat(res.chunks);
  return res;
}

function routeDeps(overrides = {}) {
  const persistCalls = [];
  const state = {
    settings: { defaultWorkspace: '/tmp' },
    projects: [{ id: 'proj_1', name: 'Project One', path: '/tmp/project-one' }],
    attachments: [],
  };
  return {
    addProjectFolder: async () => ({ created: true }),
    addSystemEvent: () => {},
    broadcastState: () => {},
    decodePathSegment: decodeURIComponent,
    defaultWorkspace: '/tmp',
    findProject: (id) => state.projects.find((project) => project.id === id),
    getState: () => state,
    listProjectTree: async () => ({ entries: [] }),
    maxAttachmentUploads: 2,
    currentActor: () => null,
    persistState: async (options) => {
      persistCalls.push(options || {});
    },
    pickFolderPath: async () => '',
    readJson: async () => ({}),
    readProjectFilePreview: async () => ({ file: { path: 'README.md' } }),
    saveAttachmentBuffer: async ({ name, type, buffer, source, extra }) => ({
      id: 'att_1',
      name,
      type,
      bytes: buffer.length,
      source,
      path: '/tmp/upload',
      storageMode: 'pvc',
      storageKey: 'attachments/local/att_1-note.txt',
      serverId: 'local',
      ...extra,
    }),
    searchProjectItems: async () => [],
    selectedDefaultSpaceId: () => 'chan_all',
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    persistCalls,
    state,
    ...overrides,
  };
}

test('project route group ignores unrelated API paths', async () => {
  const res = makeResponse();
  const handled = await handleProjectApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/state'),
    routeDeps(),
  );
  assert.equal(handled, false);
});

test('project route group uploads attachments through injected storage', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      files: [{
        name: 'note.txt',
        dataUrl: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
        source: 'clipboard',
      }],
    }),
  });
  const res = makeResponse();
  const handled = await handleProjectApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/attachments'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.attachments.length, 1);
  assert.equal(deps.state.attachments[0].source, 'clipboard');
  assert.equal(deps.state.attachments[0].storageMode, 'pvc');
  assert.equal(deps.state.attachments[0].storageKey, 'attachments/local/att_1-note.txt');
  assert.equal(deps.state.attachments[0].serverId, 'local');
});

test('project route group stores uploads in the authenticated workspace', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      member: {
        workspaceId: 'wsp_current',
        humanId: 'hum_owner',
      },
    }),
    readJson: async () => ({
      files: [{
        name: 'note.txt',
        dataUrl: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
      }],
    }),
  });
  const res = makeResponse();

  await handleProjectApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/attachments'),
    deps,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.attachments[0].workspaceId, 'wsp_current');
  assert.equal(deps.state.attachments[0].serverId, 'wsp_current');
  assert.equal(deps.state.attachments[0].createdBy, 'hum_owner');
  assert.deepEqual(deps.persistCalls, [{ workspaceId: 'wsp_current', reason: 'attachments_added' }]);
});

test('project route group serves cloud attachments restored with storage keys', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-attachment-route-'));
  try {
    await mkdir(path.join(tmp, '2026', '05'), { recursive: true });
    await writeFile(path.join(tmp, '2026', '05', 'att_1-note.png'), Buffer.from('png-data'));
    const deps = routeDeps({
      attachmentStorageDir: tmp,
    });
    deps.state.attachments.push({
      id: 'att_1',
      name: 'note.png',
      type: 'image/png',
      bytes: 8,
      storageMode: 'pvc',
      storageKey: '2026/05/att_1-note.png',
    });
    const res = makeStreamResponse();

    const handled = await handleProjectApi(
      { method: 'GET' },
      res,
      new URL('http://local/api/attachments/att_1/note.png'),
      deps,
    );
    await new Promise((resolve) => res.on('finish', resolve));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.body().toString('utf8'), 'png-data');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Local project folder linking is temporarily hidden until cloud-safe access exists.
test.skip('project route group keeps project references local', async () => {
  const res = makeResponse();
  const handled = await handleProjectApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/attachments/reference'),
    routeDeps(),
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 410);
});
