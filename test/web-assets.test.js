import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers/magclaw-flow.js';

test('web asset build emits hashed bundled assets with precompressed variants', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-web-assets-'));
  const publicDir = path.join(tmp, 'public');
  try {
    await mkdir(publicDir, { recursive: true });
    await cp(path.join(ROOT, 'public', 'app'), path.join(publicDir, 'app'), { recursive: true });
    await cp(path.join(ROOT, 'public', 'styles'), path.join(publicDir, 'styles'), { recursive: true });
    await cp(path.join(ROOT, 'public', 'app.js'), path.join(publicDir, 'app.js'));
    await cp(path.join(ROOT, 'public', 'styles.css'), path.join(publicDir, 'styles.css'));
    await cp(path.join(ROOT, 'public', 'fanout-toast.js'), path.join(publicDir, 'fanout-toast.js'));

    const result = spawnSync(process.execPath, ['scripts/build-web-assets.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MAGCLAW_PUBLIC_DIR: publicDir,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const manifestPath = path.join(publicDir, '.magclaw-assets', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.match(manifest.assets.script, /^\/\.magclaw-assets\/app-[a-f0-9]{12}\.js$/);
    assert.match(manifest.assets.style, /^\/\.magclaw-assets\/style-[a-f0-9]{12}\.css$/);
    assert.equal(manifest.source.scripts.includes('/app/render-mobile.js'), true);
    assert.equal(manifest.source.styles.includes('/styles/part-mobile.css'), true);

    const scriptPath = path.join(publicDir, manifest.assets.script.slice(1));
    const stylePath = path.join(publicDir, manifest.assets.style.slice(1));
    const scriptStat = await stat(scriptPath);
    const scriptBrStat = await stat(`${scriptPath}.br`);
    await stat(`${scriptPath}.gz`);
    const styleStat = await stat(stylePath);
    const styleBrStat = await stat(`${stylePath}.br`);
    await stat(`${stylePath}.gz`);

    assert.ok(scriptStat.size < 800 * 1024, `script bundle too large: ${scriptStat.size}`);
    assert.ok(scriptBrStat.size < 180 * 1024, `brotli script bundle too large: ${scriptBrStat.size}`);
    assert.ok(styleStat.size < 300 * 1024, `style bundle too large: ${styleStat.size}`);
    assert.ok(styleBrStat.size < 70 * 1024, `brotli style bundle too large: ${styleBrStat.size}`);

    const check = spawnSync(process.execPath, ['--check', scriptPath], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const bundle = await readFile(scriptPath, 'utf8');
    assert.doesNotMatch(bundle, /await loadAppScript/);
    assert.match(bundle, /globalThis\.renderFanoutDecisionToastsHtml = renderFanoutDecisionToasts/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
