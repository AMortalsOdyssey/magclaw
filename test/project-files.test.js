import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listProjectTree,
  projectFilePreviewKind,
  readProjectFilePreview,
  searchProject,
} from '../server/project-files.js';

async function withProject(files, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-project-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = path.join(root, relPath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    return await callback({ id: 'proj_test', name: 'Test Project', path: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('project file search is bounded, sorted, and skips excluded folders', async () => {
  await withProject({
    'src/app.js': 'console.log("hello");',
    'src/components/card.js': 'export const card = true;',
    'node_modules/pkg/index.js': 'ignored',
  }, async (project) => {
    const results = await searchProject(project, 'card');
    assert.equal(results[0].path, 'src/components/card.js');
    assert.equal(results.some((item) => item.path.includes('node_modules')), false);
  });
});

test('project tree and preview helpers return UI-ready records', async () => {
  await withProject({
    'docs/readme.md': '# Hello',
    'src/app.js': 'console.log("hello");',
    'image.bin': Buffer.from([0, 1, 2]),
  }, async (project) => {
    const tree = await listProjectTree(project);
    assert.deepEqual(tree.entries.map((entry) => entry.name), ['docs', 'src', 'image.bin']);

    const preview = await readProjectFilePreview(project, 'docs/readme.md');
    assert.equal(preview.file.previewKind, 'markdown');
    assert.equal(preview.file.content, '# Hello');
    assert.equal(projectFilePreviewKind('image.bin', Buffer.from([0, 1, 2])), 'binary');

    await assert.rejects(
      () => readProjectFilePreview(project, '../outside.md'),
      { status: 400 },
    );
  });
});
