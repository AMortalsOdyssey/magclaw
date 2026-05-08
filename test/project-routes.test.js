import test from 'node:test';
import assert from 'node:assert/strict';
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

function routeDeps(overrides = {}) {
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
    persistState: async () => {},
    pickFolderPath: async () => '',
    readJson: async () => ({}),
    readProjectFilePreview: async () => ({ file: { path: 'README.md' } }),
    saveAttachmentBuffer: async ({ name, type, buffer, source }) => ({
      id: 'att_1',
      name,
      type,
      bytes: buffer.length,
      source,
      path: '/tmp/upload',
      storageMode: 'pvc',
      storageKey: 'attachments/local/att_1-note.txt',
      serverId: 'local',
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

test('project route group keeps project references local', async () => {
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
