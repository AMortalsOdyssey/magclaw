#!/usr/bin/env node
import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.resolve(process.env.MAGCLAW_PUBLIC_DIR || path.join(ROOT, 'public'));
const OUT_DIR = path.join(PUBLIC_DIR, '.magclaw-assets');
const HASH_LENGTH = 12;

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, HASH_LENGTH);
}

async function readPublicFile(publicPath) {
  const normalized = String(publicPath || '').replace(/^\/+/, '');
  return readFile(path.join(PUBLIC_DIR, normalized), 'utf8');
}

function extractQuotedPaths(source, prefixPattern) {
  const paths = [];
  for (const match of source.matchAll(prefixPattern)) {
    if (match[1]) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function extractAppScripts(appSource) {
  const appScriptsMatch = appSource.match(/const\s+appScripts\s*=\s*\[([\s\S]*?)\];/);
  if (!appScriptsMatch) {
    throw new Error('Unable to find appScripts in public/app.js');
  }
  const scripts = extractQuotedPaths(appScriptsMatch[1], /['"]([^'"]+\.js)['"]/g)
    .filter((item) => item.startsWith('/app/'));
  if (!scripts.length) throw new Error('No frontend chunks found in public/app.js');
  return scripts;
}

function extractStyleImports(styleSource) {
  const imports = [];
  for (const match of styleSource.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g)) {
    const href = match[1];
    if (!href) continue;
    const normalized = href.startsWith('.')
      ? path.posix.normalize(path.posix.join('/', href))
      : href;
    imports.push(normalized);
  }
  if (!imports.length) throw new Error('No stylesheet imports found in public/styles.css');
  return imports;
}

function transformFanoutModule(source) {
  return `${source.replace(/\bexport\s+function\b/g, 'function')}

globalThis.buildFanoutDecisionCards = buildFanoutDecisionCards;
globalThis.renderFanoutDecisionToastsHtml = renderFanoutDecisionToasts;
`;
}

function stripBundledJsLineComments(source) {
  const lines = String(source || '').split('\n');
  const output = [];
  let state = 'normal';

  const advanceState = (line, currentState) => {
    let nextState = currentState;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (nextState === 'block') {
        if (char === '*' && next === '/') {
          nextState = 'normal';
          index += 1;
        }
        continue;
      }
      if (nextState === 'single' || nextState === 'double' || nextState === 'template') {
        const quote = nextState === 'single' ? "'" : nextState === 'double' ? '"' : '`';
        if (char === '\\') {
          index += 1;
          continue;
        }
        if (char === quote) nextState = 'normal';
        continue;
      }
      if (char === '/' && next === '/') break;
      if (char === '/' && next === '*') {
        nextState = 'block';
        index += 1;
        continue;
      }
      if (char === "'") nextState = 'single';
      if (char === '"') nextState = 'double';
      if (char === '`') nextState = 'template';
    }
    return nextState;
  };

  for (const line of lines) {
    if (state === 'normal' && (line.trim() === '' || line.trimStart().startsWith('//'))) continue;
    const nextState = advanceState(line, state);
    output.push(state === 'normal' && nextState === 'normal' ? line.trim() : line);
    state = nextState;
  }

  return output.join('\n');
}

async function writeAsset(name, content) {
  const fileName = `${name}-${hashContent(content)}.${name === 'app' ? 'js' : 'css'}`;
  const diskPath = path.join(OUT_DIR, fileName);
  const gzip = gzipSync(content, { level: zlibConstants.Z_BEST_COMPRESSION });
  const brotli = brotliCompressSync(content, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
    },
  });
  await writeFile(diskPath, content);
  await writeFile(`${diskPath}.gz`, gzip);
  await writeFile(`${diskPath}.br`, brotli);
  return {
    href: `/.magclaw-assets/${fileName}`,
    sizes: {
      raw: Buffer.byteLength(content),
      gzip: gzip.length,
      brotli: brotli.length,
    },
  };
}

async function minifyScriptBundle(content) {
  const result = await transform(content, {
    loader: 'js',
    minify: true,
    target: 'es2020',
    legalComments: 'none',
  });
  return result.code;
}

async function minifyStyleBundle(content) {
  const result = await transform(content, {
    loader: 'css',
    minify: true,
    target: 'es2020',
    legalComments: 'none',
  });
  return result.code;
}

async function build() {
  const appSource = await readPublicFile('/app.js');
  const appScripts = extractAppScripts(appSource);
  const fanoutSource = await readPublicFile('/fanout-toast.js');
  const scriptParts = [
    `(function bootMagClawBundle() {`,
    stripBundledJsLineComments(transformFanoutModule(fanoutSource)),
  ];
  for (const script of appScripts) {
    scriptParts.push(`\n${stripBundledJsLineComments(await readPublicFile(script))}`);
  }
  scriptParts.push(`\n})();\n`);
  const scriptBundle = await minifyScriptBundle(scriptParts.join('\n'));

  const stylesSource = await readPublicFile('/styles.css');
  const styleImports = extractStyleImports(stylesSource);
  const extraStyles = ['/app/release-settings.css'];
  const styleParts = [
    `/* Generated by scripts/build-web-assets.mjs. */`,
  ];
  for (const stylePath of [...styleImports, ...extraStyles]) {
    styleParts.push(`\n/* ${stylePath} */\n${await readPublicFile(stylePath)}`);
  }
  const styleBundle = await minifyStyleBundle(styleParts.join('\n'));

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const scriptAsset = await writeAsset('app', scriptBundle);
  const styleAsset = await writeAsset('style', styleBundle);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    assets: {
      script: scriptAsset.href,
      style: styleAsset.href,
    },
    sizes: {
      script: scriptAsset.sizes,
      style: styleAsset.sizes,
    },
    source: {
      scripts: ['/fanout-toast.js', ...appScripts],
      styles: styleImports,
      extraStyles,
    },
  };
  await writeFile(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built MagClaw web assets: ${scriptAsset.href}, ${styleAsset.href}`);
}

build().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
