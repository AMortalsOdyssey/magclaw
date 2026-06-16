import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  alignKnowledgeDiscussion,
  askKnowledgeConsensus,
  canWriteKnowledgeContent,
  createKnowledgeChangeSession,
  ensureKnowledgeSpace,
  exportKnowledgeConsensusMarkdown,
  getKnowledgeDocument,
  importKnowledgeMarkdown,
  publicKnowledgeSpace,
} from '../knowledge-space.js';
import {
  applyTeamSharingFeedback,
  contextWindowForTeamSharingSession,
  normalizeTeamSharingSearchMode,
  normalizeTeamSharingSearchSort,
  rankTeamSharingCandidates,
  syncTeamSharingBatch,
} from '../team-sharing.js';
import { TEAM_SHARING_COMMON_LINK_ICONS } from '../team-sharing-link-icons.js';
import { ensureWorkspaceAllChannel } from '../workspace-defaults.js';
import { channelFeishuRouteKey, parseChannelImportPath } from '../integrations/feishu-connect/route-token.js';
import { attachmentPathWithinStorage, safeFileName } from '../path-utils.js';
import crypto from 'node:crypto';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value = '', max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function htmlEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function sourceAnchorEventId(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const hashIndex = text.lastIndexOf('#');
  if (hashIndex >= 0 && hashIndex < text.length - 1) return text.slice(hashIndex + 1);
  return text;
}

function sourceAnchorFromSearchParams(searchParams) {
  return sourceAnchorEventId(searchParams.get('anchorEventId') || searchParams.get('anchor') || '');
}

function contextPagePath(sessionId = '', options = {}) {
  const params = new URLSearchParams();
  const anchorEventId = String(options.anchorEventId || '').trim();
  if (anchorEventId) params.set('anchorEventId', anchorEventId);
  params.set('limit', String(options.limit || '21'));
  params.set('order', String(options.order || 'asc'));
  if (options.vectorDocumentId) params.set('vectorDocumentId', options.vectorDocumentId);
  if (options.queryId) params.set('queryId', options.queryId);
  if (options.sourceRef) params.set('sourceRef', options.sourceRef);
  const suffix = params.toString();
  return `/team-sharing/context/${encodeURIComponent(sessionId)}${suffix ? `?${suffix}` : ''}`;
}

function resultContextUrl(item, queryId = '') {
  if (String(item.sourceKind || '').trim() === 'share' || item.shareId) {
    return `/s/${encodeURIComponent(String(item.shareId || '').trim())}`;
  }
  const anchorEventId = String(item.rawEventId || '').trim() || sourceAnchorEventId(item.sourceRef);
  return contextPagePath(item.sessionId, {
    anchorEventId,
    vectorDocumentId: item.vectorDocumentId,
    queryId,
    sourceRef: item.sourceRef,
  });
}

function workspaceSlugForContext(state = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local') return '';
  const cloud = state.cloud || {};
  const workspaces = [
    ...asArray(cloud.workspaces),
    cloud.workspace,
  ].filter(Boolean);
  const workspace = workspaces.find((item) => (
    String(item?.id || '').trim() === cleanWorkspaceId
    || String(item?.workspaceId || '').trim() === cleanWorkspaceId
    || String(item?.slug || '').trim() === cleanWorkspaceId
  )) || null;
  return String(workspace?.slug || '').trim();
}

function absoluteContextPageUrl(req, state = {}, relativePath = '', workspaceId = '') {
  const cleanPath = String(relativePath || '').trim();
  if (!cleanPath) return '';
  if (/^https?:\/\//i.test(cleanPath)) return cleanPath;
  const slug = workspaceSlugForContext(state, workspaceId);
  const path = slug && cleanPath.startsWith('/team-sharing/context/')
    ? cleanPath.replace('/team-sharing/context/', `/s/${encodeURIComponent(slug)}/team-sharing/context/`)
    : cleanPath;
  return `${publicUrlFromRequest(req)}${path.startsWith('/') ? path : `/${path}`}`;
}

function resultContextWebUrl(req, state = {}, item = {}, queryId = '') {
  if (String(item.sourceKind || '').trim() === 'share' || item.shareId) {
    const shareId = String(item.shareId || '').trim();
    return shareId ? shareUrl(req, shareId) : '';
  }
  const session = state.teamSharing?.sessions?.[item.sessionId] || {};
  const workspaceId = String(item.workspaceId || session.workspaceId || '').trim();
  return absoluteContextPageUrl(req, state, resultContextUrl(item, queryId), workspaceId);
}

const SHARE_CONTENT_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);
const MAX_SHARE_CONTENT_LENGTH = 10 * 1024 * 1024;
const TEAM_SHARING_INLINE_ASSET_THRESHOLD_BYTES = 64 * 1024;
const TEAM_SHARING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MACHINE_FINGERPRINT_PATTERN = /^mfp_[a-f0-9]{64}$/;
const TEAM_SHARING_AUTH_THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const TEAM_SHARING_AUTH_START_LIMIT = 30;
const TEAM_SHARING_AUTH_APPROVE_LIMIT = 20;
const TEAM_SHARING_ACCESS_JOIN_LINK_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeShareContentType(value = '', content = '') {
  const explicit = String(value || '').trim().toLowerCase();
  if (SHARE_CONTENT_TYPES.has(explicit)) return explicit;
  const text = String(content || '').trim();
  if (/^```mermaid/i.test(text) || /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/i.test(text)) return 'mermaid';
  if (text.startsWith('<svg') && text.includes('</svg>')) return 'svg';
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text) || /<(body|head|style|script|div|section|article)\b/i.test(text)) return 'html';
  return 'markdown';
}

function ensureTeamSharingShares(teamSharingState = {}) {
  teamSharingState.shares = Array.isArray(teamSharingState.shares) ? teamSharingState.shares : [];
  return teamSharingState.shares;
}

function ensureTeamSharingAssets(teamSharingState = {}) {
  teamSharingState.assets = Array.isArray(teamSharingState.assets) ? teamSharingState.assets : [];
  return teamSharingState.assets;
}

function ensureTeamSharingShareContents(teamSharingState = {}) {
  teamSharingState.shareContents = Array.isArray(teamSharingState.shareContents) ? teamSharingState.shareContents : [];
  return teamSharingState.shareContents;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeStringEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function mimeExtension(mimeType = '') {
  const clean = String(mimeType || '').trim().toLowerCase();
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/png') return 'png';
  if (clean === 'image/gif') return 'gif';
  if (clean === 'image/webp') return 'webp';
  if (clean === 'image/svg+xml') return 'svg';
  if (clean === 'video/mp4') return 'mp4';
  if (clean === 'video/webm') return 'webm';
  if (clean === 'audio/mpeg') return 'mp3';
  if (clean === 'audio/wav') return 'wav';
  return clean.split('/').pop()?.replace(/[^a-z0-9.+-]+/g, '') || 'bin';
}

function teamSharingAssetPath(asset = {}) {
  const id = String(asset.id || '').trim();
  if (!id) return '';
  const filename = safeFileName(asset.filename || asset.name || `asset-${id}`);
  return `/api/team-sharing/assets/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
}

function teamSharingAssetShareGrant(asset = {}, share = {}) {
  const parts = [
    'team-sharing-asset-grant-v1',
    share.id,
    asset.id,
    asset.workspaceId,
    asset.checksumSha256,
    asset.bytes,
    asset.readToken || '',
  ];
  return sha256Text(parts.map((part) => String(part || '').trim()).join('\n'));
}

function signedTeamSharingAssetPath(asset = {}, share = {}) {
  const path = teamSharingAssetPath(asset);
  const shareId = String(share.id || '').trim();
  if (!path || !shareId) return path;
  const params = new URLSearchParams({
    share: shareId,
    asset_token: teamSharingAssetShareGrant(asset, share),
  });
  return `${path}?${params.toString()}`;
}

function signShareAssetRefs(content = '', { share = {}, teamSharingState = {}, assetIds = [] } = {}) {
  const ids = new Set(asArray(assetIds).map(String).filter(Boolean));
  if (!ids.size) return String(content || '');
  let next = String(content || '');
  for (const asset of ensureTeamSharingAssets(teamSharingState)) {
    if (!asset || asset.revokedAt || !ids.has(String(asset.id || ''))) continue;
    const rawPath = teamSharingAssetPath(asset);
    const signedPath = signedTeamSharingAssetPath(asset, share);
    if (rawPath && signedPath && rawPath !== signedPath) next = next.split(rawPath).join(signedPath);
  }
  return next;
}

function teamSharingAssetUrl(req, asset = {}) {
  const path = teamSharingAssetPath(asset);
  return path ? `${publicUrlFromRequest(req)}${path}` : '';
}

function publicTeamSharingAsset(req, asset = {}) {
  return {
    id: String(asset.id || '').trim(),
    filename: String(asset.filename || asset.name || '').trim(),
    mimeType: String(asset.mimeType || asset.type || '').trim(),
    bytes: Number(asset.bytes || asset.sizeBytes || asset.size || 0),
    checksumSha256: String(asset.checksumSha256 || asset.sha256 || '').trim(),
    workspaceId: String(asset.workspaceId || '').trim(),
    url: teamSharingAssetUrl(req, asset),
    createdAt: String(asset.createdAt || '').trim(),
  };
}

function findTeamSharingAsset(teamSharingState = {}, { workspaceId = '', checksumSha256 = '', bytes = 0, mimeType = '', assetId = '' } = {}) {
  const cleanAssetId = String(assetId || '').trim();
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const cleanHash = String(checksumSha256 || '').trim().toLowerCase();
  const cleanMime = String(mimeType || '').trim().toLowerCase();
  const cleanBytes = Number(bytes || 0);
  return ensureTeamSharingAssets(teamSharingState).find((asset) => {
    if (!asset || asset.revokedAt) return false;
    if (cleanAssetId) return String(asset.id || '').trim() === cleanAssetId;
    if (!cleanWorkspaceId || !cleanHash) return false;
    return String(asset.workspaceId || '').trim() === cleanWorkspaceId
      && String(asset.checksumSha256 || '').trim().toLowerCase() === cleanHash
      && (!cleanBytes || Number(asset.bytes || 0) === cleanBytes)
      && (!cleanMime || String(asset.mimeType || asset.type || '').trim().toLowerCase() === cleanMime);
  }) || null;
}

function decodeDataUrl(value = '') {
  const match = String(value || '').match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  try {
    const mimeType = String(match[1] || '').trim();
    const buffer = Buffer.from(String(match[2] || '').replace(/\s+/g, ''), 'base64');
    return buffer.length ? { mimeType, buffer } : null;
  } catch {
    return null;
  }
}

async function upsertTeamSharingAsset({
  teamSharingState,
  state,
  saveAttachmentBuffer,
  makeId,
  now,
  workspaceId = '',
  filename = '',
  mimeType = '',
  buffer,
  actorId = '',
} = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error('Asset content is required.');
    error.status = 400;
    throw error;
  }
  const cleanWorkspaceId = String(workspaceId || '').trim() || 'local';
  const checksumSha256 = sha256Buffer(buffer);
  const cleanMimeType = String(mimeType || 'application/octet-stream').trim();
  const existing = findTeamSharingAsset(teamSharingState, {
    workspaceId: cleanWorkspaceId,
    checksumSha256,
    bytes: buffer.length,
    mimeType: cleanMimeType,
  });
  if (existing) return { asset: existing, reused: true };
  if (typeof saveAttachmentBuffer !== 'function') {
    const error = new Error('Team Sharing asset storage is unavailable.');
    error.status = 503;
    throw error;
  }
  const fallbackName = `team-sharing-${checksumSha256.slice(0, 16)}.${mimeExtension(cleanMimeType)}`;
  const safeName = safeFileName(filename || fallbackName);
  const attachment = await saveAttachmentBuffer({
    name: safeName,
    type: cleanMimeType,
    buffer,
    source: 'team-sharing-asset',
    extra: {
      workspaceId: cleanWorkspaceId,
      serverId: cleanWorkspaceId,
      ...(actorId ? { createdBy: actorId } : {}),
    },
  });
  state.attachments = Array.isArray(state.attachments) ? state.attachments : [];
  state.attachments.push(attachment);
  const createdAt = now();
  const asset = {
    id: typeof makeId === 'function' ? makeId('asset') : randomToken('asset'),
    workspaceId: cleanWorkspaceId,
    attachmentId: attachment.id || '',
    filename: safeName,
    mimeType: cleanMimeType,
    bytes: buffer.length,
    checksumSha256,
    storageMode: attachment.storageMode || 'pvc',
    storageKey: attachment.storageKey || attachment.relativePath || '',
    relativePath: attachment.relativePath || attachment.storageKey || '',
    path: attachment.path || '',
    readToken: randomToken('mcasset'),
    createdBy: actorId,
    createdAt,
    updatedAt: createdAt,
  };
  ensureTeamSharingAssets(teamSharingState).push(asset);
  return { asset, reused: false };
}

function upsertShareContentBlob(teamSharingState = {}, { workspaceId = '', contentType = '', content = '', assetIds = [], now, makeId } = {}) {
  const cleanWorkspaceId = String(workspaceId || '').trim() || 'local';
  const cleanContentType = String(contentType || '').trim();
  const text = String(content || '');
  const contentHash = sha256Text(text);
  const existing = ensureTeamSharingShareContents(teamSharingState).find((blob) => (
    blob
    && !blob.revokedAt
    && String(blob.workspaceId || '').trim() === cleanWorkspaceId
    && String(blob.contentHash || '').trim() === contentHash
    && String(blob.contentType || '').trim() === cleanContentType
  ));
  if (existing) return existing;
  const createdAt = typeof now === 'function' ? now() : new Date().toISOString();
  const blob = {
    id: typeof makeId === 'function' ? makeId('shc') : `shc_${contentHash.slice(0, 16)}`,
    workspaceId: cleanWorkspaceId,
    contentHash,
    contentType: cleanContentType,
    content: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    assetIds: Array.from(new Set(assetIds.map(String).filter(Boolean))),
    createdAt,
    updatedAt: createdAt,
  };
  ensureTeamSharingShareContents(teamSharingState).push(blob);
  return blob;
}

function currentShareVersion(share = {}) {
  const versions = Array.isArray(share.versions) ? share.versions : [];
  const currentVersionId = String(share.currentVersionId || '').trim();
  return versions.find((version) => String(version.id || '').trim() === currentVersionId)
    || versions.at(-1)
    || null;
}

function shareContentBlob(teamSharingState = {}, version = {}) {
  const blobId = String(version?.contentBlobId || '').trim();
  const hash = String(version?.contentHash || '').trim();
  return ensureTeamSharingShareContents(teamSharingState).find((blob) => (
    blob
    && !blob.revokedAt
    && ((blobId && String(blob.id || '').trim() === blobId) || (hash && String(blob.contentHash || '').trim() === hash))
  )) || null;
}

function shareContentRecord(teamSharingState = {}, share = {}) {
  const version = currentShareVersion(share);
  const blob = shareContentBlob(teamSharingState, version);
  const content = String(blob?.content ?? version?.content ?? share.content ?? '');
  const contentType = String(version?.contentType || blob?.contentType || share.contentType || '').trim();
  const assetIds = Array.from(new Set(asArray(version?.assetIds || blob?.assetIds || share.assetIds).map(String).filter(Boolean)));
  return {
    version,
    blob,
    content,
    contentType,
    contentHash: String(version?.contentHash || blob?.contentHash || share.contentHash || (content ? sha256Text(content) : '')).trim(),
    assetIds,
  };
}

function ensureShareVersionModel(teamSharingState = {}, share = {}, { makeId, now } = {}) {
  share.versions = Array.isArray(share.versions) ? share.versions : [];
  if (share.versions.length && share.currentVersionId) return shareContentRecord(teamSharingState, share);
  const createdAt = share.createdAt || (typeof now === 'function' ? now() : new Date().toISOString());
  const contentType = normalizeShareContentType(share.contentType, share.content || '');
  const assetIds = asArray(share.assetIds).map(String).filter(Boolean);
  const blob = upsertShareContentBlob(teamSharingState, {
    workspaceId: share.workspaceId || 'local',
    contentType,
    content: share.content || '',
    assetIds,
    now,
    makeId,
  });
  const version = {
    id: typeof makeId === 'function' ? makeId('shv') : `shv_${blob.contentHash.slice(0, 16)}`,
    shareId: share.id || '',
    title: share.title || 'MagClaw shared page',
    description: share.description || '',
    contentType,
    contentHash: blob.contentHash,
    contentBlobId: blob.id,
    assetIds,
    createdAt,
    createdBy: share.creator?.id || share.createdBy || '',
    reason: 'initial',
  };
  share.versions.push(version);
  share.currentVersionId = version.id;
  share.contentHash = blob.contentHash;
  share.assetIds = assetIds;
  share.contentType = contentType;
  share.updatedAt = share.updatedAt || createdAt;
  return { version, blob, content: blob.content, contentType, contentHash: blob.contentHash, assetIds };
}

function publicUrlFromRequest(req) {
  const configured = String(process.env.MAGCLAW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req?.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req?.headers?.host || '127.0.0.1:6543';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function shareUrl(req, shareId = '') {
  return `${publicUrlFromRequest(req)}/s/${encodeURIComponent(shareId)}`;
}

function stripTags(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugSegment(value = '', fallback = 'section') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || fallback;
}

function htmlAttr(attrs = '', name = '') {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*([\"'])(.*?)\\1`, 'i');
  const match = String(attrs || '').match(pattern);
  return match ? String(match[2] || '').trim() : '';
}

function extractHtmlShareSections(content = '') {
  const text = String(content || '');
  const sections = [];
  const sectionPattern = /<section\b([^>]*)>[\s\S]*?<\/section>/gi;
  let match;
  let index = 0;
  while ((match = sectionPattern.exec(text))) {
    index += 1;
    const html = match[0];
    const attrs = match[1] || '';
    const explicitId = htmlAttr(attrs, 'id');
    const heading = html.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
    const title = stripTags(heading?.[2] || explicitId || `Section ${index}`);
    const sectionId = explicitId || slugSegment(title, `section-${index}`);
    sections.push({
      sectionId,
      selector: explicitId ? `section#${explicitId}` : `section:nth-of-type(${index})`,
      title,
      hash: sha256Text(html),
      content: html,
      startOffset: match.index,
      endOffset: match.index + html.length,
    });
  }
  if (sections.length) return sections;
  const headingPattern = /<h([1-3])\b([^>]*)>[\s\S]*?<\/h\1>/gi;
  const headings = [];
  while ((match = headingPattern.exec(text))) {
    headings.push({ index: match.index, heading: match[0], attrs: match[2] || '' });
  }
  return headings.map((heading, idx) => {
    const end = headings[idx + 1]?.index ?? text.length;
    const html = text.slice(heading.index, end);
    const explicitId = htmlAttr(heading.attrs, 'id');
    const title = stripTags(heading.heading);
    const sectionId = explicitId || slugSegment(title, `section-${idx + 1}`);
    return {
      sectionId,
      selector: explicitId ? `#${explicitId}` : `h${idx + 1}`,
      title,
      hash: sha256Text(html),
      content: html,
      startOffset: heading.index,
      endOffset: end,
    };
  });
}

function extractMarkdownShareSections(content = '') {
  const text = String(content || '');
  const headingPattern = /^(#{1,3})\s+(.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(text))) {
    headings.push({ index: match.index, marker: match[1], title: match[2] });
  }
  if (!headings.length) {
    return [{
      sectionId: 'document',
      selector: 'document',
      title: 'Document',
      hash: sha256Text(text),
      content: text,
      startOffset: 0,
      endOffset: text.length,
    }];
  }
  return headings.map((heading, idx) => {
    const end = headings[idx + 1]?.index ?? text.length;
    const block = text.slice(heading.index, end);
    const title = String(heading.title || '').trim();
    return {
      sectionId: slugSegment(title, `section-${idx + 1}`),
      selector: `${heading.marker} ${title}`,
      title,
      hash: sha256Text(block),
      content: block,
      startOffset: heading.index,
      endOffset: end,
    };
  });
}

function extractShareSections(content = '', contentType = '') {
  const type = String(contentType || '').trim().toLowerCase();
  const sections = type === 'html' || type === 'svg'
    ? extractHtmlShareSections(content)
    : extractMarkdownShareSections(content);
  return sections.map((section, index) => ({
    ...section,
    ordinal: index + 1,
    bytes: Buffer.byteLength(String(section.content || ''), 'utf8'),
  }));
}

function shareAssetRefs(req, teamSharingState = {}, assetIds = []) {
  const ids = new Set(asArray(assetIds).map(String).filter(Boolean));
  if (!ids.size) return [];
  return ensureTeamSharingAssets(teamSharingState)
    .filter((asset) => ids.has(String(asset.id || '')) && !asset.revokedAt)
    .map((asset) => publicTeamSharingAsset(req, asset));
}

function shareReadPayload(req, share = {}, teamSharingState = {}) {
  const record = shareContentRecord(teamSharingState, share);
  const contentType = record.contentType || String(share.contentType || '').trim();
  return {
    ok: true,
    kind: 'share',
    shareId: String(share.id || '').trim(),
    title: String(share.title || '').trim(),
    description: String(share.description || '').trim(),
    contentType,
    content: record.content,
    versionId: String(record.version?.id || share.currentVersionId || '').trim(),
    contentHash: record.contentHash,
    assetRefs: shareAssetRefs(req, teamSharingState, record.assetIds),
    sections: extractShareSections(record.content, contentType).map((section) => ({
      sectionId: section.sectionId,
      selector: section.selector,
      title: section.title,
      hash: section.hash,
      bytes: section.bytes,
      ordinal: section.ordinal,
    })),
    workspaceId: String(share.workspaceId || '').trim(),
    channelId: String(share.channelId || '').trim(),
    channelPath: String(share.channelPath || '').trim(),
    projectKey: String(share.projectKey || '').trim(),
    creator: share.creator && typeof share.creator === 'object' ? {
      id: String(share.creator.id || '').trim(),
      name: String(share.creator.name || '').trim(),
      email: String(share.creator.email || '').trim(),
    } : null,
    createdAt: String(share.createdAt || '').trim(),
    updatedAt: String(share.updatedAt || '').trim(),
    url: shareUrl(req, share.id || ''),
  };
}

function shareListItemPayload(req, share = {}, teamSharingState = {}, extra = {}) {
  const record = shareContentRecord(teamSharingState, share);
  return {
    id: String(share.id || '').trim(),
    shareId: String(share.id || '').trim(),
    title: String(share.title || '').trim(),
    description: String(share.description || '').trim(),
    contentType: String(record.contentType || share.contentType || '').trim(),
    versionId: String(record.version?.id || share.currentVersionId || '').trim(),
    contentHash: String(record.contentHash || '').trim(),
    assetCount: record.assetIds.length,
    workspaceId: String(share.workspaceId || '').trim(),
    channelId: String(share.channelId || '').trim(),
    channelPath: String(share.channelPath || '').trim(),
    projectKey: String(share.projectKey || '').trim(),
    creator: share.creator && typeof share.creator === 'object' ? {
      id: String(share.creator.id || '').trim(),
      name: String(share.creator.name || '').trim(),
      email: String(share.creator.email || '').trim(),
    } : null,
    createdAt: String(share.createdAt || '').trim(),
    updatedAt: String(share.updatedAt || '').trim(),
    revokedAt: String(share.revokedAt || '').trim(),
    status: share.revokedAt ? 'revoked' : 'active',
    url: shareUrl(req, share.id || ''),
    ...extra,
  };
}

function shareSectionsPayload(req, share = {}, teamSharingState = {}) {
  const record = shareContentRecord(teamSharingState, share);
  const contentType = record.contentType || String(share.contentType || '').trim();
  return {
    ok: true,
    kind: 'share_sections',
    shareId: String(share.id || '').trim(),
    versionId: String(record.version?.id || share.currentVersionId || '').trim(),
    contentHash: record.contentHash,
    contentType,
    title: String(share.title || '').trim(),
    sections: extractShareSections(record.content, contentType),
    assetRefs: shareAssetRefs(req, teamSharingState, record.assetIds),
    url: shareUrl(req, share.id || ''),
  };
}

function normalizeUploaderSearchText(uploader = {}) {
  return [
    uploader.id,
    uploader.name,
    uploader.email,
  ].map((value) => compactText(value, 512)).filter(Boolean).join(' ');
}

function uploaderMetadataFromIdentity(identity = {}) {
  const id = String(identity.id || identity.humanId || identity.userId || '').trim();
  const name = compactText(identity.name || identity.displayName || '', 160);
  const email = String(identity.email || '').trim();
  const avatar = String(identity.avatar || identity.avatarUrl || '').trim();
  return {
    uploaderId: id,
    uploaderName: name,
    uploaderEmail: email,
    uploaderAvatar: avatar,
    uploaderSearchText: normalizeUploaderSearchText({ id, name, email }),
  };
}

function searchableShareText(value = '', contentType = '') {
  const text = String(value || '');
  const type = String(contentType || '').trim().toLowerCase();
  const withoutCode = type === 'html' || type === 'svg'
    ? text
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    : text;
  return withoutCode
    .replace(/\b(?:src|href)=["']data:[^"']+["']/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkSearchableText(text = '', maxChars = 6000, maxChunks = 80) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const chunks = [];
  for (let offset = 0; offset < clean.length && chunks.length < maxChunks; offset += maxChars) {
    chunks.push(clean.slice(offset, offset + maxChars));
  }
  return chunks;
}

function upsertTeamSharingVectorDocument(teamSharingState = {}, document = {}) {
  teamSharingState.vectorDocuments = Array.isArray(teamSharingState.vectorDocuments) ? teamSharingState.vectorDocuments : [];
  const id = String(document.vectorDocumentId || '').trim();
  if (!id) return null;
  const index = teamSharingState.vectorDocuments.findIndex((item) => String(item.vectorDocumentId || '') === id);
  if (index >= 0) {
    teamSharingState.vectorDocuments[index] = { ...teamSharingState.vectorDocuments[index], ...document };
    return teamSharingState.vectorDocuments[index];
  }
  teamSharingState.vectorDocuments.push(document);
  return document;
}

function refreshShareVectorDocuments(teamSharingState = {}, share = {}) {
  teamSharingState.vectorDocuments = Array.isArray(teamSharingState.vectorDocuments) ? teamSharingState.vectorDocuments : [];
  const shareId = String(share.id || '').trim();
  if (!shareId) return [];
  const record = shareContentRecord(teamSharingState, share);
  const contentType = record.contentType || String(share.contentType || '').trim();
  const updatedAt = String(share.updatedAt || share.createdAt || new Date().toISOString()).trim();
  const uploader = uploaderMetadataFromIdentity(share.creator || {});
  for (const doc of teamSharingState.vectorDocuments) {
    if (String(doc.sourceKind || '') === 'share' && String(doc.shareId || '') === shareId) doc.active = false;
  }
  if (share.revokedAt) return [];
  const common = {
    sourceKind: 'share',
    workspaceId: String(share.workspaceId || 'local').trim(),
    channelId: String(share.channelId || '').trim(),
    projectKey: String(share.projectKey || '').trim(),
    runtime: String(share.source?.runtime || 'skill').trim(),
    sessionId: `share:${shareId}`,
    shareId,
    contentType,
    title: compactText(share.title || 'MagClaw shared page', 180),
    updatedAt,
    active: true,
    ...uploader,
  };
  const docs = [];
  const overviewText = compactText(`${share.title || ''}\n${share.description || ''}`, 1800);
  docs.push(upsertTeamSharingVectorDocument(teamSharingState, {
    ...common,
    vectorDocumentId: `share:${shareId}:L0`,
    layer: 'L0',
    topicId: '',
    shareSectionId: '',
    sourceRef: `share/${shareId}`,
    text: overviewText || common.title,
    vectorScore: 0,
    keywordScore: 0,
    freshnessScore: 1,
  }));
  const sections = extractShareSections(record.content, contentType);
  for (const section of sections) {
    const sectionText = searchableShareText(section.content, contentType);
    const chunks = chunkSearchableText(sectionText);
    chunks.forEach((chunk, chunkIndex) => {
      const suffix = chunks.length > 1 ? `:${chunkIndex + 1}` : '';
      docs.push(upsertTeamSharingVectorDocument(teamSharingState, {
        ...common,
        vectorDocumentId: `share:${shareId}:L1:${section.sectionId}${suffix}`,
        layer: 'L1',
        topicId: String(section.sectionId || '').trim(),
        shareSectionId: String(section.sectionId || '').trim(),
        sourceRef: `share/${shareId}/sections/${section.sectionId}${suffix}`,
        text: `${common.title}\n${section.title || section.sectionId || 'Section'}\n${chunk}`,
        vectorScore: 0,
        keywordScore: 0,
        freshnessScore: 1,
      }));
    });
  }
  return docs.filter(Boolean);
}

function deactivateShareVectorDocuments(teamSharingState = {}, share = {}) {
  const shareId = String(share.id || '').trim();
  if (!shareId) return [];
  const changed = [];
  teamSharingState.vectorDocuments = Array.isArray(teamSharingState.vectorDocuments) ? teamSharingState.vectorDocuments : [];
  for (const doc of teamSharingState.vectorDocuments) {
    if (String(doc.sourceKind || '') !== 'share' || String(doc.shareId || '') !== shareId) continue;
    if (doc.active !== false) {
      doc.active = false;
      changed.push(doc);
    }
  }
  return changed;
}

function parseAttachmentRange(rangeHeader, size) {
  const value = String(rangeHeader || '').trim();
  if (!value || !Number.isFinite(size) || size < 0) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { unsatisfiable: true };
  let [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { unsatisfiable: true };
  if (!size) return { unsatisfiable: true };
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

function assetWorkspaceAccess(req, { actor, currentUser, teamSharingState, asset, state } = {}) {
  const workspaceId = String(asset?.workspaceId || '').trim();
  const browserAccess = browserWorkspaceAccess({
    actor,
    currentUser,
    state,
    workspaceId,
    error: 'This Team Sharing asset is only available to members of this server.',
  });
  if (browserAccess) return browserAccess;
  const tokenRecord = tokenRecordForRequest(teamSharingState, req);
  const tokenAccess = tokenWorkspaceAccess(state, tokenRecord, workspaceId, 'This Team Sharing asset is only available to members of this server.');
  if (tokenAccess) return tokenAccess;
  return { ok: false, status: 401, workspaceId, actorId: '', error: 'Sign in to MagClaw and join this server to open this asset.' };
}

function shareAssetGrantAccess(teamSharingState = {}, asset = {}, searchParams = new URLSearchParams()) {
  const shareId = String(searchParams.get('share') || searchParams.get('shareId') || '').trim();
  const grant = String(searchParams.get('asset_token') || searchParams.get('assetToken') || '').trim();
  if (!shareId && !grant) return null;
  const workspaceId = String(asset?.workspaceId || '').trim();
  const share = ensureTeamSharingShares(teamSharingState).find((item) => (
    item
    && item.revokedAt == null
    && String(item.id || '').trim() === shareId
    && String(item.workspaceId || '').trim() === workspaceId
  ));
  const record = share ? shareContentRecord(teamSharingState, share) : null;
  const assetIds = new Set(asArray(record?.assetIds).map(String).filter(Boolean));
  const expected = share ? teamSharingAssetShareGrant(asset, share) : '';
  const allowed = Boolean(
    grant
    && share
    && assetIds.has(String(asset.id || ''))
    && timingSafeStringEqual(grant, expected),
  );
  if (allowed) {
    return { ok: true, status: 200, workspaceId, actorId: `share:${shareId}`, via: 'share_asset_token' };
  }
  return {
    ok: false,
    status: 401,
    workspaceId,
    actorId: '',
    error: 'This Team Sharing asset token is invalid or expired.',
  };
}

function identityForEditor({ actor = null, currentUser = null, tokenRecord = null } = {}) {
  const member = actor?.member || {};
  const user = currentUser || actor?.user || tokenRecord?.user || {};
  return {
    id: String(user.id || member.userId || member.humanId || '').trim(),
    userId: String(user.id || member.userId || '').trim(),
    humanId: String(member.humanId || user.humanId || user.id || '').trim(),
    email: String(user.email || member.email || '').trim(),
    role: String(member.role || '').trim(),
  };
}

function editorMatchesCreator(identity = {}, share = {}) {
  const creator = share.creator || {};
  const ids = new Set([identity.id, identity.userId, identity.humanId].map((value) => String(value || '').trim()).filter(Boolean));
  const creatorIds = [creator.id, share.createdBy, share.createdById].map((value) => String(value || '').trim()).filter(Boolean);
  if (creatorIds.some((id) => ids.has(id))) return true;
  const email = String(identity.email || '').trim().toLowerCase();
  const creatorEmail = String(creator.email || '').trim().toLowerCase();
  return Boolean(email && creatorEmail && email === creatorEmail);
}

function editorMemberForShare(state = {}, identity = {}, share = {}, actor = null) {
  const workspaceId = String(share.workspaceId || '').trim();
  if (actor?.member && String(actor.member.workspaceId || '').trim() === workspaceId) return actor.member;
  return activeWorkspaceMemberForIdentity(state, identity, workspaceId);
}

function roleCanEditShare(role = '') {
  return ['owner', 'admin'].includes(String(role || '').trim().toLowerCase());
}

function shareEditAccess(req, { actor, currentUser, teamSharingState, share, state } = {}) {
  const access = shareAccess(req, { actor, currentUser, teamSharingState, share, state });
  if (!access.ok) return access;
  const tokenRecord = actor ? null : tokenRecordForRequest(teamSharingState, req);
  const identity = identityForEditor({ actor, currentUser, tokenRecord });
  if (editorMatchesCreator(identity, share)) return { ...access, canEdit: true, editorId: identity.humanId || identity.id, editVia: 'creator' };
  const member = editorMemberForShare(state, identity, share, actor);
  if (member && roleCanEditShare(member.role)) {
    return { ...access, canEdit: true, editorId: member.humanId || identity.humanId || identity.id, editVia: 'admin', member };
  }
  return {
    ok: false,
    status: 403,
    workspaceId: share.workspaceId || '',
    actorId: identity.humanId || identity.id || access.actorId || '',
    error: 'Only the share creator, workspace owner, or workspace admin can edit this shared page.',
  };
}

function assetFilePath(asset = {}, attachmentStorageDir = '') {
  const fromStorage = attachmentPathWithinStorage(asset, attachmentStorageDir);
  if (fromStorage) return fromStorage;
  return String(asset.path || '').trim();
}

async function optimizeInlineShareAssets({
  req,
  content = '',
  workspaceId = '',
  teamSharingState,
  state,
  saveAttachmentBuffer,
  makeId,
  now,
  actorId = '',
} = {}) {
  const text = String(content || '');
  const pattern = /\b(src|href)=(["'])data:((?:image|video|audio)\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\2/gi;
  let output = '';
  let lastIndex = 0;
  let match;
  const assetIds = [];
  const assets = [];
  while ((match = pattern.exec(text))) {
    output += text.slice(lastIndex, match.index);
    lastIndex = pattern.lastIndex;
    const [full, attr, quote, mimeType, base64Body] = match;
    let replacement = full;
    try {
      const buffer = Buffer.from(String(base64Body || '').replace(/\s+/g, ''), 'base64');
      if (buffer.length >= TEAM_SHARING_INLINE_ASSET_THRESHOLD_BYTES) {
        const checksum = sha256Buffer(buffer);
        const filename = `team-sharing-${checksum.slice(0, 16)}.${mimeExtension(mimeType)}`;
        const { asset } = await upsertTeamSharingAsset({
          teamSharingState,
          state,
          saveAttachmentBuffer,
          makeId,
          now,
          workspaceId,
          filename,
          mimeType,
          buffer,
          actorId,
        });
        assetIds.push(asset.id);
        assets.push(asset);
        replacement = `${attr}=${quote}${teamSharingAssetPath(asset)}${quote}`;
      }
    } catch (error) {
      addInlineAssetOptimizationError(state, error, req);
    }
    output += replacement;
  }
  output += text.slice(lastIndex);
  return {
    content: output,
    assetIds: Array.from(new Set(assetIds)),
    assets,
    optimized: assetIds.length > 0,
  };
}

function addInlineAssetOptimizationError(state = {}, error = null, req = null) {
  state.teamSharing = state.teamSharing || {};
  state.teamSharing.assetOptimizationWarnings = Array.isArray(state.teamSharing.assetOptimizationWarnings)
    ? state.teamSharing.assetOptimizationWarnings
    : [];
  state.teamSharing.assetOptimizationWarnings.push({
    message: error?.message || 'Team Sharing inline asset optimization failed.',
    path: req?.url || '',
    createdAt: new Date().toISOString(),
  });
  if (state.teamSharing.assetOptimizationWarnings.length > 20) {
    state.teamSharing.assetOptimizationWarnings = state.teamSharing.assetOptimizationWarnings.slice(-20);
  }
}

function operationTargetSection(operation = {}, sections = []) {
  const sectionId = String(operation.sectionId || operation.section_id || '').trim();
  const selector = String(operation.selector || '').trim();
  return sections.find((section) => (
    (sectionId && section.sectionId === sectionId)
    || (selector && section.selector === selector)
  )) || null;
}

function applyReplaceSectionOperation(content = '', contentType = '', operation = {}) {
  const sections = extractShareSections(content, contentType);
  const section = operationTargetSection(operation, sections);
  if (!section) {
    const error = new Error(`Section not found: ${operation.sectionId || operation.selector || ''}`);
    error.status = 404;
    throw error;
  }
  const expectedHash = String(operation.expectedHash || operation.expected_hash || '').trim();
  if (!expectedHash) {
    const error = new Error('expectedHash is required for replace_section.');
    error.status = 400;
    throw error;
  }
  if (expectedHash !== section.hash) {
    const error = new Error('Section hash does not match the latest version.');
    error.status = 409;
    error.reason = 'version_conflict';
    error.section = { sectionId: section.sectionId, expectedHash, actualHash: section.hash };
    throw error;
  }
  const replacement = String(operation.content ?? operation.html ?? operation.markdown ?? operation.replacement ?? '');
  if (!replacement.trim()) {
    const error = new Error('Replacement content is required.');
    error.status = 400;
    throw error;
  }
  const before = content.slice(0, section.startOffset);
  const after = content.slice(section.endOffset);
  const nextContent = `${before}${replacement}${after}`;
  return {
    content: nextContent,
    changed: {
      type: 'replace_section',
      sectionId: section.sectionId,
      title: section.title,
      previousHash: section.hash,
      nextHash: sha256Text(replacement),
    },
  };
}

function applyReplaceSelectorTextOperation(content = '', operation = {}) {
  const selector = String(operation.selector || '').trim();
  const idMatch = selector.match(/#([a-zA-Z0-9_.:-]+)/);
  if (!idMatch) {
    const error = new Error('replace_selector_text currently requires an id selector.');
    error.status = 400;
    throw error;
  }
  const id = idMatch[1].replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`(<([a-zA-Z0-9:-]+)\\b[^>]*\\bid=(["'])${id}\\3[^>]*>)([\\s\\S]*?)(<\\/\\2>)`, 'i');
  const match = content.match(pattern);
  if (!match) {
    const error = new Error(`Selector not found: ${selector}`);
    error.status = 404;
    throw error;
  }
  const expectedHash = String(operation.expectedHash || operation.expected_hash || '').trim();
  const currentHash = sha256Text(match[0]);
  if (expectedHash && expectedHash !== currentHash) {
    const error = new Error('Selector hash does not match the latest version.');
    error.status = 409;
    error.reason = 'version_conflict';
    error.section = { selector, expectedHash, actualHash: currentHash };
    throw error;
  }
  const text = htmlEscape(String(operation.text ?? operation.replacement ?? ''));
  const replacement = `${match[1]}${text}${match[5]}`;
  return {
    content: content.replace(match[0], replacement),
    changed: {
      type: 'replace_selector_text',
      selector,
      previousHash: currentHash,
      nextHash: sha256Text(replacement),
    },
  };
}

function applyReplaceContentOperation(content = '', operation = {}) {
  const expectedHash = String(operation.expectedHash || operation.expected_hash || '').trim();
  const currentHash = sha256Text(content);
  if (expectedHash && expectedHash !== currentHash) {
    const error = new Error('Content hash does not match the latest version.');
    error.status = 409;
    error.reason = 'version_conflict';
    error.section = { selector: 'document', expectedHash, actualHash: currentHash };
    throw error;
  }
  const replacement = String(operation.content ?? operation.replacement ?? operation.html ?? operation.markdown ?? '');
  return {
    content: replacement,
    changed: {
      type: 'replace_content',
      previousHash: currentHash,
      nextHash: sha256Text(replacement),
    },
  };
}

function applySharePatchOperations(content = '', contentType = '', operations = []) {
  let nextContent = String(content || '');
  const changedSections = [];
  for (const operation of operations) {
    const type = String(operation?.op || operation?.type || '').trim();
    if (type === 'replace_content') {
      const result = applyReplaceContentOperation(nextContent, operation);
      nextContent = result.content;
      changedSections.push(result.changed);
      continue;
    }
    if (type === 'replace_section') {
      const result = applyReplaceSectionOperation(nextContent, contentType, operation);
      nextContent = result.content;
      changedSections.push(result.changed);
      continue;
    }
    if (type === 'replace_selector_text') {
      const result = applyReplaceSelectorTextOperation(nextContent, operation);
      nextContent = result.content;
      changedSections.push(result.changed);
      continue;
    }
    if (type === 'replace_asset_ref') {
      const from = String(operation.from || operation.previousUrl || '').trim();
      const to = String(operation.to || operation.nextUrl || '').trim();
      if (!from || !to) {
        const error = new Error('replace_asset_ref requires from and to.');
        error.status = 400;
        throw error;
      }
      nextContent = nextContent.split(from).join(to);
      changedSections.push({ type, previousHash: sha256Text(from), nextHash: sha256Text(to) });
      continue;
    }
    if (type === 'set_metadata') continue;
    const error = new Error(`Unsupported share patch operation: ${type || 'unknown'}`);
    error.status = 400;
    throw error;
  }
  return { content: nextContent, changedSections };
}

function sharePatchChangesContent(operations = []) {
  return asArray(operations).some((operation) => {
    const type = String(operation?.op || operation?.type || '').trim();
    return ['replace_content', 'replace_section', 'replace_selector_text', 'replace_asset_ref'].includes(type);
  });
}

function creatorFromActor(actor = {}, tokenRecord = null) {
  const member = actor?.member || {};
  const user = actor?.user || actor?.human || tokenRecord?.user || {};
  const id = String(member.humanId || user.id || 'hum_local').trim();
  const displayName = String(member.name || user.name || member.email || user.email || id || 'Unknown creator').trim();
  return {
    id,
    name: displayName,
    email: String(member.email || user.email || '').trim(),
  };
}

function formatChinaDateTime(value = '') {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return String(value || '').trim();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((memo, part) => {
    if (part.type !== 'literal') memo[part.type] = part.value;
    return memo;
  }, {});
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

function shareFooterHtml(share = {}) {
  const creator = share.creator?.name || share.createdByName || share.createdBy || 'Unknown creator';
  const createdAt = formatChinaDateTime(share.createdAt || '');
  return `<footer class="magclaw-share-footer">Created by ${htmlEscape(creator)}${createdAt ? ` · ${htmlEscape(createdAt)}` : ''}</footer>`;
}

function renderMarkdownInline(value = '') {
  return htmlEscape(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

function renderMarkdownToHtml(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let inCode = false;
  let code = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  const flushCode = () => {
    out.push(`<pre><code>${htmlEscape(code.join('\n'))}</code></pre>`);
    code = [];
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        closeList();
        inCode = true;
        code = [];
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${renderMarkdownInline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  }
  if (inCode) flushCode();
  closeList();
  return out.join('\n');
}

function workspaceFileHeadingSlug(value = '', seen = {}) {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
  const count = seen[base] || 0;
  seen[base] = count + 1;
  return count ? `${base}-${count + 1}` : base;
}

function workspaceFileOutline(markdown = '') {
  const seen = {};
  return String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/))
    .filter(Boolean)
    .map((match) => {
      const text = String(match[2] || '').trim().replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1');
      return {
        level: match[1].length,
        text,
        id: workspaceFileHeadingSlug(text, seen),
      };
    });
}

function renderWorkspaceFileOutline(markdown = '') {
  const items = workspaceFileOutline(markdown).slice(0, 24);
  if (!items.length) return '';
  return `<aside class="workspace-file-outline" aria-label="Document outline">
    <div class="outline-title">Outline</div>
    ${items.map((item) => `<a class="level-${item.level}" href="#${htmlEscape(item.id)}">${htmlEscape(item.text)}</a>`).join('\n')}
  </aside>`;
}

function renderWorkspaceFileMarkdownToHtml(markdown = '') {
  const outline = workspaceFileOutline(markdown);
  let index = 0;
  return renderMarkdownToHtml(markdown).replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    const item = outline[index++] || {};
    const id = item.id || `section-${index}`;
    return `<h${level} id="${htmlEscape(id)}">${inner}</h${level}>`;
  });
}

function shareChromeHtml(share = {}, innerHtml = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(share.title || 'Team Shares')}</title>
  <style>
    :root { color-scheme: light; --ink:#14212b; --muted:#64748b; --line:#d9e2e5; --bg:#f8fafc; --panel:#fff; --accent:#0891b2; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.62; }
    main { max-width:900px; margin:0 auto; padding:28px 18px 80px; }
    .shell { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:28px; box-shadow:0 8px 30px rgba(15,23,42,.05); }
    .brand { color:var(--accent); font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:0; margin:0; }
    h1,h2,h3,h4 { line-height:1.25; letter-spacing:0; }
    h1 { margin:0 0 14px; font-size:32px; }
    p { margin:10px 0; }
    pre { overflow-x:auto; background:#0f1720; color:#d9f4f6; padding:14px; border-radius:8px; }
    code { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
    blockquote { margin:12px 0; padding:8px 12px; border-left:3px solid #9ecfe1; border-radius:0 7px 7px 0; background:#f2f8fb; color:#3f6474; }
    a { color:var(--accent); }
    svg { max-width:100%; height:auto; }
    .share-root-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:16px; }
    .share-root-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .share-root-actions button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:7px 10px; font-size:12px; font-weight:800; cursor:pointer; transition:border-color .16s ease, color .16s ease, transform .16s ease; }
    .share-root-actions button:hover, .share-root-actions button:focus-visible { border-color:var(--accent); color:var(--accent); transform:translateY(-1px); outline:0; }
    .share-channel { border-top:1px solid var(--line); padding-top:14px; margin-top:16px; }
    .share-channel:first-of-type { border-top:0; padding-top:0; margin-top:0; }
    .share-channel summary { list-style:none; display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; font-size:20px; font-weight:800; line-height:1.2; }
    .share-channel summary::-webkit-details-marker { display:none; }
    .share-channel-caret { display:inline-grid; place-items:center; width:16px; height:16px; color:var(--accent); transform:rotate(0deg); transition:transform .18s ease; }
    .share-channel[open] .share-channel-caret { transform:rotate(90deg); }
    .share-channel-count { color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; }
    .share-channel-content { display:grid; gap:10px; overflow:hidden; padding:12px 0 2px 24px; }
    .share-channel[open] .share-channel-content { animation:share-channel-open .18s ease; }
    .share-entry { display:block; border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:#fff; text-decoration:none; color:inherit; transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
    .share-entry:hover, .share-entry:focus-visible { border-color:var(--accent); box-shadow:0 8px 22px rgba(8,145,178,.11); transform:translateY(-1px); outline:0; }
    .share-entry h2 { margin:0 0 5px; font-size:15px; color:var(--accent); }
    .share-entry p { color:var(--muted); font-size:14px; margin:0 0 8px; }
    .share-entry small { color:var(--muted); display:block; }
    .magclaw-share-footer { max-width:900px; margin:24px auto 0; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
    @keyframes share-channel-open { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
    @media (max-width: 640px) { .share-root-head { align-items:flex-start; flex-direction:column; } .share-root-actions { justify-content:flex-start; } }
  </style>
</head>
<body>
  <main>
    <section class="shell">
          ${share.hideChromeBrand ? '' : '<div class="brand">Team Shares</div>'}
          ${innerHtml}
    </section>
    ${shareFooterHtml(share)}
  </main>
</body>
</html>`;
}

function renderShareHtml(share = {}, teamSharingState = {}) {
  const title = htmlEscape(share.title || 'Shared page');
  const record = shareContentRecord(teamSharingState, share);
  const content = signShareAssetRefs(String(record.content || ''), {
    share,
    teamSharingState,
    assetIds: record.assetIds,
  });
  const contentType = record.contentType || share.contentType;
  if (contentType === 'html') {
    const footer = shareFooterHtml(share);
    if (/^<!doctype html/i.test(content.trim()) || /^<html[\s>]/i.test(content.trim())) {
      return /<\/body>/i.test(content)
        ? content.replace(/<\/body>/i, `${footer}\n</body>`)
        : `${content}\n${footer}`;
    }
    return shareChromeHtml(share, `<h1>${title}</h1>\n${content}`);
  }
  if (contentType === 'svg') {
    const svg = content.trim().startsWith('<svg') ? content : `<pre><code>${htmlEscape(content)}</code></pre>`;
    return shareChromeHtml(share, `<h1>${title}</h1>\n${svg}`);
  }
  if (contentType === 'mermaid') {
    return shareChromeHtml(share, `<h1>${title}</h1>
<pre class="mermaid">${htmlEscape(content.replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim())}</pre>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>`);
  }
  return shareChromeHtml(share, renderMarkdownToHtml(content));
}

function sendShareHtml(res, body, { status = 200 } = {}) {
  res.writeHead?.(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:;",
  });
  res.end?.(body);
}

function shareChannelFolderLabel(share = {}) {
  return String(share.channelPath || share.channelId || 'Unconfigured Channel').trim();
}

function displayShareChannelName(value = '') {
  const raw = String(value || 'Unconfigured Channel').trim();
  const parts = raw
    .replace(/^[a-z][a-z0-9-]*:\/\//i, '')
    .split(/[/>]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(manual[-_\s]?upload|manual|upload)$/i.test(part));
  return parts.at(-1) || raw;
}

function renderShareIndexHtml(shares = [], teamSharingState = {}) {
  const grouped = new Map();
  for (const share of shares.slice().reverse()) {
    const channel = displayShareChannelName(shareChannelFolderLabel(share));
    if (!grouped.has(channel)) grouped.set(channel, []);
    grouped.get(channel).push({ share, record: shareContentRecord(teamSharingState, share) });
  }
  const folders = [...grouped.entries()].map(([channel, items]) => `
    <details class="share-channel" open>
      <summary><span class="share-channel-caret">▸</span><span># ${htmlEscape(channel)}</span><span class="share-channel-count">${items.length}</span></summary>
      <div class="share-channel-content">
        ${items.map(({ share, record }) => `
          <a class="share-entry" href="/s/${encodeURIComponent(share.id)}">
            <h2>${htmlEscape(share.title || share.id)}</h2>
            <p>${htmlEscape(compactText(share.description || record.content || '', 180))}</p>
            <small>${htmlEscape(record.contentType || share.contentType || 'artifact')} · 创建者 ${htmlEscape(share.creator?.name || 'Unknown creator')} · ${htmlEscape(formatChinaDateTime(share.updatedAt || share.createdAt || ''))}</small>
          </a>
        `).join('')}
      </div>
    </details>
  `).join('\n') || '<p>No shared pages yet.</p>';
  const controls = `
    <div class="share-root-head">
      <div class="brand">Team Shares</div>
      <div class="share-root-actions" aria-label="Team Shares view controls">
        <button type="button" data-share-root-action="expand-all">全部展开</button>
        <button type="button" data-share-root-action="collapse-all">全部折叠</button>
      </div>
    </div>
  `;
  const script = `
    <script>
      (() => {
        const channels = () => [...document.querySelectorAll('.share-channel')];
        const animateChannel = (details, shouldOpen) => {
          const content = details.querySelector('.share-channel-content');
          if (!content) {
            details.open = shouldOpen;
            return;
          }
          if (shouldOpen) {
            details.open = true;
            content.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
            return;
          }
          const height = content.scrollHeight;
          const animation = content.animate([{ opacity: 1, maxHeight: height + 'px' }, { opacity: 0, maxHeight: '0px' }], { duration: 170, easing: 'ease-in' });
          animation.onfinish = () => { details.open = false; };
        };
        document.addEventListener('click', (event) => {
          const action = event.target.closest('[data-share-root-action]')?.dataset?.shareRootAction;
          if (action) {
            channels().forEach((details) => animateChannel(details, action === 'expand-all'));
            return;
          }
          const summary = event.target.closest('.share-channel > summary');
          if (!summary) return;
          event.preventDefault();
          animateChannel(summary.parentElement, !summary.parentElement.open);
        });
      })();
    </script>
  `;
  return shareChromeHtml(
    { title: 'Team Shares', creator: { name: 'MagClaw' }, createdAt: '', hideChromeBrand: true },
    `${controls}${folders}${script}`,
  );
}

function shareRootWorkspaceId(state = {}) {
  return String(
    state.connection?.workspaceId
    || state.cloud?.workspace?.id
    || state.cloud?.workspaces?.[0]?.id
    || 'local',
  ).trim();
}

function shareRootPathWorkspaceId(url, state = {}) {
  const match = String(url?.pathname || '').match(/^\/s\/([^/]+)\/share\/?$/);
  if (!match) return '';
  const slug = decodeURIComponent(match[1] || '').trim();
  if (!slug) return '';
  const workspace = asArray(state.cloud?.workspaces).find((item) => (
    String(item.slug || '').trim() === slug
    || String(item.id || '').trim() === slug
  ));
  return String(workspace?.id || slug).trim();
}

function activeWorkspaceMemberForUser(state = {}, userId = '', workspaceId = '') {
  const cleanUserId = String(userId || '').trim();
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanUserId || !cleanWorkspaceId) return null;
  return asArray(state.cloud?.workspaceMembers).find((member) => (
    member
    && member.userId === cleanUserId
    && member.workspaceId === cleanWorkspaceId
    && (member.status || 'active') === 'active'
  )) || null;
}

function activeWorkspaceMemberForIdentity(state = {}, identity = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const ids = new Set([
    identity?.id,
    identity?.userId,
    identity?.humanId,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const email = String(identity?.email || '').trim().toLowerCase();
  if (!cleanWorkspaceId || (!ids.size && !email)) return null;
  return asArray(state.cloud?.workspaceMembers).find((member) => {
    if (!member || String(member.workspaceId || '').trim() !== cleanWorkspaceId) return false;
    if (String(member.status || 'active').trim() !== 'active') return false;
    const memberIds = [
      member.userId,
      member.humanId,
      member.id,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const memberEmail = String(member.email || '').trim().toLowerCase();
    return memberIds.some((id) => ids.has(id)) || Boolean(email && memberEmail === email);
  }) || null;
}

function workspaceByIdOrSlug(state = {}, value = '') {
  const clean = String(value || '').trim();
  if (!clean || clean === 'local') return null;
  const cloud = ensureCloudCollections(state);
  return asArray(cloud.workspaces).find((workspace) => (
    workspace
    && !workspace.deletedAt
    && (
      String(workspace.id || '').trim() === clean
      || String(workspace.slug || '').trim() === clean
    )
  )) || null;
}

function publicTeamSharingServer(state = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local') {
    return { id: cleanWorkspaceId || 'local', slug: 'local', name: 'Local' };
  }
  const workspace = workspaceByIdOrSlug(state, cleanWorkspaceId);
  return {
    id: String(workspace?.id || cleanWorkspaceId).trim(),
    slug: String(workspace?.slug || '').trim(),
    name: String(workspace?.name || workspace?.slug || workspace?.id || cleanWorkspaceId).trim(),
  };
}

function tokenWorkspaceAccess(state = {}, tokenRecord = null, workspaceId = '', error = '') {
  if (!tokenRecord) return null;
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const tokenWorkspaceId = String(tokenRecord.workspaceId || '').trim();
  const actorId = String(tokenRecord.user?.id || '').trim();
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local' || tokenWorkspaceId === cleanWorkspaceId) {
    return { ok: true, workspaceId: cleanWorkspaceId, actorId, via: 'token' };
  }
  const member = activeWorkspaceMemberForIdentity(state, tokenRecord.user || {}, cleanWorkspaceId);
  if (member) {
    return {
      ok: true,
      workspaceId: cleanWorkspaceId,
      actorId: String(member.humanId || member.userId || actorId || '').trim(),
      via: 'token_membership',
      member,
    };
  }
  return { ok: false, status: 403, workspaceId: cleanWorkspaceId, actorId, via: 'token', error };
}

function teamSharingServersForIdentity({ state = {}, actor = null, currentUser = null, tokenRecord = null } = {}) {
  const cloud = ensureCloudCollections(state);
  const currentWorkspaceId = String(tokenRecord?.workspaceId || actor?.member?.workspaceId || '').trim();
  const actorId = actor ? actorHumanId(actor) : '';
  const identity = {
    id: tokenRecord?.user?.id || actorId || currentUser?.id || actor?.user?.id || '',
    userId: currentUser?.id || actor?.user?.id || '',
    humanId: tokenRecord?.user?.id || actor?.member?.humanId || '',
    email: tokenRecord?.user?.email || currentUser?.email || actor?.member?.email || actor?.user?.email || '',
  };
  const byId = new Map();
  const addServer = (workspaceId, member = null) => {
    const cleanWorkspaceId = String(workspaceId || '').trim();
    if (!cleanWorkspaceId) return;
    const server = publicTeamSharingServer(state, cleanWorkspaceId);
    byId.set(server.id || cleanWorkspaceId, {
      ...server,
      role: String(member?.role || (server.id === currentWorkspaceId ? 'member' : '') || '').trim(),
      status: String(member?.status || 'active').trim(),
      current: (server.id || cleanWorkspaceId) === currentWorkspaceId,
    });
  };
  addServer(currentWorkspaceId, null);
  for (const member of asArray(cloud.workspaceMembers)) {
    if (!member || String(member.status || 'active').trim() !== 'active') continue;
    const matched = activeWorkspaceMemberForIdentity({ cloud: { workspaceMembers: [member] } }, identity, member.workspaceId);
    if (matched) addServer(member.workspaceId, member);
  }
  return [...byId.values()].filter((server) => server.id);
}

function browserWorkspaceAccess({ actor, currentUser, state, workspaceId = '', error = '' } = {}) {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const user = currentUser || actor?.user || null;
  const actorId = actor ? actorHumanId(actor) : '';
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local') {
    return actor || user
      ? { ok: true, workspaceId: cleanWorkspaceId, actorId: actorId || user?.id || '', via: actor ? 'actor' : 'user' }
      : null;
  }
  const actorWorkspaceId = String(actor?.member?.workspaceId || '').trim();
  if (actorWorkspaceId === cleanWorkspaceId) {
    return { ok: true, workspaceId: cleanWorkspaceId, actorId, via: 'actor' };
  }
  if (user?.id) {
    const member = activeWorkspaceMemberForUser(state, user.id, cleanWorkspaceId);
    if (member) {
      return {
        ok: true,
        workspaceId: cleanWorkspaceId,
        actorId: member.humanId || actorId || user.id,
        via: 'user',
      };
    }
    return {
      ok: false,
      status: 403,
      joinable: true,
      workspaceId: cleanWorkspaceId,
      actorId: actorId || user.id,
      error,
    };
  }
  if (actorWorkspaceId) {
    return { ok: false, status: 403, workspaceId: cleanWorkspaceId, actorId, error };
  }
  return null;
}

function shareRootAccess(req, { actor, currentUser, teamSharingState, state, targetWorkspaceId = '' } = {}) {
  const workspaceId = String(targetWorkspaceId || shareRootWorkspaceId(state)).trim();
  const browserAccess = browserWorkspaceAccess({
    actor,
    currentUser,
    state,
    workspaceId,
    error: 'This share root is only available to members of this server.',
  });
  if (browserAccess) return browserAccess;
  const tokenRecord = tokenRecordForRequest(teamSharingState, req);
  const tokenAccess = tokenWorkspaceAccess(state, tokenRecord, workspaceId, 'This share root is only available to members of this server.');
  if (tokenAccess) return tokenAccess;
  return { ok: false, status: 401, workspaceId, actorId: '', error: 'Sign in to MagClaw and join this server to open the share root.' };
}

function shareAccess(req, { actor, currentUser, teamSharingState, share, state } = {}) {
  const workspaceId = String(share?.workspaceId || '').trim();
  const browserAccess = browserWorkspaceAccess({
    actor,
    currentUser,
    state,
    workspaceId,
    error: 'This shared page is only available to members of this server.',
  });
  if (browserAccess) return browserAccess;
  const tokenRecord = tokenRecordForRequest(teamSharingState, req);
  const tokenAccess = tokenWorkspaceAccess(state, tokenRecord, workspaceId, 'This shared page is only available to members of this server.');
  if (tokenAccess) return tokenAccess;
  return { ok: false, status: 401, workspaceId, actorId: '', error: 'Sign in to MagClaw and join this server to open the shared page.' };
}

function sharesForShareRoot(teamSharingState = {}, workspaceId = '') {
  const shares = ensureTeamSharingShares(teamSharingState);
  const scope = String(workspaceId || '').trim();
  if (!scope || scope === 'local') return shares;
  return shares.filter((share) => String(share.workspaceId || '').trim() === scope);
}

function shareListWorkspaceIdFromUrl(url, state = {}) {
  const explicit = String(
    url?.searchParams?.get('workspaceId')
    || url?.searchParams?.get('serverId')
    || url?.searchParams?.get('serverSlug')
    || url?.searchParams?.get('server')
    || '',
  ).trim();
  if (!explicit) return '';
  return String(workspaceByIdOrSlug(state, explicit)?.id || explicit).trim();
}

function shareRootDeniedHtml(status = 401, message = '') {
  const title = status === 403 ? 'Server access required' : 'Sign in required';
  return shareChromeHtml(
    { title: 'Team Shares', creator: { name: 'MagClaw' }, createdAt: '' },
    `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(message || 'Join this server before opening the MagClaw share root.')}</p>`,
  );
}

function teamSharingWorkspaceFile(path = '', content = '', extra = {}) {
  const cleanPath = String(path || '').trim();
  const name = cleanPath.split('/').filter(Boolean).at(-1) || cleanPath;
  const previewKind = cleanPath.endsWith('.json') ? 'json' : 'markdown';
  return {
    path: cleanPath,
    name,
    kind: 'file',
    previewKind,
    bytes: Buffer.byteLength(String(content || ''), 'utf8'),
    content,
    ...extra,
  };
}

function normalizeTeamSharingWorkspaceFilePath(rawPath = '') {
  const raw = String(rawPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join('/');
}

function teamSharingWorkspaceFileByPath(workspace = {}, rawPath = '') {
  const cleanPath = normalizeTeamSharingWorkspaceFilePath(rawPath);
  if (!cleanPath) return null;
  return asArray(workspace.files).find((file) => String(file?.path || '').trim() === cleanPath) || null;
}

function teamSharingWorkspaceFolder(path = '', name = '') {
  const cleanPath = String(path || '').trim();
  return {
    path: cleanPath,
    name: name || cleanPath.split('/').filter(Boolean).at(-1) || cleanPath,
    kind: 'folder',
  };
}

function sourceContextUrlForEvent(sessionId = '', eventId = '') {
  const params = new URLSearchParams();
  if (eventId) params.set('anchorEventId', eventId);
  params.set('limit', '21');
  params.set('order', 'asc');
  return `/team-sharing/context/${encodeURIComponent(sessionId)}${params.toString() ? `?${params.toString()}` : ''}`;
}

function workspaceSourceEventId(markdown = '', fallbackIds = []) {
  const text = String(markdown || '');
  const rawIdMatch = text.match(/(?:^|\n)\s*(?:[-*+]\s+)?Raw ID[:：]\s*`?([^\s`]+)`?/i);
  if (rawIdMatch?.[1]) return rawIdMatch[1];
  const contextLinkMatch = text.match(/\/team-sharing\/context\/[^)\s?]+[^)\s]*[?&]anchorEventId=([^&)\s]+)/);
  if (contextLinkMatch?.[1]) {
    try {
      return decodeURIComponent(contextLinkMatch[1]);
    } catch {
      return contextLinkMatch[1];
    }
  }
  return asArray(fallbackIds).map((item) => String(item || '').trim()).find(Boolean) || '';
}

function stripWorkspaceSourceBlocks(markdown = '') {
  return String(markdown || '').split('\n').filter((line) => {
    const text = line.trim();
    if (!text) return true;
    if (/^(?:[-*+]\s+)?Raw ID[:：]/i.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*$/.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*暂无可定位原文/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[打开原文\]\(/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[围绕首条来源打开\]\(/.test(text)) return false;
    return true;
  }).join('\n');
}

function appendWorkspaceInlineSource(markdown = '', sessionId = '', sourceEventId = '') {
  const eventId = String(sourceEventId || '').trim();
  if (!eventId || /\[原文\]\(\/team-sharing\/context\//.test(markdown)) return markdown;
  const suffix = `（[原文](${sourceContextUrlForEvent(sessionId, eventId)})）`;
  const lines = String(markdown || '').split('\n');
  const index = lines.findIndex((line) => {
    const text = line.trim();
    return text
      && !/^#+\s+/.test(text)
      && !/^```/.test(text)
      && !/^\[.+\]\(/.test(text);
  });
  if (index >= 0) lines[index] = `${lines[index]}${suffix}`;
  return lines.join('\n');
}

function normalizeWorkspaceMarkdownSources(markdown = '', { sessionId = '', sourceEventIds = [] } = {}) {
  const sourceEventId = workspaceSourceEventId(markdown, sourceEventIds);
  const stripped = stripWorkspaceSourceBlocks(markdown).replace(/\n{3,}/g, '\n\n').trimEnd();
  return appendWorkspaceInlineSource(stripped, sessionId, sourceEventId);
}

function buildTeamSharingWorkspace(teamSharingState = {}, sessionId = '') {
  const session = teamSharingState.sessions?.[sessionId];
  const abstract = teamSharingState.abstracts?.[sessionId];
  if (!session || !abstract) return null;
  const events = asArray(teamSharingState.events?.[sessionId])
    .slice()
    .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const activities = asArray(teamSharingState.activities)
    .filter((activity) => activity.sessionId === sessionId)
    .slice()
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  const topics = Object.values(abstract.topics || {})
    .sort((left, right) => String(left.title || left.topicId || '').localeCompare(String(right.title || right.topicId || '')));
  const activitiesJson = JSON.stringify(activities.map((activity) => ({
    activityId: activity.activityId || '',
    sessionId: activity.sessionId || sessionId,
    revision: activity.revision || 0,
    action: activity.action || 'merge_summary',
    summary: activity.summary || '',
    changedPaths: asArray(activity.changedPaths),
    sourceEventIds: asArray(activity.sourceEventIds),
    createdAt: activity.createdAt || '',
  })), null, 2);
  const abstractMarkdown = normalizeWorkspaceMarkdownSources(abstract.abstractMarkdown || '', {
    sessionId,
    sourceEventIds: asArray(abstract.sourceEventIds),
  });
  const files = [
    teamSharingWorkspaceFile('abstract.md', abstractMarkdown),
    teamSharingWorkspaceFile('debug-log.md', abstract.debugLogMarkdown || [
      `# ${session.title || 'Team Sharing Session'} Debug Log`,
      '',
      'No sync log entries yet.',
    ].join('\n')),
    teamSharingWorkspaceFile('activities.json', activitiesJson, { previewKind: 'json' }),
    ...topics.map((topic) => {
      const sourceEventIds = asArray(topic.sourceEventIds);
      const markdown = normalizeWorkspaceMarkdownSources(
        topic.overviewMarkdown || `# ${topic.title || topic.topicId}\n\n${topic.overview || ''}`,
        { sessionId, sourceEventIds },
      );
      return teamSharingWorkspaceFile(`topics/${topic.topicId}.md`, markdown, {
        topicId: topic.topicId,
        sourceEventIds,
      });
    }),
  ];
  const folders = [
    teamSharingWorkspaceFolder('topics', 'topics'),
  ];
  return {
    ok: true,
    session: {
      sessionId,
      messageId: session.messageId || '',
      title: session.title || '',
      runtime: session.runtime || '',
      projectKey: session.projectKey || '',
      workspaceId: session.workspaceId || '',
      channelId: session.channelId || '',
      abstractRevision: session.abstractRevision || abstract.revision || 0,
      indexStatus: session.indexStatus || '',
      updatedAt: abstract.updatedAt || session.updatedAt || '',
      eventCount: events.length,
      activityCount: activities.length,
      topicCount: topics.length,
    },
    tree: [
      teamSharingWorkspaceFile('abstract.md', '', { bytes: files.find((file) => file.path === 'abstract.md')?.bytes || 0, content: undefined }),
      teamSharingWorkspaceFile('debug-log.md', '', { bytes: files.find((file) => file.path === 'debug-log.md')?.bytes || 0, content: undefined }),
      teamSharingWorkspaceFile('activities.json', '', { bytes: files.find((file) => file.path === 'activities.json')?.bytes || 0, content: undefined, previewKind: 'json' }),
      folders[0],
      ...topics.map((topic) => teamSharingWorkspaceFile(`topics/${topic.topicId}.md`, '', {
        bytes: files.find((file) => file.path === `topics/${topic.topicId}.md`)?.bytes || 0,
        content: undefined,
      })),
    ],
    files,
    activities,
  };
}

function teamSharingHumanById(state = {}, id = '') {
  const target = String(id || '').trim();
  if (!target) return null;
  return asArray(state.humans).find((human) => (
    String(human?.id || '') === target
    || String(human?.authUserId || '') === target
    || String(human?.cloudMemberId || '') === target
  )) || null;
}

function latestTeamSharingHumanActor(state = {}, uploader = {}) {
  const uploaderId = String(uploader?.id || uploader?.humanId || '').trim();
  const human = teamSharingHumanById(state, uploaderId);
  return {
    id: human?.id || uploaderId,
    name: human?.name || uploader?.name || 'User',
    avatar: human?.avatar || human?.avatarUrl || uploader?.avatar || '',
    email: human?.email || uploader?.email || '',
    type: 'human',
  };
}

function teamSharingRuntimeActor(runtime = '') {
  const clean = String(runtime || '').trim().toLowerCase();
  if (clean === 'claude_code' || clean === 'claude-code' || clean === 'claude') {
    return { type: 'runtime', id: 'claude_code', runtime: 'claude_code', name: 'ClaudeCode' };
  }
  if (clean === 'codex') return { type: 'runtime', id: 'codex', runtime: 'codex', name: 'Codex' };
  return { type: 'runtime', id: clean || 'assistant', runtime: clean || 'assistant', name: clean || 'Assistant' };
}

function enrichTeamSharingContextResult(result = {}, state = {}) {
  if (!result?.ok) return result;
  const sessionUploader = latestTeamSharingHumanActor(state, result.session?.uploader || {});
  const session = {
    ...(result.session || {}),
    uploader: sessionUploader,
  };
  const runtimeActor = teamSharingRuntimeActor(session.runtime);
  return {
    ...result,
    session,
    events: asArray(result.events).map((event) => {
      if (event?.role === 'user') {
        const actor = latestTeamSharingHumanActor(state, event.metadata?.uploader || sessionUploader);
        return {
          ...event,
          actor,
          metadata: {
            ...(event.metadata || {}),
            uploader: actor,
          },
        };
      }
      if (event?.role === 'assistant' || event?.role === 'system') {
        return { ...event, actor: runtimeActor };
      }
      return event;
    }),
  };
}

function teamSharingWorkspaceAccessResult({ actor, currentUser, state, tokenRecord, session } = {}) {
  const sessionWorkspaceId = String(session?.workspaceId || '').trim();
  const browserAccess = browserWorkspaceAccess({
    actor,
    currentUser,
    state,
    workspaceId: sessionWorkspaceId,
    error: 'This Team Sharing context belongs to another server.',
  });
  if (browserAccess) return browserAccess;
  const tokenAccess = tokenWorkspaceAccess(state, tokenRecord, sessionWorkspaceId, 'This Team Sharing context belongs to another server.');
  if (tokenAccess) return tokenAccess;
  return {
    ok: !sessionWorkspaceId || sessionWorkspaceId === 'local',
    status: 401,
    workspaceId: sessionWorkspaceId,
    actorId: '',
    error: 'Sign in to MagClaw and join this server to open the Team Sharing context.',
  };
}

function teamSharingWorkspaceAccess(args = {}) {
  return teamSharingWorkspaceAccessResult(args).ok;
}

function sendContextHtml(res, {
  sessionId = '',
  anchorEventId = '',
  vectorDocumentId = '',
  queryId = '',
  sourceRef = '',
  order = 'asc',
  workspaceId = '',
  serverSlug = '',
} = {}) {
  const safeSession = encodeURIComponent(sessionId);
  const initialAnchor = String(anchorEventId || '');
  const contextOrder = String(order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const isDesc = contextOrder === 'desc';
  const contextWorkspaceId = String(workspaceId || '').trim();
  const contextServerSlug = String(serverSlug || '').trim();
  const iconRegistryJson = scriptJson(TEAM_SHARING_COMMON_LINK_ICONS);
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MagClaw Team Sharing Context</title>
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#64748b; --line:#d7dee8; --bg:#f8fafc; --accent:#0891b2; --chip:#e0f2fe; --user-bg:#fff7ed; --user-line:#fed7aa; --user-accent:#f97316; --user-ink:#9a3412; --plan-bg:#f3f4f6; --plan-line:#d1d5db; --plan-accent:#6b7280; --goal-bg:#f0fdf4; --goal-line:#bbf7d0; --goal-accent:#16a34a; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:16px 20px; border-bottom:1px solid var(--line); background:rgba(248,250,252,.94); backdrop-filter: blur(14px); }
    h1 { margin:0; font-size:20px; letter-spacing:0; line-height:1.28; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    main { max-width:920px; margin:0 auto; padding:18px; }
    .controls { display:flex; gap:10px; justify-content:center; margin:12px 0; }
    button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 12px; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .scroll-sentinel { height:1px; }
    article.context-event { position:relative; background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:10px 0; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    article.context-event-agent.has-context-note { overflow:visible; }
    article.context-event-user { background:var(--user-bg); border-color:var(--user-line); }
    article.context-event-user .role { border:1px solid #fdba74; background:#ffedd5; color:var(--user-ink); }
    article.context-event-user .context-avatar { border-color:#fdba74; background:#fff7ed; color:var(--user-ink); }
    article.context-event.anchor { border-color:var(--accent); box-shadow:0 0 0 2px rgba(8,145,178,.12); }
    .context-event-head { display:flex; align-items:center; gap:10px; min-width:0; }
    .context-event-meta { display:flex; align-items:center; flex-wrap:wrap; gap:0; min-width:0; }
    .context-avatar { display:grid; place-items:center; width:32px; height:32px; flex:0 0 32px; overflow:hidden; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#0f172a; font-size:11px; font-weight:900; line-height:1; }
    .context-avatar img,
    .context-avatar svg { display:block; width:100%; height:100%; object-fit:cover; }
    .context-avatar-codex { background:#fff; border-color:#d9d9f6; }
    .context-avatar-claude { background:#f8f3ed; border-color:#d6b49c; }
    .role { display:inline-flex; align-items:center; min-height:20px; border-radius:999px; background:var(--chip); padding:2px 8px; font-size:12px; font-weight:800; color:#0f5f76; }
    .time { margin-left:8px; color:var(--muted); font-size:12px; }
    .context-goal-badge { display:inline-flex; align-items:center; gap:5px; flex:0 0 auto; min-height:22px; margin-left:auto; border:1px solid #bfdbfe; border-radius:999px; background:#eff6ff; color:#1d4ed8; padding:2px 8px 2px 6px; font-size:11px; font-weight:900; line-height:1; }
    .context-goal-logo { position:relative; width:15px; height:15px; border-radius:999px; background:radial-gradient(circle, #2563eb 0 2px, #eff6ff 2.5px 4px, #60a5fa 4.5px 5.8px, transparent 6.2px 100%); box-shadow:inset 0 0 0 1px #93c5fd; }
    .context-goal-logo::before,
    .context-goal-logo::after { content:""; position:absolute; left:50%; top:50%; background:#1d4ed8; opacity:.82; transform:translate(-50%, -50%); }
    .context-goal-logo::before { width:11px; height:1px; }
    .context-goal-logo::after { width:1px; height:11px; }
    .text,
    .context-main { overflow-wrap:anywhere; line-height:1.65; font-size:14px; }
    .text { margin-top:10px; }
    .context-segments { display:grid; gap:9px; margin-top:10px; }
    .context-quote { border-left:3px solid #9ecfe1; background:#f2f8fb; color:#3f6474; padding:8px 11px; border-radius:0 7px 7px 0; display:grid; gap:4px; }
    .context-quote-label { color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-quote-text { overflow-wrap:anywhere; line-height:1.56; font-size:13px; }
    .context-mode-panel { margin-top:10px; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:12px 13px; display:grid; gap:8px; overflow-wrap:anywhere; }
    .context-plan-panel { background:var(--plan-bg); border-color:var(--plan-line); border-left-color:var(--plan-accent); color:#1f2937; box-shadow:inset 0 1px 0 rgba(255,255,255,.72); }
    .context-goal-panel { background:#f0fdf4; border-color:#bbf7d0; border-left-color:#16a34a; }
    .context-interaction-panel { background:#fff; border-color:#dbe5ef; border-left-color:#0891b2; }
    .context-mode-head { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#334155; font-size:11px; font-weight:900; line-height:1.2; text-transform:uppercase; letter-spacing:0; }
    .context-plan-panel .context-mode-head { color:#374151; }
    .context-goal-panel .context-mode-head { color:#166534; }
    .context-goal-status { color:#16a34a; font-weight:900; }
    .context-interaction-list { display:grid; gap:10px; }
    .context-question-card { display:grid; gap:7px; border:1px solid #e2e8f0; border-radius:7px; padding:10px 11px; background:#fbfdff; }
    .context-question-head { color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-question-prompt { margin:0; font-size:14px; font-weight:750; line-height:1.52; color:#1f2937; }
    .context-option-list,
    .context-answer-list { display:flex; flex-wrap:wrap; gap:6px; }
    .context-answer-list { align-items:center; }
    .context-answer-item { display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px; max-width:100%; }
    .context-option-chip,
    .context-answer-chip { display:inline-flex; align-items:center; max-width:100%; min-height:24px; border-radius:999px; padding:2px 8px; font-size:12px; font-weight:800; line-height:1.35; overflow-wrap:anywhere; }
    .context-option-chip { border:1px solid #dbeafe; background:#f8fafc; color:#475569; }
    .context-answer-chip { border:1px solid #bae6fd; background:#e0f2fe; color:#075985; }
    .context-answer-description { display:inline-flex; align-items:center; max-width:100%; border-radius:5px; padding:2px 6px; background:#f1f5f9; color:#475569; font-size:12px; font-weight:700; line-height:1.4; overflow-wrap:anywhere; }
    .context-main a,
    .context-quote a,
    .text a { color:#0369a1; font-weight:700; }
    .context-main a,
    .context-quote a,
    .text a,
    .context-source-link { display:inline-flex; align-items:center; gap:4px; vertical-align:baseline; }
    .context-file-ref { display:inline-flex; align-items:center; max-width:100%; border-radius:5px; padding:1px 5px; background:#eef2f7; color:#334155; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; font-weight:700; line-height:1.35; overflow-wrap:anywhere; }
    .context-link-icon { display:inline-grid; place-items:center; width:16px; height:16px; flex:0 0 16px; border:1px solid #dbe5ef; border-radius:4px; background:#fff; color:#334155; overflow:hidden; font-size:7px; font-weight:900; line-height:1; text-transform:uppercase; }
    .context-link-icon-img { display:block; width:12px; height:12px; object-fit:contain; }
    .context-link-icon-fallback { display:inline-grid; place-items:center; width:100%; height:100%; padding-top:1px; }
    .context-link-label { min-width:0; }
    .context-color-swatch { display:inline-block; width:10px; height:10px; margin-left:4px; border:1px solid rgba(15,23,42,.24); border-radius:3px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.56); vertical-align:-1px; }
    .text p,
    .context-main p,
    .context-quote-text p { margin:0 0 10px; }
    .text p:last-child,
    .context-main p:last-child,
    .context-quote-text p:last-child { margin-bottom:0; }
    .text ul,
    .text ol,
    .context-main ul,
    .context-main ol,
    .context-quote-text ul,
    .context-quote-text ol { margin:8px 0 10px; padding-left:24px; }
    .text li,
    .context-main li,
    .context-quote-text li { margin:4px 0; }
    .text code,
    .context-main code,
    .context-quote-text code { background:#eef2f7; border-radius:5px; padding:1px 5px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; color:#243244; }
    .text pre,
    .context-main pre,
    .context-quote-text pre { margin:10px 0; padding:10px 12px; overflow:auto; background:#0f172a; color:#e2e8f0; border-radius:7px; }
    .text pre code,
    .context-main pre code,
    .context-quote-text pre code { background:transparent; color:inherit; padding:0; border-radius:0; }
    .text h1,
    .text h2,
    .text h3,
    .context-main h1,
    .context-main h2,
    .context-main h3 { margin:0 0 10px; font-size:16px; line-height:1.45; }
    .text blockquote,
    .context-main blockquote,
    .context-quote-text blockquote { margin:8px 0; border-left:3px solid #cbd5e1; padding-left:10px; color:#475569; }
    .context-plan-panel .context-main { color:#1f2937; }
    .context-plan-panel .context-main code { background:#e5e7eb; color:#374151; }
    .context-plan-panel .context-main pre { background:#f9fafb; color:#1f2937; border:1px solid #d1d5db; }
    .context-plan-panel .context-main a { color:#2563eb; }
    .context-plan-panel .context-main blockquote { border-left-color:#9ca3af; color:#4b5563; }
    .context-plan-panel .context-color-swatch { border-color:rgba(31,41,55,.28); box-shadow:inset 0 0 0 1px rgba(255,255,255,.56); }
    .context-table-wrap { width:100%; overflow-x:auto; margin:10px 0 12px; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .context-table { width:100%; border-collapse:collapse; min-width:520px; font-size:13px; line-height:1.55; }
    .context-table th { text-align:left; background:#f1f5f9; color:#334155; font-weight:850; border-bottom:1px solid var(--line); }
    .context-table th,
    .context-table td { padding:9px 11px; vertical-align:top; border-right:1px solid #e5edf4; }
    .context-table th:last-child,
    .context-table td:last-child { border-right:0; }
    .context-table tr + tr td { border-top:1px solid #edf2f7; }
    .context-table tr:hover td { background:#fbfdff; }
    .context-sources { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin:10px 0 0; color:var(--muted); font-size:13px; }
    .context-sources-label { font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:0; color:#0f6f89; }
    .context-source-link { min-height:24px; border:1px solid #bae6fd; background:#f0f9ff; color:#0369a1; border-radius:999px; padding:2px 8px; font-weight:800; text-decoration:none; }
    .context-source-link:hover,
    .context-source-link:focus-visible { border-color:#0891b2; background:#e0f2fe; outline:0; }
    .context-note { position:absolute; left:calc(100% + 14px); top:88px; z-index:1; width:264px; min-height:118px; padding:18px 20px 17px; overflow:visible; border:1px solid #c7dde8; border-radius:4px; background:#f7fbfd; color:#334155; box-shadow:0 14px 28px rgba(15,23,42,.10), 0 1px 0 rgba(255,255,255,.82) inset; opacity:0; transform-origin:left top; transform:translate(-10px,-8px) scale(.74) rotate(-2deg); clip-path:polygon(0 0, 0 0, 0 0, 0 0); pointer-events:none; }
    .context-note::before { content:""; position:absolute; left:50%; top:-10px; width:58px; height:18px; transform:translateX(-50%) rotate(-2deg); border:1px solid rgba(8,145,178,.18); border-radius:3px; background:rgba(224,242,254,.78); box-shadow:0 2px 5px rgba(71,85,105,.08); }
    .context-note::after { content:""; position:absolute; right:0; bottom:0; width:28px; height:28px; border-radius:4px 0 3px 0; background:linear-gradient(135deg, rgba(255,255,255,0) 0 49%, rgba(203,226,236,.55) 50%, rgba(240,249,255,.96) 100%); }
    .context-note.is-open { pointer-events:auto; animation:contextNoteUnfold .34s cubic-bezier(.2,.8,.22,1) forwards; }
    .context-note-label { margin:0 0 8px; color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-note-body { max-height:min(520px, calc(100vh - 180px)); overflow:auto; padding-right:4px; font-size:13px; font-weight:600; line-height:1.52; }
    .context-note-body p,
    .context-note-body ul,
    .context-note-body ol,
    .context-note-body blockquote,
    .context-note-body pre { margin:0 0 8px; }
    .context-note-body p:last-child,
    .context-note-body ul:last-child,
    .context-note-body ol:last-child,
    .context-note-body blockquote:last-child,
    .context-note-body pre:last-child { margin-bottom:0; }
    .context-note-body ul,
    .context-note-body ol { padding-left:18px; }
    .context-note-body li { margin:3px 0; }
    .context-note-body strong { color:#172033; font-weight:850; }
    .context-note-body code { background:#eef2f7; border-radius:4px; padding:1px 4px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; color:#243244; }
    .context-note-body a { color:#0369a1; font-weight:800; }
    .context-note-body h1,
    .context-note-body h2,
    .context-note-body h3 { margin:0 0 8px; color:#172033; font-size:13px; line-height:1.35; }
    .context-status { min-height:20px; text-align:center; color:var(--muted); font-size:12px; margin:-4px 0 10px; }
    .empty { color:var(--muted); text-align:center; padding:48px 0; }
    @keyframes contextNoteUnfold {
      0% { opacity:0; transform:translate(-10px,-8px) scale(.74) rotate(-2deg); clip-path:polygon(0 0, 0 0, 0 0, 0 0); }
      62% { opacity:1; transform:translate(-2px,-2px) scale(1.02) rotate(-.4deg); clip-path:polygon(0 0, 100% 0, 82% 100%, 0 76%); }
      100% { opacity:1; transform:translate(0,0) scale(1) rotate(0); clip-path:polygon(0 0, 100% 0, 100% 100%, 0 100%); }
    }
    @media (max-width:1240px) {
      .context-note { position:sticky; left:auto; top:104px; width:min(100%, 430px); margin:12px 0 14px 0; transform:translate(-6px,-6px) scale(.84) rotate(-1deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .context-note,
      .context-note.is-open { opacity:1; transform:none; clip-path:polygon(0 0, 100% 0, 100% 100%, 0 100%); animation:none; }
    }
  </style>
</head>
<body>
  <header>
    <h1 id="session-title">MagClaw Team Sharing Context</h1>
    <div class="meta" id="session-meta">session: ${htmlEscape(sessionId)} · anchor: ${htmlEscape(initialAnchor || 'latest')} · order: ${htmlEscape(contextOrder === 'desc' ? 'newest first' : 'oldest first')}</div>
  </header>
  <main>
    <div id="top-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
    <div class="controls" hidden><button id="${isDesc ? 'load-more-next' : 'load-more-prev'}" type="button" hidden>${isDesc ? 'Load newer' : 'Load previous'}</button></div>
    <section id="events" aria-live="polite"><div class="empty">Loading context...</div></section>
    <div class="controls" hidden><button id="${isDesc ? 'load-more-prev' : 'load-more-next'}" type="button" hidden>${isDesc ? 'Load older' : 'Load next'}</button></div>
    <div id="context-status" class="context-status" aria-live="polite"></div>
    <div id="bottom-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
  </main>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    let anchorEventId = ${JSON.stringify(initialAnchor)};
    const order = ${JSON.stringify(contextOrder)};
    const vectorDocumentId = ${JSON.stringify(String(vectorDocumentId || ''))};
    const queryId = ${JSON.stringify(String(queryId || ''))};
    const sourceRef = ${JSON.stringify(String(sourceRef || ''))};
    const CONTEXT_LINK_ICON_REGISTRY = ${iconRegistryJson};
    const workspaceId = ${JSON.stringify(contextWorkspaceId)};
    const serverSlug = ${JSON.stringify(contextServerSlug)};
    const eventsEl = document.getElementById('events');
    const prevBtn = document.getElementById('load-more-prev');
    const nextBtn = document.getElementById('load-more-next');
    const statusEl = document.getElementById('context-status');
    const topSentinel = document.getElementById('top-sentinel');
    const bottomSentinel = document.getElementById('bottom-sentinel');
    const topDirection = order === 'desc' ? 'next' : 'prev';
    const bottomDirection = order === 'desc' ? 'prev' : 'next';
    const seen = new Set();
    let prevAnchor = anchorEventId;
    let nextAnchor = anchorEventId;
    let hasPrev = false;
    let hasNext = false;
    let initialLoaded = false;
    let initialAnchorScrolled = false;
    const loading = { around: false, prev: false, next: false };
    let scrollCheckTimer = null;
    let openedRecorded = false;
    function escapeHtml(text) {
      return String(text || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    }
    function splitAutolinkUrl(raw) {
      let href = String(raw || '');
      let trailing = '';
      const trailingUrlChars = new Set([String.fromCharCode(96), "'", '"', ']', ')', ',', '.', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？']);
      while (trailingUrlChars.has(href.slice(-1))) {
        trailing = href.slice(-1) + trailing;
        href = href.slice(0, -1);
      }
      return { href, trailing };
    }
    function stripContextMetadata(text) {
      return String(text || '')
        .replace(/\\s*<oai-mem-citation\\b[^>]*>[\\s\\S]*?(?:<\\/oai-mem-citation>|$)\\s*/gi, '\\n')
        .replace(/\\s*<citation_entries\\b[^>]*>[\\s\\S]*?(?:<\\/citation_entries>|$)\\s*/gi, '\\n')
        .replace(/\\s*<rollout_ids\\b[^>]*>[\\s\\S]*?(?:<\\/rollout_ids>|$)\\s*/gi, '\\n')
        .replace(/\\s*::git-[a-z-]+\\{[^}\\n]*\\}\\s*/gi, '\\n')
        .trim();
    }
    function isContextWebHref(href) {
      const value = String(href || '').replace(/&amp;/gi, '&').trim();
      if (/^(https?:|mailto:)/i.test(value)) return true;
      if (value.startsWith('/team-sharing/') || value.startsWith('/share/')) return true;
      if (/^\\/s\\/[^/]+\\/(?:team-sharing|share)(?:\\/|$)/.test(value)) return true;
      return false;
    }
    function safeContextHref(href) {
      const value = String(href || '').replace(/&amp;/gi, '&').trim();
      return isContextWebHref(value) ? value : '';
    }
    function contextReferenceHtml(label, className = '') {
      const classes = ['context-file-ref', className].filter(Boolean).join(' ');
      return '<span class="' + escapeHtml(classes) + '">' + escapeHtml(label || '') + '</span>';
    }
    function renderContextAutolinkedUrls(html) {
      return String(html || '').replace(/https?:\\/\\/[^\\s<]+/g, raw => {
        const parts = splitAutolinkUrl(raw);
        if (!parts.href) return raw;
        return contextLinkHtml(parts.href, parts.href) + escapeHtml(parts.trailing);
      });
    }
    function contextHostForHref(href) {
      const match = String(href || '').match(/^https?:\\/\\/([^\\/?#]+)/i);
      return match ? match[1].replace(/^www\\./i, '').toLowerCase() : '';
    }
    function contextLinkIconEntryForHost(host) {
      const cleanHost = String(host || '').replace(/^www\\./i, '').toLowerCase();
      if (!cleanHost) return null;
      return CONTEXT_LINK_ICON_REGISTRY.find(entry => {
        const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
        return hosts.some(item => cleanHost === item || cleanHost.endsWith('.' + item));
      }) || null;
    }
    function contextLinkIconSrc(entry) {
      if (!entry) return '';
      const slug = String(entry.slug || '').trim();
      if (slug) return 'https://cdn.simpleicons.org/' + encodeURIComponent(slug);
      const iconHost = String(entry.iconHost || (Array.isArray(entry.hosts) ? entry.hosts[0] : '') || '').trim();
      return iconHost ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(iconHost) + '&sz=32' : '';
    }
    function contextLinkIconHtml(href) {
      const host = contextHostForHref(href);
      if (!host) return '';
      const entry = contextLinkIconEntryForHost(host);
      const label = String(entry?.label || host.slice(0, 1).toUpperCase() || '?').slice(0, 4);
      const title = entry?.name || host || 'Link';
      const src = contextLinkIconSrc(entry);
      if (!src) {
        return '<span class="context-link-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><span class="context-link-icon-fallback">' + escapeHtml(label) + '</span></span>';
      }
      return '<span class="context-link-icon" title="' + escapeHtml(title) + '" aria-hidden="true">' +
        '<img class="context-link-icon-img" src="' + escapeHtml(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' +
        '<span class="context-link-icon-fallback" hidden>' + escapeHtml(label) + '</span></span>';
    }
    function contextLinkHtml(href, label, className = '') {
      const safeHref = safeContextHref(href);
      if (!safeHref) return contextReferenceHtml(label || href, className);
      const classAttr = className ? ' class="' + escapeHtml(className) + '"' : '';
      const icon = safeHref ? contextLinkIconHtml(safeHref) : '';
      return '<a' + classAttr + ' href="' + escapeHtml(safeHref) + '" target="_blank" rel="noreferrer">' +
        icon + '<span class="context-link-label">' + escapeHtml(label || safeHref) + '</span></a>';
    }
    function isContextHexColorToken(value) {
      return /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(String(value || '').trim());
    }
    function contextColorSwatchHtml(value) {
      const color = String(value || '').trim();
      if (!isContextHexColorToken(color)) return '';
      const safeColor = escapeHtml(color);
      return '<span class="context-color-swatch" style="background-color: ' + safeColor + '" title="' + safeColor + '" aria-label="Color ' + safeColor + '"></span>';
    }
    function renderContextColorSwatches(html) {
      return String(html || '').replace(/(^|[^\\w/?:#&=.%+-])(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)(?![\\w-])/g, (_match, prefix, color) => prefix + color + contextColorSwatchHtml(color));
    }
    function renderContextInline(text) {
      const protectedTokens = [];
      const protect = (html) => {
        const marker = 'CTXINLINE' + protectedTokens.length + 'TOKEN';
        protectedTokens.push(html);
        return marker;
      };
      const tick = String.fromCharCode(96);
      const codePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
      let html = escapeHtml(text)
        .replace(codePattern, (_match, code) => protect('<code>' + code + '</code>' + contextColorSwatchHtml(code)))
        .replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, (_match, label, href) => protect(contextLinkHtml(href, label)))
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      html = renderContextColorSwatches(html);
      html = renderContextAutolinkedUrls(html);
      protectedTokens.forEach((token, index) => {
        html = html.replaceAll('CTXINLINE' + index + 'TOKEN', token);
      });
      return html;
    }
    function markdownLinksFromLine(line) {
      const links = [];
      String(line || '').replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, (_match, label, href) => {
        links.push({ label: String(label || '').trim(), href: String(href || '').trim() });
        return '';
      });
      return links;
    }
    function renderContextSourcesLine(line) {
      const match = String(line || '').trim().match(/^Sources?\\s*:\\s*(.+)$/i);
      if (!match) return '';
      const links = markdownLinksFromLine(match[1]);
      if (!links.length) {
        return '<p class="context-sources"><span class="context-sources-label">Sources</span><span>' + renderContextInline(match[1]) + '</span></p>';
      }
      return '<p class="context-sources"><span class="context-sources-label">Sources</span>' +
        links.map(link => contextLinkHtml(link.href, link.label || link.href, 'context-source-link')).join('') +
        '</p>';
    }
    function isContextTableCandidate(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed || !trimmed.includes('|')) return false;
      return trimmed.startsWith('|') || trimmed.endsWith('|') || (trimmed.match(/\\|/g) || []).length >= 2;
    }
    function isContextTableSeparatorRow(cells) {
      return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(String(cell || '').trim()));
    }
    function splitContextTableRow(row) {
      let text = String(row || '').trim();
      if (text.startsWith('|')) text = text.slice(1);
      if (text.endsWith('|')) text = text.slice(0, -1);
      return text.split('|').map(cell => cell.trim());
    }
    function renderContextTable(lines) {
      const rows = lines.map(splitContextTableRow).filter(row => row.length > 1);
      const separatorIndex = rows.findIndex((row, index) => index > 0 && isContextTableSeparatorRow(row));
      if (separatorIndex <= 0 || !rows[0]) {
        return lines.map(line => '<p>' + renderContextInline(line) + '</p>').join('');
      }
      const columnCount = Math.max(...rows.map(row => row.length));
      const normalizeRow = (row) => Array.from({ length: columnCount }, (_item, index) => row[index] || '');
      const header = normalizeRow(rows[0]);
      const bodyRows = rows.slice(separatorIndex + 1)
        .filter(row => !isContextTableSeparatorRow(row))
        .map(normalizeRow);
      return '<div class="context-table-wrap"><table class="context-table"><thead><tr>' +
        header.map(cell => '<th>' + renderContextInline(cell) + '</th>').join('') +
        '</tr></thead><tbody>' +
        bodyRows.map(row => '<tr>' + row.map(cell => '<td>' + renderContextInline(cell) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    function renderContextList(lines) {
      const tag = /^\\s*\\d+\\./.test(lines[0] || '') ? 'ol' : 'ul';
      return '<' + tag + '>' + lines.map(line => {
        const item = String(line || '').replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+/, '');
        return '<li>' + renderContextInline(item) + '</li>';
      }).join('') + '</' + tag + '>';
    }
        function renderContextMarkdown(text) {
          const lines = stripContextMetadata(text).split(/\\r?\\n/);
          const fence = String.fromCharCode(96).repeat(3);
      const blocks = [];
      let paragraph = [];
      let listLines = [];
      let tableLines = [];
      let inCode = false;
      let codeLines = [];
      const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push('<p>' + renderContextInline(paragraph.join(' ')) + '</p>');
        paragraph = [];
      };
      const flushList = () => {
        if (!listLines.length) return;
        blocks.push(renderContextList(listLines));
        listLines = [];
      };
      const flushTable = () => {
        if (!tableLines.length) return;
        blocks.push(renderContextTable(tableLines));
        tableLines = [];
      };
      for (const line of lines) {
        if (String(line || '').startsWith(fence)) {
          if (inCode) {
            blocks.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
            codeLines = [];
            inCode = false;
          } else {
            flushParagraph();
            flushList();
            flushTable();
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        if (!line.trim()) {
          flushParagraph();
          flushList();
          flushTable();
          continue;
        }
        const sourcesHtml = renderContextSourcesLine(line);
        if (sourcesHtml) {
          flushParagraph();
          flushList();
          flushTable();
          blocks.push(sourcesHtml);
          continue;
        }
        if (isContextTableCandidate(line)) {
          flushParagraph();
          flushList();
          tableLines.push(line);
          continue;
        }
        const heading = line.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          flushParagraph();
          flushList();
          flushTable();
          const level = Math.min(6, heading[1].length);
          blocks.push('<h' + level + '>' + renderContextInline(heading[2]) + '</h' + level + '>');
          continue;
        }
        if (/^\\s*(?:[-*+]|\\d+\\.)\\s+/.test(line)) {
          flushParagraph();
          flushTable();
          listLines.push(line);
          continue;
        }
        const quote = line.match(/^>\\s?(.+)$/);
        if (quote) {
          flushParagraph();
          flushList();
          flushTable();
          blocks.push('<blockquote>' + renderContextInline(quote[1]) + '</blockquote>');
          continue;
        }
        flushTable();
        paragraph.push(line.trim());
      }
      if (inCode) blocks.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
      flushParagraph();
      flushList();
          flushTable();
          return blocks.join('') || '<p>' + renderContextInline(text) + '</p>';
        }
        const CONTEXT_NOTE_MIN_CHARS = 1200;
        const CONTEXT_NOTE_MAX_CHARS = 1000;
        function contextEventBodyText(event) {
          const segments = Array.isArray(event?.contentSegments) && event.contentSegments.length
            ? event.contentSegments
            : (Array.isArray(event?.metadata?.contentSegments) ? event.metadata.contentSegments : []);
          const body = segments.find(segment => String(segment?.type || '').toLowerCase() === 'body');
          return body?.text || body?.content || event?.displayText || event?.cleanText || event?.text || '';
        }
        function decodeInternalContextMarkup(text) {
          return String(text || '')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;|&#39;/gi, "'");
        }
        function compactGoalObjective(text) {
          const clean = String(text || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          return Array.from(clean).slice(0, 8000).join('').trim();
        }
        function goalInternalContextPresentation(event) {
          const text = decodeInternalContextMarkup(contextEventBodyText(event));
          const openTag = text.match(/<codex_internal_context\\b[^>]*>/i);
          if (!openTag || !/\\bsource\\s*=\\s*(?:"goal"|'goal'|goal)/i.test(openTag[0])) return null;
          const bodyStart = Number(openTag.index || 0) + openTag[0].length;
          const body = text.slice(bodyStart).replace(/<\\/codex_internal_context>[\\s\\S]*$/i, '');
          const objectiveMatch = body.match(/<objective>\\s*([\\s\\S]*?)\\s*<\\/objective>/i);
          const objective = objectiveMatch ? compactGoalObjective(objectiveMatch[1]) : '';
          if (!objective) return null;
          return {
            mode: 'goal',
            source: 'codex',
            title: 'Goal',
            goal: {
              objective,
              source: 'user',
              objectiveMatchesUser: true,
            },
          };
        }
        function plainContextNoteText(text) {
          const tick = String.fromCharCode(96);
          const fencePattern = new RegExp(tick + tick + tick + '[\\\\s\\\\S]*?' + tick + tick + tick, 'g');
          const inlineCodePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
          return stripContextMetadata(text)
            .replace(fencePattern, ' ')
            .replace(inlineCodePattern, '$1')
            .replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, '$1')
            .replace(/^#{1,6}\\s+/gm, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[>*_|~]/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
        }
        function contextVisibleCharCount(text) {
          return Array.from(plainContextNoteText(text)).length;
        }
        function isContextSectionBoundary(line) {
          const clean = String(line || '').trim();
          if (!clean) return false;
          if (/^#{1,6}\\s+/.test(clean)) return true;
          return /^(?:\\*\\*)?[A-Za-z0-9 _-\\u4e00-\\u9fff]{2,28}(?:\\*\\*)?\\s*[:：]\\s*$/.test(clean);
        }
        function extractContextConclusionText(text) {
          const lines = stripContextMetadata(text).replace(/\\r\\n/g, '\\n').split('\\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = String(lines[index] || '').trim();
            const match = line.match(/^(?:#{1,6}\\s*)?(?:\\*\\*)?\\s*(核心结论|结论|我的判断|总结|最终结论|处理结果|验证结果|已解决|Outcome|Conclusion|Key Takeaways)\\s*(?:\\*\\*)?\\s*[:：]?\\s*(.*)$/i);
            if (!match) continue;
            const parts = [];
            if (match[2]) parts.push(match[2]);
            for (let cursor = index + 1; cursor < lines.length && parts.join('\\n').length < 900; cursor += 1) {
              const next = String(lines[cursor] || '').trim();
              if (!next && parts.length) break;
              if (parts.length && isContextSectionBoundary(next)) break;
              if (next) parts.push(next);
            }
            const conclusion = plainContextNoteText(parts.join('\\n'));
            if (conclusion) return conclusion;
          }
          return '';
        }
        function contextSessionSummaryHint() {
          const session = window.__teamSharingSession || {};
          return String(session.summaryHint || session.activitySummary || session.abstractSummary || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        }
        function compactContextNoteSummary(text, limit = CONTEXT_NOTE_MAX_CHARS) {
          const clean = String(text || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          const chars = Array.from(clean);
          if (chars.length <= limit) return clean;
          return chars.slice(0, Math.max(1, limit - 1)).join('').trimEnd() + '…';
        }
        function contextNoteSummary(event) {
          if (eventPresentation(event)?.mode && eventPresentation(event).mode !== 'normal') return '';
          if (!(event?.role === 'assistant' || event?.role === 'system')) return '';
          const text = contextEventBodyText(event);
          if (contextVisibleCharCount(text) <= CONTEXT_NOTE_MIN_CHARS) return '';
          const replySummary = contextReplyOutcomeSummary(text);
          if (replySummary) return compactContextNoteSummary(replySummary, CONTEXT_NOTE_MAX_CHARS);
          const hint = contextSessionSummaryHint();
          if (!hint) return '';
          return compactContextNoteSummary(hint, CONTEXT_NOTE_MAX_CHARS);
        }
        function contextNoteCandidateSentences(text) {
          const clean = stripContextMetadata(text).replace(/\\r\\n/g, '\\n');
          const fromLines = clean.split('\\n')
            .map(line => line.replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+/, '').trim())
            .filter(line => line && !/^https?:\\/\\//i.test(line));
          const fromPlain = plainContextNoteText(clean).split(/(?<=[。！？!?])\\s+/).map(item => item.trim()).filter(Boolean);
          return [...fromLines, ...fromPlain]
            .map(item => item.replace(/\\s+/g, ' ').trim())
            .filter(item => item.length >= 8 && item.length <= 260);
        }
        function pickContextOutcome(candidates, patterns, used) {
          for (const candidate of candidates) {
            if (used.has(candidate)) continue;
            if (!patterns.some(pattern => pattern.test(candidate))) continue;
            used.add(candidate);
            return candidate.replace(/[。；;：:]?$/, '。');
          }
          return '';
        }
        function contextReplyOutcomeSummary(text) {
          const candidates = contextNoteCandidateSentences(text);
          if (!candidates.length) return '';
          const used = new Set();
          const rows = [
            ['具体做了什么', [/\\b(done|implemented|created|updated|fixed|deployed|pushed|configured)\\b/i, /已|已经|完成|处理|修复|实现|创建|重建|配置|更新|补充|推送|部署|回滚/]],
            ['验收说明', [/\\b(test|verified|passed|ready|probe|smoke)\\b/i, /验收|测试|验证|通过|返回\\s*\\d+|ready|readyz|doctor|成功|不报错|全过/]],
            ['当前结论', [/\\b(conclusion|decision|current)\\b/i, /结论|准确说|所以|当前|关于|支持|可用|不能|需要/]],
            ['重要发现', [/\\b(risk|found|discovered|warning|limitation|crash|blocked)\\b/i, /发现|风险|注意|但|不过|异常|CrashLoop|缺|限制|边界|不支持/]],
          ].map(([label, patterns]) => {
            const value = pickContextOutcome(candidates, patterns, used);
            return value ? '- **' + label + '**：' + value : '';
          }).filter(Boolean);
          return rows.length >= 2 ? rows.join('\\n') : '';
        }
        function renderContextNote(summary) {
          if (!summary) return '';
          return '<aside class="context-note" data-context-note aria-label="本次长回复摘要">' +
        '<div class="context-note-label">Abstract</div>' +
            '<div class="context-note-body">' + renderContextMarkdown(summary) + '</div></aside>';
        }
        function chinaTime(value) {
          const date = new Date(value || '');
      if (!Number.isFinite(date.getTime())) return value || '';
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(date);
    }
    function runtimeName(runtime) {
      const clean = String(runtime || '').toLowerCase();
      if (clean === 'claude_code' || clean === 'claude-code' || clean === 'claude') return 'ClaudeCode';
      if (clean === 'codex') return 'Codex';
      return clean || 'Assistant';
    }
    function eventActor(event, session) {
      const actor = event?.actor && typeof event.actor === 'object' ? event.actor : null;
      if (actor) return actor;
      if (event.role === 'user') return event.metadata?.uploader || session?.uploader || { name: 'User', avatar: '' };
      if (event.role === 'assistant' || event.role === 'system') return { type: 'runtime', runtime: session?.runtime || '', name: runtimeName(session?.runtime) };
      return { name: event.role || 'Unknown', avatar: '' };
    }
    function roleLabel(event, session) {
      if (event.role === 'user') {
        return eventActor(event, session)?.name || event.metadata?.uploader?.name || session?.uploader?.name || 'User';
      }
      if (event.role === 'assistant') return runtimeName(session?.runtime);
      if (event.role === 'system') return runtimeName(session?.runtime);
      return event.role || 'Unknown';
    }
    function safeAvatarSrc(value) {
      const src = String(value || '').trim();
      if (/^data:image\\//i.test(src)) return src;
      if (/^https?:\\/\\//i.test(src)) return src;
      if (src.startsWith('/')) return src;
      return '';
    }
    function avatarInitials(name) {
      const text = String(name || 'User').trim();
      const parts = text.split(/\\s+/).filter(Boolean);
      const letters = parts.map(part => part[0]).join('').slice(0, 2).toUpperCase();
      return letters || text.slice(0, 2).toUpperCase() || 'US';
    }
    function runtimeAvatarHtml(runtime) {
      const clean = String(runtime || '').toLowerCase();
      if (clean === 'claude_code' || clean === 'claude-code' || clean === 'claude') {
        return '<span class="context-avatar context-avatar-claude" aria-label="ClaudeCode"><svg viewBox="0 0 64 64" role="img" aria-hidden="true"><rect width="64" height="64" rx="12" fill="#f8f3ed"/><g fill="#c15f3c"><path d="M32 7l4.3 16.7L48.2 11.8 39.1 26.7 56 22.2 41.1 31.8 56 41.4 39.1 36.9 48.2 51.8 36.3 39.9 32 57 27.7 39.9 15.8 51.8 24.9 36.9 8 41.4 22.9 31.8 8 22.2 24.9 26.7 15.8 11.8 27.7 23.7z"/></g></svg></span>';
      }
      if (clean === 'codex') {
        return '<span class="context-avatar context-avatar-codex" aria-label="Codex"><img src="/brand/codex-logo.png" alt="" loading="lazy" decoding="async"></span>';
      }
      return '<span class="context-avatar">' + escapeHtml(runtimeName(runtime).slice(0, 2).toUpperCase()) + '</span>';
    }
    function roleAvatarHtml(event, session) {
      if (event.role === 'assistant' || event.role === 'system') return runtimeAvatarHtml(session?.runtime);
      const actor = eventActor(event, session);
      const src = safeAvatarSrc(actor?.avatar || '');
      const name = actor?.name || 'User';
      if (src) return '<span class="context-avatar"><img src="' + escapeHtml(src) + '" alt="' + escapeHtml(name) + '" loading="lazy" decoding="async"></span>';
      return '<span class="context-avatar" aria-label="' + escapeHtml(name) + '">' + escapeHtml(avatarInitials(name)) + '</span>';
    }
    function teamSharingScopeQuery(prefix = '&') {
      const params = new URLSearchParams();
      if (serverSlug) params.set('serverSlug', serverSlug);
      else if (workspaceId) params.set('workspaceId', workspaceId);
      const query = params.toString();
      return query ? prefix + query : '';
    }
    function recordFeedback(eventType) {
      if (!vectorDocumentId) return;
      fetch('/api/team-sharing/feedback' + teamSharingScopeQuery('?'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId, vectorDocumentId, sessionId, eventType, sourceRef })
      }).catch(() => {});
    }
    function updateButtons() {
      setContextButtonVisible(prevBtn, initialLoaded && hasPrev);
      setContextButtonVisible(nextBtn, initialLoaded && hasNext);
      prevBtn.disabled = loading.prev || !hasPrev;
      nextBtn.disabled = loading.next || !hasNext;
      prevBtn.title = hasPrev ? 'Load previous context' : 'Check for earlier context';
      nextBtn.title = hasNext ? 'Load next context' : 'Check for newer context';
    }
    function setContextButtonVisible(button, visible) {
      if (!button) return;
      button.hidden = !visible;
      const controls = button.closest?.('.controls') || button.parentElement || null;
      if (controls) controls.hidden = !visible;
    }
    function canLoad(direction, force = false) {
      if (direction === 'prev') return (force || hasPrev) && !loading.prev;
      if (direction === 'next') return (force || hasNext) && !loading.next;
      return !loading.around;
    }
    function preserveScrollForPrepend(beforeHeight, beforeScrollY) {
      const afterHeight = document.documentElement.scrollHeight;
      const delta = afterHeight - beforeHeight;
      if (delta > 0) window.scrollTo({ top: beforeScrollY + delta, behavior: 'auto' });
    }
    function scrollToInitialAnchor() {
      if (initialAnchorScrolled || !anchorEventId) return;
      const anchorEl = document.getElementById(encodeURIComponent(anchorEventId));
      if (!anchorEl) return;
      initialAnchorScrolled = true;
      anchorEl.scrollIntoView({ block: 'center' });
    }
    function checkScrollEdges() {
      if (!initialLoaded) return;
      const topThreshold = 520;
      const bottomThreshold = 520;
      if (window.scrollY <= topThreshold) load(topDirection).catch(console.error);
      const bottomDistance = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      if (bottomDistance <= bottomThreshold) load(bottomDirection).catch(console.error);
    }
        function scheduleScrollCheck() {
          if (scrollCheckTimer) return;
          scrollCheckTimer = window.setTimeout(() => {
            scrollCheckTimer = null;
            checkScrollEdges();
          }, 120);
        }
        function revealContextNote(note) {
          if (!note || note.dataset.notePlayed === '1') return;
          note.dataset.notePlayed = '1';
          note.classList.add('is-open');
          note.classList.add('is-finished');
        }
        function contextNoteVisibleRatio(entry) {
          const total = Number(entry?.boundingClientRect?.height || 0);
          const visible = Number(entry?.intersectionRect?.height || 0);
          if (total <= 0) return entry?.isIntersecting ? 1 : 0;
          return Math.max(0, Math.min(1, visible / total));
        }
        function contextNoteTriggerRatio(article) {
          const height = Number(article?.getBoundingClientRect?.().height || 0);
          if (height >= Math.min(window.innerHeight * 0.9, 720)) return 0.33;
          return 0.95;
        }
        let contextNoteObserver = null;
        function ensureContextNoteObserver() {
          if (contextNoteObserver || typeof window.IntersectionObserver !== 'function') return contextNoteObserver;
          contextNoteObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const article = entry.target;
              const note = article.querySelector?.('[data-context-note]');
              if (!note || note.dataset.notePlayed === '1') continue;
              if (contextNoteVisibleRatio(entry) < contextNoteTriggerRatio(article)) continue;
              revealContextNote(note);
              contextNoteObserver?.unobserve(article);
            }
          }, { root: null, threshold: [0, .33, .66, .95, 1] });
          return contextNoteObserver;
        }
        function observeContextNotes(root = eventsEl) {
          const notes = Array.from(root?.querySelectorAll?.('[data-context-note]:not([data-note-observed])') || []);
          for (const note of notes) {
            note.dataset.noteObserved = '1';
            const article = note.closest?.('article.context-event') || note.parentElement;
            const noteObserver = ensureContextNoteObserver();
            if (article && noteObserver) noteObserver.observe(article);
            else revealContextNote(note);
          }
        }
        function eventPresentation(event) {
          const value = event?.presentation || event?.metadata?.presentation || event?.metadata?.teamSharing?.presentation || null;
          if (value && typeof value === 'object') {
            const mode = String(value.mode || '').toLowerCase();
            if (['plan', 'goal', 'interaction'].includes(mode)) return { ...value, mode };
          }
          return goalInternalContextPresentation(event);
        }
        function presentationLabel(presentation, fallback) {
          return escapeHtml(presentation?.title || fallback || 'Context');
        }
        function renderModePanel(className, label, body, extraHead = '') {
          return '<section class="context-mode-panel ' + className + '">' +
            '<div class="context-mode-head"><span>' + label + '</span>' + extraHead + '</div>' +
            body + '</section>';
        }
        function presentationBadge(event) {
          const presentation = eventPresentation(event);
          if (!presentation || presentation.mode !== 'goal') return '';
          return '<span class="context-goal-badge" aria-label="Goal"><span class="context-goal-logo" aria-hidden="true"></span><span>Goal</span></span>';
        }
        function answerValuesForQuestion(presentation, question, index) {
          const answers = Array.isArray(presentation?.interaction?.answers) ? presentation.interaction.answers : [];
          const answer = answers.find(item => String(item.id || '') === String(question?.id || '')) || answers[index] || null;
          return Array.isArray(answer?.values) ? answer.values.filter(Boolean) : [];
        }
        function optionKey(value) {
          return String(value || '').trim().replace(/\\s*\\((?:recommended|推荐)\\)\\s*$/i, '').toLowerCase();
        }
        function optionForAnswerValue(question, value) {
          const options = Array.isArray(question?.options) ? question.options : [];
          const key = optionKey(value);
          return options.find(option => optionKey(option?.label || option?.value || option?.text || '') === key) || null;
        }
        function renderAnswerValue(question, value) {
          const option = optionForAnswerValue(question, value);
          const description = String(option?.description || '').trim();
          return '<span class="context-answer-item"><span class="context-answer-chip">' + escapeHtml(value) + '</span>' +
            (description ? '<span class="context-answer-description">（' + escapeHtml(description) + '）</span>' : '') +
            '</span>';
        }
        function renderInteractionPresentation(presentation) {
          const questions = Array.isArray(presentation?.interaction?.questions) ? presentation.interaction.questions : [];
          const answers = Array.isArray(presentation?.interaction?.answers) ? presentation.interaction.answers : [];
          const cards = questions.length ? questions.map((question, index) => {
            const options = Array.isArray(question.options) ? question.options : [];
            const values = answerValuesForQuestion(presentation, question, index);
            return '<div class="context-question-card">' +
              (question.header ? '<div class="context-question-head">' + escapeHtml(question.header) + '</div>' : '') +
              '<p class="context-question-prompt">' + escapeHtml(question.question || question.prompt || question.header || 'Question') + '</p>' +
              (options.length ? '<div class="context-option-list">' + options.map(option => '<span class="context-option-chip">' + escapeHtml(option.label || option.description || '') + '</span>').join('') + '</div>' : '') +
              (values.length ? '<div class="context-answer-list">' + values.map(value => renderAnswerValue(question, value)).join('') + '</div>' : '') +
              '</div>';
          }) : answers.map(answer => {
            const values = Array.isArray(answer.values) ? answer.values : [];
            return '<div class="context-question-card">' +
              '<div class="context-question-head">' + escapeHtml(answer.id || 'Answer') + '</div>' +
              '<div class="context-answer-list">' + values.map(value => '<span class="context-answer-chip">' + escapeHtml(value) + '</span>').join('') + '</div>' +
              '</div>';
          });
          return renderModePanel(
            'context-interaction-panel',
            presentationLabel(presentation, 'Interaction'),
            '<div class="context-interaction-list">' + cards.join('') + '</div>',
          );
        }
        function presentationBody(event) {
          const presentation = eventPresentation(event);
          if (!presentation) return '';
          const text = contextEventBodyText(event);
          if (presentation.mode === 'plan') {
            return renderModePanel(
              'context-plan-panel',
              presentationLabel(presentation, 'Plan'),
              '<div class="context-main">' + renderContextMarkdown(text) + '</div>',
            );
          }
          if (presentation.mode === 'goal') {
            const goal = presentation.goal || {};
            if (goal.reply) return '<div class="context-main context-goal-main">' + renderContextMarkdown(text) + '</div>';
            const objective = goal.objective || text;
            return '<div class="context-main context-goal-main">' + renderContextMarkdown(objective) + '</div>';
          }
          if (presentation.mode === 'interaction') return renderInteractionPresentation(presentation);
          return '';
        }
        function eventSegments(event) {
          const segments = Array.isArray(event.contentSegments) && event.contentSegments.length
            ? event.contentSegments
        : (Array.isArray(event.metadata?.contentSegments) ? event.metadata.contentSegments : []);
      if (!segments.length) return '';
      return '<div class="context-segments">' + segments.map(segment => {
        const type = String(segment.type || '').toLowerCase();
        const text = segment.text || segment.content || '';
        if (!text) return '';
        if (type === 'body') return '<div class="context-main">' + renderContextMarkdown(text) + '</div>';
        return '<blockquote class="context-quote">' +
          (segment.label ? '<div class="context-quote-label">' + escapeHtml(segment.label) + '</div>' : '') +
          '<div class="context-quote-text">' + renderContextMarkdown(text) + '</div></blockquote>';
      }).join('') + '</div>';
    }
        function eventHtml(event) {
          const anchorClass = anchorEventId && event.eventId === anchorEventId ? ' anchor' : '';
          const roleClass = event.role === 'user' ? ' context-event-user' : (event.role === 'assistant' || event.role === 'system' ? ' context-event-agent' : ' context-event-other');
          const session = window.__teamSharingSession || {};
          const body = presentationBody(event) || eventSegments(event) || '<div class="text">' + renderContextMarkdown(event.displayText || event.cleanText || event.text || '') + '</div>';
          const badge = presentationBadge(event);
          const note = renderContextNote(contextNoteSummary(event));
          const noteClass = note ? ' has-context-note' : '';
          return '<article id="' + encodeURIComponent(event.eventId || '') + '" class="' + ('context-event' + roleClass + anchorClass + noteClass).trim() + '">' +
            '<div class="context-event-head">' + roleAvatarHtml(event, session) + '<div class="context-event-meta"><span class="role">' + escapeHtml(roleLabel(event, session)) + '</span><span class="time">' + escapeHtml(chinaTime(event.createdAt || '')) + '</span></div>' + badge + '</div>' +
            note + body + '</article>';
        }
    async function load(direction, options = {}) {
      const force = Boolean(options.force);
      if (loading[direction]) return;
      if (direction !== 'around' && !canLoad(direction, force)) return;
      loading[direction] = true;
      updateButtons();
      if (statusEl) statusEl.textContent = direction === 'around' ? '' : 'Checking context...';
      const beforeHeight = document.documentElement.scrollHeight;
      const beforeScrollY = window.scrollY;
      const anchor = direction === 'next' ? nextAnchor : prevAnchor;
      try {
        const url = '/api/team-sharing/context/${safeSession}?anchorEventId=' + encodeURIComponent(anchor || '') + '&direction=' + encodeURIComponent(direction) + '&limit=21&order=' + encodeURIComponent(order) + teamSharingScopeQuery('&');
        const response = await fetch(url);
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'Failed to load context');
        window.__teamSharingSession = data.session || window.__teamSharingSession || {};
        if (data.session?.title) document.getElementById('session-title').textContent = data.session.title;
        document.getElementById('session-meta').textContent = 'session: ' + sessionId + ' · anchor: ' + (anchorEventId || 'latest') + ' · order: ' + (order === 'desc' ? 'newest first' : 'oldest first');
        const fresh = (data.events || []).filter(event => {
          const key = event.eventId || JSON.stringify(event);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const insertsAtTop = (order === 'desc' && direction === 'next') || (order !== 'desc' && direction === 'prev');
        if (!fresh.length && !seen.size) {
          eventsEl.innerHTML = '<div class="empty">No context found.</div>';
            } else if (fresh.length) {
              const html = fresh.map(eventHtml).join('');
              if (insertsAtTop) eventsEl.insertAdjacentHTML('afterbegin', html);
              else if (eventsEl.querySelector('.empty')) eventsEl.innerHTML = html;
              else eventsEl.insertAdjacentHTML('beforeend', html);
              observeContextNotes(eventsEl);
              if (direction !== 'around' && insertsAtTop) preserveScrollForPrepend(beforeHeight, beforeScrollY);
            }
        if (statusEl) {
          if (fresh.length) statusEl.textContent = '';
          else if (force && direction === 'next') statusEl.textContent = 'No newer context yet. Try again after hooks sync.';
          else if (force && direction === 'prev') statusEl.textContent = 'No previous context yet.';
          else statusEl.textContent = '';
        }
        prevAnchor = data.pagination?.prevAnchorEventId || prevAnchor;
        nextAnchor = data.pagination?.nextAnchorEventId || nextAnchor;
        hasPrev = Boolean(data.pagination?.hasPrev);
        hasNext = Boolean(data.pagination?.hasNext);
        if (!openedRecorded && direction === 'around') {
          openedRecorded = true;
          recordFeedback('opened');
        } else if (fresh.length && (direction === 'prev' || direction === 'next')) {
          recordFeedback('load_more');
        }
        initialLoaded = true;
        if (direction === 'around') scrollToInitialAnchor();
      } catch (error) {
        if (statusEl && direction !== 'around') statusEl.textContent = error?.message || 'Failed to load context.';
        throw error;
      } finally {
        loading[direction] = false;
        updateButtons();
      }
    }
    prevBtn.addEventListener('click', () => load('prev', { force: true }).catch(console.error));
    nextBtn.addEventListener('click', () => load('next', { force: true }).catch(console.error));
    const observer = typeof window.IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (!initialLoaded) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target === topSentinel) load(topDirection).catch(console.error);
        if (entry.target === bottomSentinel) load(bottomDirection).catch(console.error);
      }
    }, { root: null, rootMargin: '640px 0px', threshold: 0 }) : null;
    observer?.observe(topSentinel);
    observer?.observe(bottomSentinel);
    window.addEventListener('scroll', scheduleScrollCheck, { passive: true });
    load('around').catch(error => { eventsEl.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
  </script>
</body>
</html>`;
  res.writeHead?.(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end?.(body);
}

function sendWorkspaceFileHtml(res, { workspace = {}, file = {}, serverSlug = '' } = {}) {
  const session = workspace.session || {};
  const content = String(file.content || '');
  const previewKind = String(file.previewKind || 'markdown').trim();
  const markdown = previewKind === 'markdown';
  const previewHtml = markdown
    ? renderWorkspaceFileMarkdownToHtml(content)
    : `<pre class="workspace-file-preview"><code>${htmlEscape(content)}</code></pre>`;
  const outlineHtml = markdown ? renderWorkspaceFileOutline(content) : '';
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(file.path || file.name || 'Workspace file')} - MagClaw Team Sharing</title>
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#64748b; --line:#d7dee8; --bg:#f8fafc; --panel:#fff; --accent:#0891b2; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:16px 20px; border-bottom:1px solid var(--line); background:rgba(248,250,252,.95); backdrop-filter:blur(12px); }
    .brand { color:var(--accent); font-size:12px; font-weight:800; letter-spacing:0; text-transform:uppercase; }
    h1 { margin:4px 0 0; font-size:22px; line-height:1.25; overflow-wrap:anywhere; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    main { max-width:1120px; margin:0 auto; padding:20px; display:grid; grid-template-columns:minmax(0,1fr) 220px; gap:20px; align-items:start; }
    article, .workspace-file-raw-panel, .workspace-file-outline { border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    article { padding:22px; min-width:0; }
    article h1, article h2, article h3 { scroll-margin-top:84px; }
    article h1:first-child { margin-top:0; }
    article p, article li { line-height:1.65; }
    article a { color:var(--accent); }
    article pre, .workspace-file-raw { overflow:auto; border-radius:6px; background:#0f172a; color:#e2e8f0; padding:14px; }
    .workspace-file-side { display:grid; gap:14px; position:sticky; top:84px; }
    .workspace-file-outline { padding:12px; }
    .outline-title { font-size:12px; color:var(--muted); font-weight:800; text-transform:uppercase; margin-bottom:8px; }
    .workspace-file-outline a { display:block; color:var(--ink); text-decoration:none; font-size:13px; line-height:1.35; padding:5px 0; overflow-wrap:anywhere; }
    .workspace-file-outline a.level-2 { padding-left:10px; }
    .workspace-file-outline a.level-3 { padding-left:20px; }
    .workspace-file-raw-panel { grid-column:1 / -1; padding:16px; }
    .workspace-file-raw-panel h2 { margin:0 0 10px; font-size:15px; }
    .workspace-file-raw { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
    @media (max-width: 860px) { main { grid-template-columns:1fr; } .workspace-file-side { position:static; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">MagClaw Team Sharing Workspace File</div>
    <h1>${htmlEscape(file.path || file.name || 'Workspace file')}</h1>
    <div class="meta">${htmlEscape(session.title || session.sessionId || 'Team Sharing session')}${serverSlug ? ` · ${htmlEscape(serverSlug)}` : ''}</div>
  </header>
  <main>
    <article class="workspace-file-preview">
      ${previewHtml}
    </article>
    <div class="workspace-file-side">
      ${outlineHtml || '<aside class="workspace-file-outline"><div class="outline-title">Outline</div><p class="meta">No headings</p></aside>'}
    </div>
    <section class="workspace-file-raw-panel">
      <h2>Markdown Source</h2>
      <pre class="workspace-file-raw"><code>${htmlEscape(content)}</code></pre>
    </section>
  </main>
</body>
</html>`;
  res.writeHead?.(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self';",
  });
  res.end?.(body);
}

function queryTerms(query = '') {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，。.;；:：!?！？()[\]{}"'`]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function normalizeSearchList(value = []) {
  const values = Array.isArray(value) ? value : [value];
  const items = [];
  for (const item of values) {
    if (item === undefined || item === null || item === false || item === true) continue;
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items.push(...normalizeSearchList(parsed));
          continue;
        }
      } catch {}
    }
    items.push(...text.split(/[\n,，、;；|]+/g).map((part) => part.trim()).filter(Boolean));
  }
  return items;
}

function uniqueSearchList(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function inferTimePreferenceFromQuery(query = '') {
  const text = String(query || '').toLowerCase();
  if (/(今天|今日|\btoday\b)/i.test(text)) return 'today';
  if (/(昨天|昨日|\byesterday\b)/i.test(text)) return 'yesterday';
  if (/(这周|本周|\bthis\s*week\b)/i.test(text)) return 'this-week';
  if (/(上周|\blast\s*week\b)/i.test(text)) return 'last-week';
  return '';
}

function splitTopicText(value = '') {
  return String(value || '')
    .replace(/\b(and|or)\b/gi, '、')
    .replace(/(?:以及|或者|还有|和|与|及|跟|、|\/)+/g, '、')
    .split(/[、,，;；]+/g)
    .map((part) => part.replace(/^(关于|围绕|讲的|聊的|讨论|话题|topic)\s*/i, '').trim())
    .filter((part) => part && !/^(昨天|今天|本周|这周|上周|what|who|when|where|why|how)$/i.test(part));
}

function extractQuotedPhrases(query = '') {
  const phrases = [];
  const text = String(query || '');
  const pattern = /["'`“”‘’]([^"'`“”‘’]{2,80})["'`“”‘’]/g;
  for (const match of text.matchAll(pattern)) phrases.push(match[1]);
  return phrases;
}

function extractIntentTopics(query = '') {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const topics = [];
  topics.push(...extractQuotedPhrases(text));
  const topicPatterns = [
    /(?:关于|围绕|讲的|聊的|讨论|提到|看看|看一下)\s*([^。！？!?；;\n]{2,140})/gi,
    /(?:topic|topics|subject|subjects)\s*(?:of|about|:|：)?\s*([^。！？!?；;\n]{2,140})/gi,
  ];
  for (const pattern of topicPatterns) {
    for (const match of text.matchAll(pattern)) topics.push(...splitTopicText(match[1]));
  }
  const enumMatch = text.match(/([A-Z0-9_\-.一-龥]{1,40}(?:[、,，/]\s*[A-Z0-9_\-.一-龥]{1,40}){1,12})/);
  if (enumMatch) topics.push(...splitTopicText(enumMatch[1]));
  return uniqueSearchList(topics, 16);
}

function extractIntentKeywords(query = '') {
  const text = String(query || '');
  const quoted = extractQuotedPhrases(text);
  const technicalTokens = text.match(/[A-Za-z][A-Za-z0-9_.:/-]{2,}|[A-Z][A-Z0-9_-]{1,}/g) || [];
  const codeTokens = text.match(/`([^`]{2,80})`/g)?.map((item) => item.replace(/^`|`$/g, '')) || [];
  return uniqueSearchList([...quoted, ...technicalTokens, ...codeTokens], 24);
}

function normalizeTeamSharingSearchIntentBody(body = {}, nowValue = '') {
  const query = String(body.query || '').replace(/\s+/g, ' ').trim();
  const explicitTime = normalizeTimePreference(body.timePreference || body.time || body.when || body.period || '');
  const inferredTime = inferTimePreferenceFromQuery(query);
  const timePreference = explicitTime || inferredTime || '';
  const modeBias = normalizeTeamSharingSearchMode(body.modeBias || body.searchMode || body.mode || (body.exact ? 'keyword' : body.fuzzy ? 'semantic' : 'hybrid'));
  const keywordOnly = booleanFlag(body.keywordOnly || body.keywordsOnly || body.exactOnly || body.retrievalIntent?.keywordOnly);
  const semanticOnly = booleanFlag(body.semanticOnly || body.vectorOnly || body.fuzzyOnly || body.retrievalIntent?.semanticOnly);
  const searchMode = keywordOnly ? 'keyword' : semanticOnly ? 'semantic' : 'hybrid';
  const topics = uniqueSearchList([
    ...normalizeSearchList(body.topics),
    ...normalizeSearchList(body.topic),
    ...normalizeSearchList(body.retrievalIntent?.topics),
    ...extractIntentTopics(query),
  ], 24);
  const keywords = uniqueSearchList([
    ...normalizeSearchList(body.keywords),
    ...normalizeSearchList(body.keyword),
    ...normalizeSearchList(body.exactKeywords),
    ...normalizeSearchList(body.exactKeyword),
    ...normalizeSearchList(body.retrievalIntent?.keywords),
    ...topics,
    ...extractIntentKeywords(query),
  ], 32);
  const semanticQuery = String(
    body.semanticQuery
      || body.semantic_query
      || body.retrievalIntent?.semanticQuery
      || body.retrievalIntent?.semantic_query
      || query,
  ).replace(/\s+/g, ' ').trim() || query;
  const dateRange = normalizeSearchDateRange({
    ...body,
    ...(timePreference && !body.timePreference && !body.time && !body.when && !body.period ? { timePreference } : {}),
  }, nowValue);
  const keywordQuery = uniqueSearchList([
    ...normalizeSearchList(body.keywordQuery || body.keyword_query),
    ...keywords,
    ...topics,
    query,
  ], 40).join('\n');
  return {
    query,
    semanticQuery,
    keywordQuery,
    keywords,
    topics,
    timePreference: timePreference || null,
    dateRange,
    searchMode,
    modeBias,
    useKeyword: searchMode !== 'semantic',
    useSemantic: searchMode !== 'keyword',
  };
}

function normalizeTeamSharingSearchScope(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['channel', 'current-channel', 'current_channel', 'local'].includes(clean)) return 'channel';
  if (['server', 'workspace', 'all', 'all-server', 'server-wide', 'server_wide'].includes(clean)) return 'server';
  return 'hybrid';
}

function teamSharingSearchScopes(scope = 'hybrid', channelId = '') {
  const cleanScope = normalizeTeamSharingSearchScope(scope);
  const cleanChannelId = String(channelId || '').trim();
  if (cleanScope === 'channel' && cleanChannelId) {
    return [{ retrievalScope: 'channel', channelId: cleanChannelId, excludeChannelId: '' }];
  }
  if (cleanScope === 'server' || !cleanChannelId) {
    return [{ retrievalScope: 'server', channelId: '', excludeChannelId: '' }];
  }
  return [
    { retrievalScope: 'channel', channelId: cleanChannelId, excludeChannelId: '' },
    { retrievalScope: 'server', channelId: '', excludeChannelId: cleanChannelId },
  ];
}

function annotateScopedCandidates(result = {}, scope = {}, currentChannelId = '') {
  const cleanCurrentChannelId = String(currentChannelId || '').trim();
  return {
    ...(result || {}),
    candidates: asArray(result?.candidates).map((candidate) => {
      const candidateChannelId = String(candidate?.channelId || '').trim();
      const sameChannel = Boolean(cleanCurrentChannelId && candidateChannelId === cleanCurrentChannelId);
      return {
        ...candidate,
        retrievalScope: sameChannel ? 'channel' : 'server',
        sameChannel,
        scopeBoost: sameChannel ? 0.03 : 0,
        scopeSource: scope.retrievalScope || '',
      };
    }),
  };
}

function mergeScopedSearchResults(results = [], limit = 40) {
  const failures = asArray(results).filter((result) => result && result.ok === false);
  const byId = new Map();
  asArray(results).forEach((result) => {
    asArray(result?.candidates).forEach((candidate, index) => {
      const id = String(candidate?.vectorDocumentId || '').trim();
      if (!id) return;
      const existing = byId.get(id) || {
        ...candidate,
        vectorScore: 0,
        keywordScore: 0,
        scopeBoost: 0,
        rrfScore: 0,
        retrievalSources: [],
      };
      existing.rrfScore += 1 / (30 + index + 1);
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? candidate.score));
      existing.keywordScore = Math.max(clamp01(existing.keywordScore), clamp01(candidate.keywordScore));
      existing.scopeBoost = Math.max(clamp01(existing.scopeBoost), clamp01(candidate.scopeBoost));
      existing.sameChannel = Boolean(existing.sameChannel || candidate.sameChannel);
      existing.retrievalScope = existing.sameChannel ? 'channel' : (existing.retrievalScope || candidate.retrievalScope || 'server');
      if (candidate.scopeSource && !existing.retrievalSources.includes(candidate.scopeSource)) {
        existing.retrievalSources.push(candidate.scopeSource);
      }
      byId.set(id, {
        ...existing,
        ...candidate,
        vectorScore: existing.vectorScore,
        keywordScore: existing.keywordScore,
        scopeBoost: existing.scopeBoost,
        sameChannel: existing.sameChannel,
        retrievalScope: existing.retrievalScope,
        rrfScore: existing.rrfScore,
        retrievalSources: existing.retrievalSources,
      });
    });
  });
  const candidates = [...byId.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore || right.keywordScore - left.keywordScore || right.vectorScore - left.vectorScore)
    .slice(0, limit);
  return {
    ok: failures.length < asArray(results).length,
    candidates,
    degraded: asArray(results).some((result) => result?.degraded),
    remoteError: failures[0]?.error || failures[0]?.code || asArray(results).find((result) => result?.remoteError)?.remoteError || '',
  };
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeTimePreference(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['today', '今天'].includes(clean)) return 'today';
  if (['yesterday', '昨天'].includes(clean)) return 'yesterday';
  if (['week', 'this-week', 'thisweek', '本周', '这周'].includes(clean)) return 'this-week';
  if (['last-week', 'lastweek', '上周'].includes(clean)) return 'last-week';
  return '';
}

function localDayStartUtcMs(nowMs, offsetMinutes = 480) {
  const offsetMs = offsetMinutes * 60 * 1000;
  const shifted = new Date(nowMs + offsetMs);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs;
}

function relativeDateRange(period = '', nowValue = '', offsetMinutes = 480) {
  const preference = normalizeTimePreference(period);
  if (!preference) return null;
  const nowMs = new Date(nowValue || Date.now()).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const todayStart = localDayStartUtcMs(safeNowMs, offsetMinutes);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (preference === 'today') return { from: new Date(todayStart).toISOString(), to: new Date(todayStart + oneDayMs).toISOString() };
  if (preference === 'yesterday') return { from: new Date(todayStart - oneDayMs).toISOString(), to: new Date(todayStart).toISOString() };
  const shifted = new Date(safeNowMs + offsetMinutes * 60 * 1000);
  const localDay = shifted.getUTCDay() || 7;
  const weekStart = todayStart - ((localDay - 1) * oneDayMs);
  if (preference === 'this-week') return { from: new Date(weekStart).toISOString(), to: new Date(weekStart + 7 * oneDayMs).toISOString() };
  return { from: new Date(weekStart - 7 * oneDayMs).toISOString(), to: new Date(weekStart).toISOString() };
}

function normalizeSearchDateRange(body = {}, nowValue = '') {
  const rawRange = body.dateRange;
  if (rawRange && typeof rawRange === 'object') return rawRange;
  if (typeof rawRange === 'string' && rawRange.trim()) {
    const text = rawRange.trim();
    const relative = relativeDateRange(text, nowValue, Number(body.timezoneOffsetMinutes || body.timeZoneOffsetMinutes || 480));
    if (relative) return relative;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
    const separator = text.includes('..') ? '..' : text.includes(',') ? ',' : '';
    if (separator) {
      const [from = '', to = ''] = text.split(separator).map((part) => part.trim());
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    return { from: text };
  }
  const explicitPreference = body.timePreference || body.time || body.when || body.period || '';
  const relative = relativeDateRange(explicitPreference, nowValue, Number(body.timezoneOffsetMinutes || body.timeZoneOffsetMinutes || 480));
  if (relative) return relative;
  const from = body.from || body.since || body.start || body.updatedAfter || body.updated_after || '';
  const to = body.to || body.until || body.end || body.updatedBefore || body.updated_before || '';
  return from || to ? { ...(from ? { from: String(from) } : {}), ...(to ? { to: String(to) } : {}) } : null;
}

function dateBound(dateRange = {}, keys = []) {
  for (const key of keys) {
    const value = dateRange?.[key];
    if (value) return String(value);
  }
  return '';
}

function isWithinDateRange(value = '', dateRange = null) {
  if (!dateRange || typeof dateRange !== 'object') return true;
  const text = String(value || '');
  const from = dateBound(dateRange, ['from', 'start', 'since', 'updatedAfter', 'updated_after']);
  const to = dateBound(dateRange, ['to', 'end', 'until', 'updatedBefore', 'updated_before']);
  if (from && text < from) return false;
  if (to && text > to) return false;
  return true;
}

function normalizeMemberMatchText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s._\-@]+/g, '');
}

function memberLastActiveAt(teamSharingState = {}, identity = {}) {
  const ids = new Set([identity.id, identity.humanId, identity.userId].map((value) => String(value || '').trim()).filter(Boolean));
  const email = String(identity.email || '').trim().toLowerCase();
  const names = new Set([identity.name, ...(identity.aliases || [])].map(normalizeMemberMatchText).filter(Boolean));
  let latest = '';
  const consider = (updatedAt = '') => {
    const text = String(updatedAt || '').trim();
    if (text && text > latest) latest = text;
  };
  for (const session of Object.values(teamSharingState?.sessions || {})) {
    const uploader = session?.uploader || {};
    const uploaderId = String(uploader.id || '').trim();
    const uploaderEmail = String(uploader.email || '').trim().toLowerCase();
    const uploaderName = normalizeMemberMatchText(uploader.name || '');
    if ((uploaderId && ids.has(uploaderId)) || (email && uploaderEmail === email) || (uploaderName && names.has(uploaderName))) {
      consider(session.updatedAt || session.createdAt);
    }
  }
  for (const share of ensureTeamSharingShares(teamSharingState)) {
    const creator = share?.creator || {};
    const creatorId = String(creator.id || '').trim();
    const creatorEmail = String(creator.email || '').trim().toLowerCase();
    const creatorName = normalizeMemberMatchText(creator.name || '');
    if ((creatorId && ids.has(creatorId)) || (email && creatorEmail === email) || (creatorName && names.has(creatorName))) {
      consider(share.updatedAt || share.createdAt);
    }
  }
  return latest;
}

function publicMemberCandidate(candidate = {}) {
  return {
    id: String(candidate.id || candidate.humanId || '').trim(),
    userId: String(candidate.userId || '').trim(),
    name: String(candidate.name || '').trim(),
    email: String(candidate.email || '').trim(),
    avatar: String(candidate.avatar || candidate.avatarUrl || '').trim(),
    aliases: asArray(candidate.aliases).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12),
    lastActiveAt: String(candidate.lastActiveAt || '').trim(),
  };
}

function memberStrongIdentityValues(candidate = {}) {
  const values = [
    candidate.id,
    candidate.humanId,
    candidate.userId,
    candidate.email,
    ...asArray(candidate.aliases).filter((alias) => {
      const text = String(alias || '').trim();
      return text.includes('@') || /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+$/.test(text);
    }),
  ];
  return new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function memberCandidatesShareStrongIdentity(left = {}, right = {}) {
  const leftValues = memberStrongIdentityValues(left);
  if (!leftValues.size) return false;
  for (const value of memberStrongIdentityValues(right)) {
    if (leftValues.has(value)) return true;
  }
  return false;
}

function memberCandidateEmailsCompatible(left = {}, right = {}) {
  const leftEmail = String(left.email || '').trim().toLowerCase();
  const rightEmail = String(right.email || '').trim().toLowerCase();
  return !leftEmail || !rightEmail || leftEmail === rightEmail;
}

function authoritativeMemberCandidate(candidate = {}) {
  const sources = new Set(asArray(candidate.sources).map((source) => String(source || '').trim()).filter(Boolean));
  return sources.has('workspace_member') || Boolean(candidate.humanId && candidate.userId);
}

function mergeMemberCandidateRecords(left = {}, right = {}) {
  const aliases = [
    ...asArray(left.aliases),
    ...asArray(right.aliases),
    left.id,
    right.id,
    left.humanId,
    right.humanId,
    left.userId,
    right.userId,
    left.email,
    right.email,
    left.name,
    right.name,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const humanId = String(left.humanId || right.humanId || '').trim();
  const userId = String(left.userId || right.userId || '').trim();
  return {
    ...left,
    ...right,
    id: humanId || String(left.id || right.id || userId || '').trim(),
    humanId,
    userId,
    name: String(left.name || right.name || '').trim(),
    email: String(left.email || right.email || '').trim(),
    avatar: left.avatar || right.avatar || '',
    aliases: [...new Set(aliases)],
    sources: [...new Set([...asArray(left.sources), ...asArray(right.sources)].filter(Boolean))],
    lastActiveAt: [left.lastActiveAt, right.lastActiveAt].map((value) => String(value || '').trim()).sort().pop() || '',
  };
}

function mergeEquivalentMemberCandidates(candidates = []) {
  const merged = asArray(candidates).map((candidate) => ({
    ...candidate,
    aliases: asArray(candidate.aliases),
    sources: asArray(candidate.sources),
  }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < merged.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex += 1) {
        if (!memberCandidatesShareStrongIdentity(merged[leftIndex], merged[rightIndex])) continue;
        merged[leftIndex] = mergeMemberCandidateRecords(merged[leftIndex], merged[rightIndex]);
        merged.splice(rightIndex, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }

  const byName = new Map();
  for (const candidate of merged) {
    const name = normalizeMemberMatchText(candidate.name || '');
    if (!name) continue;
    const group = byName.get(name) || [];
    group.push(candidate);
    byName.set(name, group);
  }
  const weakMerged = new Set();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const authoritative = group.filter(authoritativeMemberCandidate);
    if (authoritative.length !== 1) continue;
    let target = authoritative[0];
    for (const candidate of group) {
      if (candidate === target || weakMerged.has(candidate)) continue;
      if (!memberCandidateEmailsCompatible(target, candidate)) continue;
      const targetIndex = merged.indexOf(target);
      const candidateIndex = merged.indexOf(candidate);
      if (targetIndex < 0 || candidateIndex < 0) continue;
      target = mergeMemberCandidateRecords(merged[targetIndex], candidate);
      merged[targetIndex] = target;
      weakMerged.add(candidate);
    }
  }
  return merged.filter((candidate) => !weakMerged.has(candidate));
}

function teamSharingMemberCandidates(state = {}, teamSharingState = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  const byKey = new Map();
  const humans = asArray(state.humans);
  const users = asArray(state.cloud?.users);
  const add = (raw = {}, source = '') => {
    const humanId = String(raw.humanId || raw.id || '').trim();
    const userId = String(raw.userId || raw.authUserId || '').trim();
    const email = String(raw.email || '').trim();
    const name = String(raw.name || raw.displayName || '').trim();
    const key = humanId || userId || email.toLowerCase() || `${source}:${name}`;
    if (!key) return;
    const existing = byKey.get(key) || { aliases: [], sources: [] };
    const aliases = [
      ...asArray(existing.aliases),
      ...asArray(raw.aliases),
      humanId,
      userId,
      email,
      name,
    ].map((item) => String(item || '').trim()).filter(Boolean);
    const next = {
      ...existing,
      id: existing.id || humanId || userId,
      humanId: existing.humanId || humanId,
      userId: existing.userId || userId,
      name: existing.name || name,
      email: existing.email || email,
      avatar: existing.avatar || raw.avatar || raw.avatarUrl || '',
      aliases: [...new Set(aliases)],
      sources: [...new Set([...asArray(existing.sources), source].filter(Boolean))],
    };
    next.lastActiveAt = memberLastActiveAt(teamSharingState, next);
    byKey.set(key, next);
  };
  for (const member of asArray(state.cloud?.workspaceMembers)) {
    if (!member || String(member.status || 'active').trim() !== 'active') continue;
    if (cleanWorkspaceId && String(member.workspaceId || '').trim() !== cleanWorkspaceId) continue;
    const human = humans.find((item) => String(item.id || '') === String(member.humanId || '')) || {};
    const user = users.find((item) => String(item.id || '') === String(member.userId || '')) || {};
    add({
      humanId: member.humanId || human.id,
      userId: member.userId || user.id,
      name: member.name || human.name || user.name,
      email: member.email || human.email || user.email,
      avatar: member.avatar || human.avatar || human.avatarUrl || user.avatar || user.avatarUrl,
      aliases: [member.id, member.humanId, member.userId, human.authUserId],
    }, 'workspace_member');
  }
  for (const human of humans) {
    if (cleanWorkspaceId && human.workspaceId && String(human.workspaceId || '').trim() !== cleanWorkspaceId) continue;
    add({
      humanId: human.id,
      userId: human.authUserId || human.userId,
      name: human.name,
      email: human.email,
      avatar: human.avatar || human.avatarUrl,
      aliases: [human.id, human.authUserId],
    }, 'human');
  }
  for (const user of users) {
    add({
      userId: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar || user.avatarUrl,
      aliases: [user.id],
    }, 'user');
  }
  for (const session of Object.values(teamSharingState?.sessions || {})) {
    if (cleanWorkspaceId && String(session.workspaceId || '').trim() !== cleanWorkspaceId) continue;
    const uploader = session.uploader || {};
    add({
      humanId: uploader.id,
      name: uploader.name,
      email: uploader.email,
      avatar: uploader.avatar,
      aliases: [uploader.id, uploader.name, uploader.email],
    }, 'session_uploader');
  }
  for (const share of ensureTeamSharingShares(teamSharingState)) {
    if (cleanWorkspaceId && String(share.workspaceId || '').trim() !== cleanWorkspaceId) continue;
    const creator = share.creator || {};
    add({
      humanId: creator.id,
      name: creator.name,
      email: creator.email,
      avatar: creator.avatar,
      aliases: [creator.id, creator.name, creator.email],
    }, 'share_creator');
  }
  return mergeEquivalentMemberCandidates([...byKey.values()])
    .map((candidate) => ({
      ...candidate,
      lastActiveAt: memberLastActiveAt(teamSharingState, candidate),
    }))
    .map(publicMemberCandidate)
    .filter((candidate) => candidate.id || candidate.name || candidate.email)
    .sort((left, right) => String(right.lastActiveAt || '').localeCompare(String(left.lastActiveAt || '')) || String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

function exactMemberMatches(candidates = [], query = '') {
  const normalized = normalizeMemberMatchText(query);
  if (!normalized) return [];
  return asArray(candidates).filter((candidate) => {
    const values = [candidate.id, candidate.userId, candidate.email, candidate.name, ...asArray(candidate.aliases)];
    return values.some((value) => normalizeMemberMatchText(value) === normalized);
  });
}

function partialMemberMatches(candidates = [], query = '') {
  const normalized = normalizeMemberMatchText(query);
  if (!normalized || normalized.length < 2) return [];
  return asArray(candidates).filter((candidate) => {
    const values = [candidate.name, ...asArray(candidate.aliases)].map(normalizeMemberMatchText).filter(Boolean);
    return values.some((value) => value.startsWith(normalized) || value.includes(normalized));
  });
}

function resolveMemberQuery(candidates = [], query = '') {
  const exact = exactMemberMatches(candidates, query);
  if (exact.length) return { status: exact.length === 1 ? 'matched' : 'ambiguous', matches: exact, candidates: exact, matchType: 'exact' };
  const partial = partialMemberMatches(candidates, query);
  if (partial.length) return { status: partial.length === 1 ? 'matched' : 'ambiguous', matches: partial, candidates: partial, matchType: 'partial' };
  return { status: 'not_found', matches: [], candidates: [], matchType: '' };
}

function extractNaturalMemberMention(query = '', candidates = []) {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const candidateNames = asArray(candidates)
    .flatMap((candidate) => [candidate.name, ...asArray(candidate.aliases)])
    .map((value) => String(value || '').trim())
    .filter((value) => /[\u4e00-\u9fa5A-Za-z]/.test(value) && value.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of candidateNames) {
    if (name && text.includes(name)) return { query: name, phrase: name };
  }
  const patterns = [
    /(?:查|找|看|搜索|检索|查看|看看|看一下)\s*(?:同事|成员|上传者|上报者|负责人)?\s*([A-Za-z][A-Za-z0-9_.@-]{1,80}|[\u4e00-\u9fa5]{2,6})(?=\s*(?:关于|的|负责|上传|上报|讨论|会话|$))/i,
    /([A-Za-z][A-Za-z0-9_.@-]{1,80}|[\u4e00-\u9fa5]{2,6})(?=\s*(?:关于|的讨论|的会话|上传|上报|负责))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return { query: match[1].trim(), phrase: match[1].trim() };
  }
  return null;
}

function contentQueryWithoutMember(query = '', phrase = '') {
  let text = String(query || '').replace(/\s+/g, ' ').trim();
  const cleanPhrase = String(phrase || '').trim();
  if (cleanPhrase) text = text.split(cleanPhrase).join(' ');
  return text
    .replace(/^(查|找|看|搜索|检索|查看|看看|看一下)\s*/i, '')
    .replace(/^(同事|成员|上传者|上报者|负责人)\s*/i, '')
    .replace(/^(关于|围绕|的)\s*/i, '')
    .replace(/\s*(的)?(讨论|会话|内容|沉淀)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTeamSharingMembers({ state = {}, teamSharingState = {}, workspaceId = '', body = {}, query = '' } = {}) {
  const candidates = teamSharingMemberCandidates(state, teamSharingState, workspaceId);
  const idQueries = uniqueSearchList([
    ...normalizeSearchList(body.memberIds),
    ...normalizeSearchList(body.memberId),
    ...normalizeSearchList(body.uploaderIds),
    ...normalizeSearchList(body.uploaderId),
    ...normalizeSearchList(body.retrievalIntent?.member?.ids),
  ], 24);
  const nameQueries = uniqueSearchList([
    ...normalizeSearchList(body.memberNames),
    ...normalizeSearchList(body.memberName),
    ...normalizeSearchList(body.members),
    ...normalizeSearchList(body.member),
    ...normalizeSearchList(body.uploaders),
    ...normalizeSearchList(body.uploader),
    ...normalizeSearchList(body.retrievalIntent?.member?.names),
  ], 24);
  const explicitMemberQuery = String(body.memberQuery || body.member_query || '').trim();
  const explicit = Boolean(idQueries.length || nameQueries.length || explicitMemberQuery);
  const inferred = !explicit ? extractNaturalMemberMention(query, candidates) : null;
  const queryItems = [
    ...idQueries,
    ...nameQueries,
    ...(explicitMemberQuery ? [explicitMemberQuery] : []),
    ...(inferred?.query ? [inferred.query] : []),
  ];
  if (!queryItems.length) {
    return {
      status: 'none',
      explicit: false,
      query: '',
      contentQuery: query,
      matched: [],
      candidates: [],
      uploaderIds: [],
      needsClarification: false,
    };
  }
  const matched = new Map();
  const ambiguous = [];
  const notFound = [];
  for (const item of queryItems) {
    const resolved = resolveMemberQuery(candidates, item);
    if (resolved.status === 'matched') {
      const candidate = resolved.matches[0];
      matched.set(candidate.id || candidate.email || candidate.name, candidate);
    } else if (resolved.status === 'ambiguous') {
      ambiguous.push(...resolved.candidates);
    } else {
      notFound.push(item);
    }
  }
  if (ambiguous.length) {
    const uniqueCandidates = [...new Map(ambiguous.map((candidate) => [candidate.id || candidate.email || candidate.name, candidate])).values()]
      .sort((left, right) => String(right.lastActiveAt || '').localeCompare(String(left.lastActiveAt || '')));
    return {
      status: 'ambiguous',
      explicit,
      query: queryItems.join(', '),
      contentQuery: inferred ? contentQueryWithoutMember(query, inferred.phrase) : query,
      matched: [...matched.values()].map(publicMemberCandidate),
      candidates: uniqueCandidates.map(publicMemberCandidate),
      uploaderIds: [],
      needsClarification: true,
    };
  }
  const matchedList = [...matched.values()].map(publicMemberCandidate);
  if (!matchedList.length) {
    if (inferred && !explicit) {
      return {
        status: 'none',
        explicit: false,
        query: '',
        contentQuery: query,
        matched: [],
        candidates: [],
        uploaderIds: [],
        needsClarification: false,
      };
    }
    return {
      status: 'not_found',
      explicit,
      query: queryItems.join(', '),
      contentQuery: inferred ? contentQueryWithoutMember(query, inferred.phrase) : query,
      matched: [],
      candidates: [],
      notFound,
      uploaderIds: [],
      needsClarification: false,
    };
  }
  return {
    status: 'matched',
    explicit,
    query: queryItems.join(', '),
    contentQuery: inferred ? contentQueryWithoutMember(query, inferred.phrase) : query,
    matched: matchedList,
    candidates: [],
    uploaderIds: matchedList.map((candidate) => candidate.id).filter(Boolean),
    needsClarification: false,
  };
}

function uploaderMatchesFilter(doc = {}, uploaderIds = []) {
  const ids = new Set(asArray(uploaderIds).map((value) => String(value || '').trim()).filter(Boolean));
  if (!ids.size) return true;
  const docUploaderId = String(doc.uploaderId || '').trim();
  return Boolean(docUploaderId && ids.has(docUploaderId));
}

function recentUploaderDocuments({ teamSharingState, uploaderIds = [], workspaceId = '', channelId = '', excludeChannelId = '', projectKey = '', dateRange = null, limit = 40 } = {}) {
  const seen = new Set();
  const candidates = asArray(teamSharingState?.vectorDocuments)
    .filter((doc) => doc.active !== false)
    .filter((doc) => !workspaceId || doc.workspaceId === workspaceId)
    .filter((doc) => !channelId || doc.channelId === channelId)
    .filter((doc) => !excludeChannelId || doc.channelId !== excludeChannelId)
    .filter((doc) => !projectKey || doc.projectKey === projectKey)
    .filter((doc) => uploaderMatchesFilter(doc, uploaderIds))
    .filter((doc) => isWithinDateRange(doc.updatedAt, dateRange))
    .filter((doc) => doc.layer === 'L0')
    .map((doc) => {
      const activeAt = String(
        doc.sourceKind === 'share'
          ? ensureTeamSharingShares(teamSharingState).find((share) => String(share.id || '') === String(doc.shareId || ''))?.updatedAt || doc.updatedAt
          : teamSharingState?.sessions?.[doc.sessionId]?.updatedAt || doc.updatedAt,
      ).trim();
      return { ...doc, updatedAt: activeAt || doc.updatedAt || '' };
    })
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .filter((doc) => {
      const key = `${doc.sourceKind || 'session'}:${doc.shareId || doc.sessionId || doc.vectorDocumentId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((doc, index) => ({
      ...doc,
      vectorScore: 0.1,
      keywordScore: 0,
      freshnessScore: Math.max(0.1, 1 - (index * 0.03)),
      finalScore: Math.max(0.1, 1 - (index * 0.03)),
    }));
  return { ok: true, candidates };
}

function keywordSearchInputs({ query = '', keywordQuery = '', keywords = [], topics = [] } = {}) {
  const phrases = uniqueSearchList([
    ...normalizeSearchList(keywords),
    ...normalizeSearchList(topics),
    ...normalizeSearchList(keywordQuery),
  ], 40);
  const terms = uniqueSearchList([
    ...phrases.flatMap((phrase) => queryTerms(phrase)),
    ...queryTerms(query),
  ], 80);
  return { phrases, terms };
}

function localVectorSearch({ teamSharingState, query = '', workspaceId = '', channelId = '', excludeChannelId = '', projectKey = '', uploaderIds = [], dateRange = null, limit = 40 } = {}) {
  const terms = queryTerms(query);
  const candidates = asArray(teamSharingState?.vectorDocuments)
    .filter((doc) => doc.active !== false)
    .filter((doc) => !workspaceId || doc.workspaceId === workspaceId)
    .filter((doc) => !channelId || doc.channelId === channelId)
    .filter((doc) => !excludeChannelId || doc.channelId !== excludeChannelId)
    .filter((doc) => !projectKey || doc.projectKey === projectKey)
    .filter((doc) => uploaderMatchesFilter(doc, uploaderIds))
    .filter((doc) => isWithinDateRange(doc.updatedAt, dateRange))
    .map((doc) => {
      const haystack = `${doc.title || ''}\n${doc.topicId || ''}\n${doc.text || ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const keywordScore = terms.length ? matchedTerms.length / terms.length : 0;
      const vectorScore = Math.max(0.05, keywordScore || (doc.layer === 'L0' ? 0.15 : 0.1));
      return {
        ...doc,
        vectorScore,
        keywordScore,
        freshnessScore: 0.5,
      };
    })
    .sort((left, right) => right.vectorScore - left.vectorScore || String(left.vectorDocumentId).localeCompare(String(right.vectorDocumentId)))
    .slice(0, limit);
  return { ok: true, candidates };
}

function localKeywordSearch({ teamSharingState, query = '', keywordQuery = '', keywords = [], topics = [], workspaceId = '', channelId = '', excludeChannelId = '', projectKey = '', uploaderIds = [], dateRange = null, limit = 40 } = {}) {
  const { phrases, terms } = keywordSearchInputs({ query, keywordQuery, keywords, topics });
  const candidates = asArray(teamSharingState?.vectorDocuments)
    .filter((doc) => doc.active !== false)
    .filter((doc) => !workspaceId || doc.workspaceId === workspaceId)
    .filter((doc) => !channelId || doc.channelId === channelId)
    .filter((doc) => !excludeChannelId || doc.channelId !== excludeChannelId)
    .filter((doc) => !projectKey || doc.projectKey === projectKey)
    .filter((doc) => uploaderMatchesFilter(doc, uploaderIds))
    .filter((doc) => isWithinDateRange(doc.updatedAt, dateRange))
    .map((doc) => {
      const haystack = `${doc.title || ''}\n${doc.topicId || ''}\n${doc.text || ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const termScore = terms.length ? matchedTerms.length / terms.length : 0;
      const matchedPhrases = phrases.filter((phrase) => haystack.includes(String(phrase || '').toLowerCase()));
      const phraseScore = phrases.length ? matchedPhrases.length / phrases.length : 0;
      const topicScore = topics.length
        ? normalizeSearchList(topics).filter((topic) => haystack.includes(String(topic || '').toLowerCase())).length / normalizeSearchList(topics).length
        : 0;
      const keywordScore = clamp01((0.50 * phraseScore) + (0.35 * termScore) + (0.15 * topicScore));
      return {
        ...doc,
        vectorScore: Number(doc.vectorScore || 0.05),
        keywordScore,
        freshnessScore: 0.5,
      };
    })
    .filter((doc) => doc.keywordScore > 0)
    .sort((left, right) => right.keywordScore - left.keywordScore || String(left.vectorDocumentId).localeCompare(String(right.vectorDocumentId)))
    .slice(0, limit);
  return { ok: true, candidates };
}

function fuseTeamSharingCandidates({ semanticCandidates = [], keywordCandidates = [], limit = 40, rrfK = 30 } = {}) {
  const byId = new Map();
  const add = (candidate, source, index) => {
    const id = String(candidate?.vectorDocumentId || '').trim();
    if (!id) return;
    const existing = byId.get(id) || {
      ...candidate,
      vectorScore: 0,
      keywordScore: 0,
      rrfScore: 0,
      retrievalSources: [],
    };
    existing.rrfScore += 1 / (rrfK + index + 1);
    if (!existing.retrievalSources.includes(source)) existing.retrievalSources.push(source);
    if (source === 'semantic') {
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? candidate.score));
    } else {
      existing.keywordScore = Math.max(clamp01(existing.keywordScore), clamp01(candidate.keywordScore ?? candidate.score));
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? 0.05));
    }
    byId.set(id, { ...existing, ...candidate, rrfScore: existing.rrfScore, retrievalSources: existing.retrievalSources, vectorScore: existing.vectorScore, keywordScore: existing.keywordScore });
  };
  asArray(semanticCandidates).forEach((candidate, index) => add(candidate, 'semantic', index));
  asArray(keywordCandidates).forEach((candidate, index) => add(candidate, 'keyword', index));
  return [...byId.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore || right.keywordScore - left.keywordScore || right.vectorScore - left.vectorScore)
    .slice(0, limit);
}

function localRerank({ query = '', candidates = [] } = {}) {
  const terms = queryTerms(query);
  return asArray(candidates).map((candidate, index) => {
    const haystack = `${candidate.title || ''}\n${candidate.topicId || ''}\n${candidate.text || ''}`.toLowerCase();
    const matches = terms.filter((term) => haystack.includes(term)).length;
    return {
      index,
      score: terms.length ? matches / terms.length : Number(candidate.vectorScore || 0),
    };
  });
}

function actorWorkspaceId(actor, state) {
  return String(actor?.member?.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim();
}

function requestWorkspaceId({ actor = null, tokenRecord = null, state = {}, fallback = '' } = {}) {
  return String(
    actor?.member?.workspaceId
      || tokenRecord?.workspaceId
      || fallback
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || 'local',
  ).trim();
}

function actorHumanId(actor) {
  return String(actor?.member?.humanId || actor?.human?.id || 'hum_local').trim();
}

function dependencyReady(fn, envKeys = []) {
  if (typeof fn === 'function') return Boolean(fn());
  return envKeys.every((key) => String(process.env[key] || '').trim());
}

function hashSecret(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken(prefix = 'tm') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function bearerToken(req) {
  return String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

function normalizeMachineFingerprint(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return MACHINE_FINGERPRINT_PATTERN.test(clean) ? clean : '';
}

function machineFingerprintForRequest(req) {
  const header = req?.headers?.['x-magclaw-machine-fingerprint'];
  return normalizeMachineFingerprint(Array.isArray(header) ? header[0] : header);
}

function ensureTeamSharingAuthState(teamSharingState = {}) {
  teamSharingState.auth = teamSharingState.auth && typeof teamSharingState.auth === 'object' ? teamSharingState.auth : {};
  teamSharingState.auth.deviceRequests = teamSharingState.auth.deviceRequests && typeof teamSharingState.auth.deviceRequests === 'object' ? teamSharingState.auth.deviceRequests : {};
  teamSharingState.auth.tokens = teamSharingState.auth.tokens && typeof teamSharingState.auth.tokens === 'object' ? teamSharingState.auth.tokens : {};
  teamSharingState.auth.throttle = teamSharingState.auth.throttle && typeof teamSharingState.auth.throttle === 'object' ? teamSharingState.auth.throttle : {};
  return teamSharingState.auth;
}

function normalizeIds(values = []) {
  return [...new Set(asArray(values).map((item) => String(item || '').trim()).filter(Boolean))];
}

function requestIpHash(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = String(req?.socket?.remoteAddress || '').trim();
  return hashSecret(forwarded || remote || 'unknown').slice(0, 16);
}

function consumeTeamSharingAuthThrottle(auth = {}, key = '', { limit, windowMs = TEAM_SHARING_AUTH_THROTTLE_WINDOW_MS } = {}) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return true;
  auth.throttle = auth.throttle && typeof auth.throttle === 'object' ? auth.throttle : {};
  const nowMs = Date.now();
  const cutoff = nowMs - windowMs;
  const previous = Array.isArray(auth.throttle[cleanKey])
    ? auth.throttle[cleanKey].filter((item) => Number(item) > cutoff)
    : [];
  if (previous.length >= limit) {
    auth.throttle[cleanKey] = previous;
    return false;
  }
  previous.push(nowMs);
  auth.throttle[cleanKey] = previous;
  return true;
}

function teamSharingSetupTargetFromChannelPath(channelPath = '') {
  const raw = String(channelPath || '').trim();
  if (!raw) return null;
  const parsed = parseChannelImportPath(raw);
  if (!parsed.ok) {
    const error = new Error('Invalid MagClaw channel path.');
    error.status = 400;
    error.code = parsed.error || 'invalid_channel_path';
    throw error;
  }
  return {
    kind: 'signed_channel_path',
    serverId: parsed.serverId,
    channelId: parsed.channelId,
    routeKeyHash: hashSecret(parsed.routeKey),
    pathHash: hashSecret(parsed.raw).slice(0, 24),
  };
}

function ensureCloudCollections(state = {}) {
  state.cloud = state.cloud && typeof state.cloud === 'object' ? state.cloud : {};
  state.cloud.workspaces = Array.isArray(state.cloud.workspaces) ? state.cloud.workspaces : [];
  state.cloud.workspaceMembers = Array.isArray(state.cloud.workspaceMembers) ? state.cloud.workspaceMembers : [];
  state.cloud.users = Array.isArray(state.cloud.users) ? state.cloud.users : [];
  state.humans = Array.isArray(state.humans) ? state.humans : [];
  state.channels = Array.isArray(state.channels) ? state.channels : [];
  return state.cloud;
}

function workspaceForSetupTarget(state = {}, serverId = '') {
  const cleanServerId = String(serverId || '').trim();
  const cloud = ensureCloudCollections(state);
  const candidates = [
    ...cloud.workspaces,
    cloud.workspace,
  ].filter(Boolean);
  const workspace = candidates.find((item) => (
    !item.deletedAt
    && String(item.id || '').trim() === cleanServerId
  ));
  if (workspace) return workspace;
  const currentWorkspaceId = String(state.connection?.workspaceId || cloud.workspace?.id || '').trim();
  if (cleanServerId && (cleanServerId === currentWorkspaceId || cleanServerId === 'local')) {
    return {
      id: currentWorkspaceId || cleanServerId,
      slug: cloud.workspace?.slug || currentWorkspaceId || cleanServerId,
      name: state.connection?.name || cloud.workspace?.name || 'Server',
    };
  }
  return null;
}

function channelWorkspaceId(channel = {}, state = {}) {
  return String(
    channel.workspaceId
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || 'local',
  ).trim();
}

function findSetupChannel(state = {}, target = {}) {
  const cleanChannelId = String(target.channelId || '').trim();
  const cleanWorkspaceId = String(target.serverId || '').trim();
  if (!cleanChannelId || !cleanWorkspaceId) return null;
  return asArray(state.channels).find((channel) => (
    String(channel?.id || '').trim() === cleanChannelId
    && channelWorkspaceId(channel, state) === cleanWorkspaceId
  )) || null;
}

async function loadSetupChannelIfNeeded({ state, target, loadWorkspaceIntoState }) {
  let channel = findSetupChannel(state, target);
  if (!channel && typeof loadWorkspaceIntoState === 'function') {
    await loadWorkspaceIntoState(state, target.serverId);
    channel = findSetupChannel(state, target);
  }
  return channel;
}

function setupChannelUrl(req, workspace = {}, channel = {}) {
  const slug = String(workspace.slug || workspace.id || '').trim();
  const channelId = String(channel.id || '').trim();
  if (!slug || !channelId) return '';
  return `${publicUrlFromRequest(req)}/s/${encodeURIComponent(slug)}/channels/${encodeURIComponent(channelId)}`;
}

function ensureTeamSharingHumanForUser({ state, user, member = null, workspaceId, makeId, now }) {
  ensureCloudCollections(state);
  const timestamp = now();
  const cleanWorkspaceId = String(workspaceId || '').trim();
  let human = member?.humanId ? state.humans.find((item) => item.id === member.humanId) : null;
  if (human && human.id === 'hum_local' && user?.id && human.authUserId !== user.id) human = null;
  if (!human) {
    human = state.humans.find((item) => (
      item
      && item.status !== 'removed'
      && (item.authUserId === user.id || item.userId === user.id)
      && String(item.workspaceId || cleanWorkspaceId) === cleanWorkspaceId
    )) || null;
  }
  if (!human) {
    const email = String(user.email || '').trim();
    human = email
      ? state.humans.find((item) => (
        item
        && item.status !== 'removed'
        && !item.authUserId
        && String(item.email || '').trim().toLowerCase() === email.toLowerCase()
        && String(item.workspaceId || cleanWorkspaceId) === cleanWorkspaceId
      )) || null
      : null;
  }
  if (!human) {
    human = {
      id: makeId('hum'),
      workspaceId: cleanWorkspaceId,
      name: user.name || user.email?.split('@')[0] || 'Human',
      email: user.email || '',
      role: 'member',
      status: 'online',
      createdAt: timestamp,
    };
    state.humans.push(human);
  }
  human.workspaceId = human.workspaceId || cleanWorkspaceId;
  human.authUserId = user.id;
  human.userId = human.userId || user.id;
  human.name = user.name || human.name || user.email || human.id;
  human.email = user.email || human.email || '';
  human.avatar = user.avatar || user.avatarUrl || human.avatar || '';
  human.avatarUrl = user.avatarUrl || user.avatar || human.avatarUrl || '';
  human.role = human.role || 'member';
  human.status = 'online';
  human.lastSeenAt = timestamp;
  human.presenceUpdatedAt = timestamp;
  human.updatedAt = timestamp;
  delete human.removedAt;
  return human;
}

function addHumanToSetupChannel(channel = {}, humanId = '', now) {
  const cleanHumanId = String(humanId || '').trim();
  if (!cleanHumanId) return false;
  const previousMembers = normalizeIds(channel.memberIds || []);
  const previousHumans = normalizeIds(channel.humanIds || []);
  const nextMembers = normalizeIds([...previousMembers, cleanHumanId]);
  const nextHumans = normalizeIds([...previousHumans, cleanHumanId]);
  const changed = nextMembers.length !== previousMembers.length || nextHumans.length !== previousHumans.length;
  channel.memberIds = nextMembers;
  channel.humanIds = nextHumans;
  if (changed) channel.updatedAt = now();
  return changed;
}

async function upsertSetupChannelMember({ channel, humanId, workspaceId, req, upsertChannelMember, now }) {
  if (!humanId?.startsWith?.('hum_') || typeof upsertChannelMember !== 'function') return;
  await upsertChannelMember({
    workspaceId,
    channelId: channel.id,
    humanId,
    joinedAt: now(),
  });
}

// TODO(team-sharing): tighten this MVP with tenant/domain allowlists, path TTL or one-time setup tokens, and an admin-controlled setup-path policy.
async function ensureTeamSharingSetupMembership({
  req,
  request,
  user,
  state,
  auth,
  addSystemEvent,
  loadWorkspaceIntoState,
  makeId,
  now,
  upsertChannelMember,
}) {
  if (!request?.setupTarget) return null;
  if (!user?.id) {
    const error = new Error('Login is required.');
    error.status = 401;
    throw error;
  }
  const target = request.setupTarget;
  const approveKey = `approve:${String(user.id)}:${target.serverId}:${target.channelId}`;
  if (!consumeTeamSharingAuthThrottle(auth, approveKey, { limit: TEAM_SHARING_AUTH_APPROVE_LIMIT })) {
    const error = new Error('Too many Team Sharing setup approval attempts.');
    error.status = 429;
    throw error;
  }
  const workspace = workspaceForSetupTarget(state, target.serverId);
  if (!workspace) {
    const error = new Error('Team Sharing setup server was not found.');
    error.status = 404;
    throw error;
  }
  const channel = await loadSetupChannelIfNeeded({ state, target, loadWorkspaceIntoState });
  if (!channel) {
    const error = new Error('Team Sharing setup channel was not found.');
    error.status = 404;
    throw error;
  }
  if (channel.archived || channel.archivedAt) {
    const error = new Error('Archived channels cannot be joined.');
    error.status = 400;
    throw error;
  }
  const expectedKeyHash = hashSecret(channelFeishuRouteKey(channel));
  if (!target.routeKeyHash || expectedKeyHash !== target.routeKeyHash) {
    const error = new Error('Team Sharing setup path is invalid or has been rotated.');
    error.status = 403;
    throw error;
  }

  const cloud = ensureCloudCollections(state);
  const timestamp = now();
  let member = cloud.workspaceMembers.find((item) => (
    item.userId === user.id
    && item.workspaceId === workspace.id
  )) || null;
  const alreadyMember = Boolean(member && member.status === 'active');
  const human = ensureTeamSharingHumanForUser({ state, user, member, workspaceId: workspace.id, makeId, now });
  let joinedServer = false;
  if (!member) {
    member = {
      id: makeId('wmem'),
      workspaceId: workspace.id,
      userId: user.id,
      humanId: human.id,
      role: 'member',
      status: 'active',
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    cloud.workspaceMembers.push(member);
    joinedServer = true;
  } else {
    member.humanId = member.humanId || human.id;
    member.role = member.role || 'member';
    if (member.status !== 'active') joinedServer = true;
    member.status = 'active';
    member.joinedAt ||= timestamp;
    member.updatedAt = timestamp;
  }

  const allChannelResult = ensureWorkspaceAllChannel({
    state,
    workspaceId: workspace.id,
    workspace,
    humanIds: [human.id],
    makeId,
    now,
    normalizeIds,
  });
  if (allChannelResult.changed && allChannelResult.channel) {
    await upsertSetupChannelMember({ channel: allChannelResult.channel, humanId: human.id, workspaceId: workspace.id, req, upsertChannelMember, now });
  }

  const wasInChannel = normalizeIds([...(channel.memberIds || []), ...(channel.humanIds || [])]).includes(human.id);
  const joinedChannel = addHumanToSetupChannel(channel, human.id, now);
  if (joinedChannel) {
    await upsertSetupChannelMember({ channel, humanId: human.id, workspaceId: workspace.id, req, upsertChannelMember, now });
  }

  const onboardingTarget = {
    joinedServer,
    joinedChannel,
    alreadyMember,
    alreadyInChannel: wasInChannel,
    serverId: workspace.id,
    workspaceId: workspace.id,
    serverSlug: workspace.slug || workspace.id,
    serverName: workspace.name || workspace.slug || workspace.id,
    channelId: channel.id,
    channelName: channel.name || channel.id,
    channelUrl: setupChannelUrl(req, workspace, channel),
  };
  addSystemEvent('team_sharing_setup_auto_joined', 'Team Sharing setup target joined.', {
    workspaceId: workspace.id,
    channelId: channel.id,
    userId: user.id,
    humanId: human.id,
    joinedServer,
    joinedChannel,
    alreadyMember,
    alreadyInChannel: wasInChannel,
    profile: request.profile || 'default',
    platform: request.client?.platform || '',
    arch: request.client?.arch || '',
    hostnameHash: request.client?.hostname ? hashSecret(request.client.hostname).slice(0, 16) : '',
    requestId: request.userCode || '',
    pathHash: target.pathHash || '',
  });
  return {
    user,
    member,
    human,
    workspace,
    channel,
    onboardingTarget,
  };
}

function tokenRecordForRequest(teamSharingState = {}, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const record = ensureTeamSharingAuthState(teamSharingState).tokens[hashSecret(token)];
  if (!record || record.revoked) return null;
  const expiresAtMs = Date.parse(record.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return null;
  const expectedFingerprint = normalizeMachineFingerprint(record.machineFingerprint || '');
  if (expectedFingerprint && machineFingerprintForRequest(req) !== expectedFingerprint) return null;
  return record;
}

function teamSharingTokenIssueForRequest(teamSharingState = {}, req) {
  const token = bearerToken(req);
  if (!token) return { reason: 'login_required', status: 401 };
  const record = ensureTeamSharingAuthState(teamSharingState).tokens[hashSecret(token)];
  if (!record || record.revoked) return { reason: 'login_required', status: 401 };
  const expiresAtMs = Date.parse(record.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    return { reason: 'login_expired', status: 401 };
  }
  const expectedFingerprint = normalizeMachineFingerprint(record.machineFingerprint || '');
  if (expectedFingerprint && machineFingerprintForRequest(req) !== expectedFingerprint) {
    return { reason: 'machine_mismatch', status: 401 };
  }
  return null;
}

function requestUser(actor = {}) {
  return {
    id: actorHumanId(actor),
    email: actor?.member?.email || actor?.user?.email || '',
    name: actor?.member?.name || actor?.user?.name || '',
    avatar: actor?.member?.avatar || actor?.user?.avatar || '',
  };
}

function teamSharingRequestUser({ actor = null, tokenRecord = null, body = {} } = {}) {
  const authenticatedUser = actor
    ? requestUser(actor)
    : (tokenRecord?.user && typeof tokenRecord.user === 'object' ? tokenRecord.user : null);
  const id = String(authenticatedUser?.id || body.humanId || body.uploaderId || '').trim();
  return {
    id: id || 'hum_local',
    name: String(authenticatedUser?.name || body.humanName || body.uploaderName || body.userName || '').trim(),
    email: String(authenticatedUser?.email || body.humanEmail || body.uploaderEmail || '').trim(),
    avatar: String(authenticatedUser?.avatar || body.humanAvatar || body.uploaderAvatar || '').trim(),
  };
}

function requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken } = {}) {
  const required = typeof teamSharingAuthRequired === 'function' ? teamSharingAuthRequired(req) : Boolean(teamSharingAuthRequired);
  if (!required || actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  if (tokenRecordForRequest(teamSharingState, req)) return true;
  sendError(res, 401, 'Team sharing login or scoped token is required.');
  return false;
}

function requestHasTeamSharingAuth(req, { actor, teamSharingState, teamSharingAuthRequired, validTeamSharingToken } = {}) {
  const required = typeof teamSharingAuthRequired === 'function' ? teamSharingAuthRequired(req) : Boolean(teamSharingAuthRequired);
  if (!required || actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  return Boolean(tokenRecordForRequest(teamSharingState, req));
}

function requestHasTeamSharingIdentity(req, { actor, teamSharingState, validTeamSharingToken } = {}) {
  if (actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  return Boolean(tokenRecordForRequest(teamSharingState, req));
}

function safeRelativePathFromUrl(url) {
  const path = `${url?.pathname || '/'}${url?.search || ''}`;
  return path.startsWith('/') && !path.startsWith('//') ? path : '/console';
}

function redirectToLoginWithReturnTo(res, url) {
  const returnTo = safeRelativePathFromUrl(url);
  const location = `/?returnTo=${encodeURIComponent(returnTo)}`;
  res.writeHead?.(302, { location, 'cache-control': 'no-store' });
  res.end?.('');
}

function workspaceForTeamSharingJoin(state = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local') return null;
  const cloud = ensureCloudCollections(state);
  return asArray(cloud.workspaces).find((workspace) => (
    workspace
    && !workspace.deletedAt
    && String(workspace.id || '').trim() === cleanWorkspaceId
  )) || null;
}

function accessJoinLinkExpiresAt(createdAt = '') {
  const createdMs = Date.parse(createdAt || '');
  const baseMs = Number.isFinite(createdMs) ? createdMs : Date.now();
  return new Date(baseMs + TEAM_SHARING_ACCESS_JOIN_LINK_TTL_MS).toISOString();
}

function uniqueTeamSharingJoinToken(state = {}) {
  const cloud = ensureCloudCollections(state);
  cloud.joinLinks = Array.isArray(cloud.joinLinks) ? cloud.joinLinks : [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const raw = randomToken('mc_join');
    const tokenHash = hashSecret(raw);
    if (!cloud.joinLinks.some((link) => link.tokenHash === tokenHash)) return { raw, tokenHash };
  }
  throw new Error('Unable to create Team Sharing join link.');
}

function createTeamSharingAccessJoinLink({ state, workspaceId = '', boundUser = null, makeId, now } = {}) {
  const cloud = ensureCloudCollections(state);
  cloud.joinLinks = Array.isArray(cloud.joinLinks) ? cloud.joinLinks : [];
  const workspace = workspaceForTeamSharingJoin(state, workspaceId);
  if (!workspace) return null;
  const boundUserId = String(boundUser?.id || '').trim();
  if (!boundUserId) return null;
  const createdAt = typeof now === 'function' ? now() : new Date().toISOString();
  const { raw, tokenHash } = uniqueTeamSharingJoinToken(state);
  const joinLink = {
    id: typeof makeId === 'function' ? makeId('jlink') : randomToken('jlink'),
    workspaceId: workspace.id,
    tokenHash,
    maxUses: 1,
    usedCount: 0,
    expiresAt: accessJoinLinkExpiresAt(createdAt),
    revokedAt: null,
    createdBy: boundUserId,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      rawToken: raw,
      purpose: 'team_sharing_access',
      boundUserId,
    },
  };
  cloud.joinLinks.push(joinLink);
  return { raw, joinLink, workspace };
}

async function redirectToJoinWithReturnTo(res, url, {
  state,
  workspaceId = '',
  currentUser = null,
  makeId,
  now,
  persistState,
  addSystemEvent,
  reason = 'team_sharing_access_join_redirect',
} = {}) {
  const created = createTeamSharingAccessJoinLink({ state, workspaceId, boundUser: currentUser, makeId, now });
  if (!created?.raw) return false;
  const returnTo = safeRelativePathFromUrl(url);
  const location = `/join/${encodeURIComponent(created.raw)}?returnTo=${encodeURIComponent(returnTo)}`;
  addSystemEvent?.('team_sharing_join_redirect_created', 'Team Sharing access redirected to server join.', {
    workspaceId: created.workspace.id,
    joinLinkId: created.joinLink.id,
    returnPath: returnTo,
  });
  await persistState?.({ workspaceId: created.workspace.id, reason });
  res.writeHead?.(302, { location, 'cache-control': 'no-store' });
  res.end?.('');
  return true;
}

function parseTeamSharingInspectableLink(raw = '', baseUrl = '') {
  const clean = String(raw || '').trim();
  if (!clean) return { ok: false, reason: 'unsupported_link' };
  let parsed;
  try {
    parsed = new URL(clean, `${String(baseUrl || 'https://magclaw.invalid').replace(/\/+$/, '')}/`);
  } catch {
    return { ok: false, reason: 'unsupported_link' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_link' };
  }
  const scopedWorkspaceFile = parsed.pathname.match(/^\/s\/([^/]+)\/team-sharing\/workspace\/([^/]+)\/file\/?$/);
  if (scopedWorkspaceFile) {
    return {
      ok: true,
      kind: 'workspace_file',
      url: parsed,
      serverSlug: decodeURIComponent(scopedWorkspaceFile[1] || ''),
      sessionId: decodeURIComponent(scopedWorkspaceFile[2] || ''),
      path: normalizeTeamSharingWorkspaceFilePath(parsed.searchParams.get('path') || ''),
    };
  }
  const workspaceFile = parsed.pathname.match(/^\/team-sharing\/workspace\/([^/]+)\/file\/?$/);
  if (workspaceFile) {
    return {
      ok: true,
      kind: 'workspace_file',
      url: parsed,
      sessionId: decodeURIComponent(workspaceFile[1] || ''),
      path: normalizeTeamSharingWorkspaceFilePath(parsed.searchParams.get('path') || ''),
    };
  }
  const scopedContext = parsed.pathname.match(/^\/s\/([^/]+)\/team-sharing\/context\/([^/]+)\/?$/);
  if (scopedContext) {
    return {
      ok: true,
      kind: 'context',
      url: parsed,
      serverSlug: decodeURIComponent(scopedContext[1] || ''),
      sessionId: decodeURIComponent(scopedContext[2] || ''),
    };
  }
  const context = parsed.pathname.match(/^\/team-sharing\/context\/([^/]+)\/?$/);
  if (context) {
    return {
      ok: true,
      kind: 'context',
      url: parsed,
      sessionId: decodeURIComponent(context[1] || ''),
    };
  }
  const knowledgeDoc = parsed.pathname.match(/^\/s\/([^/]+)\/knowledge\/docs\/([^/]+)\/?$/);
  if (knowledgeDoc) {
    return {
      ok: true,
      kind: 'knowledge_doc',
      url: parsed,
      serverSlug: decodeURIComponent(knowledgeDoc[1] || ''),
      docId: decodeURIComponent(knowledgeDoc[2] || ''),
    };
  }
  const share = parsed.pathname.match(/^\/s\/([^/]+)\/?$/) || parsed.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (share) {
    return {
      ok: true,
      kind: 'share',
      url: parsed,
      shareId: decodeURIComponent(share[1] || ''),
    };
  }
  return { ok: false, reason: 'unsupported_link' };
}

function inspectableTargetForLink(teamSharingState = {}, state = {}, parsed = {}) {
  if (parsed.kind === 'knowledge_doc') {
    const workspace = workspaceByIdOrSlug(state, parsed.serverSlug);
    const workspaceId = String(workspace?.id || parsed.serverSlug || '').trim();
    const space = ensureKnowledgeSpace(state, workspaceId || 'local');
    const doc = getKnowledgeDocument(space, parsed.docId);
    if (!doc) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        kind: 'knowledge_doc',
        target: { serverSlug: parsed.serverSlug || '', docId: parsed.docId || '' },
        error: 'Knowledge document not found.',
      };
    }
    return {
      ok: true,
      kind: 'knowledge_doc',
      workspaceId,
      document: doc,
      target: {
        serverSlug: String(parsed.serverSlug || '').trim(),
        docId: String(parsed.docId || '').trim(),
        title: String(doc.title || '').trim(),
        workspaceId,
        server: publicTeamSharingServer(state, workspaceId),
      },
    };
  }
  if (parsed.kind === 'share') {
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === parsed.shareId && item.revokedAt == null);
    if (!share) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        kind: 'share',
        target: { shareId: parsed.shareId || '' },
        error: 'Shared page not found.',
      };
    }
    const workspaceId = String(share.workspaceId || '').trim();
    return {
      ok: true,
      kind: 'share',
      share,
      workspaceId,
      target: {
        shareId: String(share.id || '').trim(),
        title: String(share.title || '').trim(),
        workspaceId,
        server: publicTeamSharingServer(state, workspaceId),
      },
    };
  }
  if (parsed.kind === 'workspace_file') {
    const workspace = buildTeamSharingWorkspace(teamSharingState, parsed.sessionId);
    if (!workspace) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        kind: 'workspace_file',
        target: { sessionId: parsed.sessionId || '', path: parsed.path || '', serverSlug: parsed.serverSlug || '' },
        error: 'Team sharing workspace file not found.',
      };
    }
    const file = teamSharingWorkspaceFileByPath(workspace, parsed.path);
    if (!file) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        kind: 'workspace_file',
        target: { sessionId: parsed.sessionId || '', path: parsed.path || '', serverSlug: parsed.serverSlug || '' },
        error: 'Team sharing workspace file not found.',
      };
    }
    const workspaceId = String(workspace.session?.workspaceId || '').trim();
    return {
      ok: true,
      kind: 'workspace_file',
      session: workspace.session,
      workspaceId,
      target: {
        sessionId: String(parsed.sessionId || '').trim(),
        title: String(workspace.session?.title || '').trim(),
        path: String(file.path || '').trim(),
        name: String(file.name || '').trim(),
        workspaceId,
        serverSlug: String(parsed.serverSlug || '').trim(),
        server: publicTeamSharingServer(state, workspaceId),
      },
    };
  }
  if (parsed.kind === 'context') {
    const session = teamSharingState.sessions?.[parsed.sessionId] || null;
    if (!session) {
      return {
        ok: false,
        status: 404,
        reason: 'not_found',
        kind: 'context',
        target: { sessionId: parsed.sessionId || '', serverSlug: parsed.serverSlug || '' },
        error: 'Team sharing session not found.',
      };
    }
    const workspaceId = String(session.workspaceId || '').trim();
    return {
      ok: true,
      kind: 'context',
      session,
      workspaceId,
      target: {
        sessionId: String(parsed.sessionId || '').trim(),
        title: String(session.title || '').trim(),
        workspaceId,
        serverSlug: String(parsed.serverSlug || '').trim(),
        server: publicTeamSharingServer(state, workspaceId),
      },
    };
  }
  return {
    ok: false,
    status: 400,
    reason: 'unsupported_link',
    kind: '',
    target: {},
    error: 'Only MagClaw Team Sharing share/context links are supported.',
  };
}

function workspaceIdForKnowledgeTarget(state = {}, value = '', fallback = '') {
  const clean = String(value || '').trim();
  const workspace = workspaceByIdOrSlug(state, clean);
  return String(workspace?.id || clean || fallback || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim();
}

function knowledgeActorForTeamSharingIdentity({ actor = null, currentUser = null, tokenRecord = null, state = {}, workspaceId = '' } = {}) {
  const cleanWorkspaceId = String(workspaceId || '').trim() || 'local';
  if (actor?.member && String(actor.member.workspaceId || cleanWorkspaceId).trim() === cleanWorkspaceId) return actor;
  if (cleanWorkspaceId === 'local') {
    return {
      member: { workspaceId: cleanWorkspaceId, humanId: 'local', role: 'owner', status: 'active' },
      user: { id: 'local', name: 'Local User' },
    };
  }
  const identity = tokenRecord?.user || currentUser || {};
  const member = activeWorkspaceMemberForIdentity(state, identity, cleanWorkspaceId);
  if (!member && tokenRecord && String(tokenRecord.workspaceId || '').trim() !== cleanWorkspaceId) return null;
  const humanId = String(member?.humanId || member?.id || identity.id || identity.userId || '').trim();
  if (!humanId) return null;
  return {
    member: {
      workspaceId: cleanWorkspaceId,
      humanId,
      role: String(member?.role || 'member').trim(),
      status: String(member?.status || 'active').trim(),
      email: String(member?.email || identity.email || '').trim(),
      name: String(member?.name || identity.name || '').trim(),
    },
    user: {
      id: String(identity.id || member?.userId || humanId).trim(),
      email: String(identity.email || member?.email || '').trim(),
      name: String(identity.name || member?.name || '').trim(),
    },
  };
}

function teamSharingKnowledgeAccess({ req, actor = null, currentUser = null, teamSharingState = {}, state = {}, workspaceId = '' } = {}) {
  const tokenRecord = actor ? null : tokenRecordForRequest(teamSharingState, req);
  const tokenAccess = tokenWorkspaceAccess(state, tokenRecord, workspaceId, 'This Knowledge Space belongs to another server.');
  if (tokenAccess && !tokenAccess.ok) return { ...tokenAccess, actor: null };
  if (!actor && !currentUser && !tokenRecord) return { ok: false, status: 401, reason: 'login_required', error: 'Team Sharing CLI login is required.', actor: null };
  const effectiveActor = knowledgeActorForTeamSharingIdentity({ actor, currentUser, tokenRecord, state, workspaceId });
  if (!effectiveActor) return { ok: false, status: 403, reason: 'server_membership_required', error: 'Join this server before reading Knowledge Space.', actor: null };
  return {
    ok: true,
    status: 200,
    reason: 'ok',
    workspaceId,
    actorId: actorHumanId(effectiveActor),
    via: tokenAccess?.via || (actor ? 'browser' : tokenRecord ? 'token' : 'browser'),
    actor: effectiveActor,
  };
}

function sendTeamSharingKnowledgeAccessError(sendJson, res, access = {}, fallback = 'Knowledge Space access denied.') {
  sendJson(res, access.status || 403, {
    ok: false,
    reason: access.reason || (access.status === 401 ? 'login_required' : 'server_membership_required'),
    error: access.error || fallback,
  });
}

function teamSharingLinkAction({ reason = '', serverUrl = '', originalUrl = '' } = {}) {
  const cleanReason = String(reason || '').trim();
  if (cleanReason === 'ok') return { type: 'read_link' };
  if (cleanReason === 'login_required' || cleanReason === 'login_expired' || cleanReason === 'machine_mismatch') {
    const message = cleanReason === 'machine_mismatch'
      ? 'Re-login to MagClaw Team Sharing on this machine.'
      : cleanReason === 'login_expired'
        ? 'Team Sharing CLI login expired; login again.'
        : 'Team Sharing CLI login is required.';
    return {
      type: 'login',
      command: `team-sharing login --server-url ${String(serverUrl || '').trim()}`,
      message,
    };
  }
  if (cleanReason === 'server_membership_required') {
    return {
      type: 'open_browser_to_join',
      url: String(originalUrl || '').trim(),
      message: 'Open this MagClaw link in the browser, sign in, and join the server.',
    };
  }
  return { type: 'none' };
}

function teamSharingAuthApprovedHtml(onboardingTarget = {}) {
  const channelUrl = String(onboardingTarget?.channelUrl || '').trim();
  const channelName = String(onboardingTarget?.channelName || '').trim();
  const channelLink = channelUrl
    ? `<p class="hint"><a href="${htmlEscape(channelUrl)}">Open ${htmlEscape(channelName || 'the Team Sharing channel')}</a></p>`
    : '<p class="hint">You can return to the CLI.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Team Sharing login successful</title>
  <style>
    :root { --accent: #ff66cc; --accent-strong: #ff5fa2; --ink: #1a1a1a; --cream: #fffaf7; --soft: #fff2f8; --muted: #5f4c5a; }
    * { box-sizing: border-box; }
    body {
      position: relative;
      min-height: 100vh;
      margin: 0;
      overflow: hidden auto;
      font-family: "Courier New", "IBM Plex Mono", Menlo, monospace;
      background: var(--cream);
      color: var(--ink);
      isolation: isolate;
    }
    body::before,
    body::after {
      content: "";
      position: fixed;
      z-index: 0;
      pointer-events: none;
      background: url("/brand/magclaw-logo.png") center / contain no-repeat;
    }
    body::before {
      width: clamp(420px, 76vmax, 1040px);
      height: clamp(420px, 76vmax, 1040px);
      left: calc(50% - clamp(320px, 40vmax, 630px));
      top: calc(50% - clamp(330px, 42vmax, 660px));
      opacity: .16;
      filter: blur(clamp(10px, 1.8vw, 26px)) saturate(1.35);
      transform: rotate(-14deg) skew(-10deg, 3deg) scale(1.15);
    }
    body::after {
      width: clamp(260px, 40vmax, 640px);
      height: clamp(260px, 40vmax, 640px);
      right: max(-190px, -9vw);
      top: clamp(80px, 13vh, 160px);
      opacity: .1;
      filter: blur(clamp(5px, .95vw, 13px)) saturate(1.18);
      transform: rotate(23deg) skew(11deg, -7deg) scaleX(1.32);
    }
    header {
      position: relative;
      z-index: 1;
      height: 58px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 18px;
      border-bottom: 2px solid var(--ink);
      background: rgba(255, 255, 255, .8);
      font-weight: 900;
      letter-spacing: 0;
      backdrop-filter: blur(10px);
    }
    header img {
      width: 30px;
      height: 30px;
      border: 1px solid var(--ink);
      border-radius: 6px;
      background: #1a0020;
      object-fit: cover;
    }
    main {
      position: relative;
      z-index: 1;
      min-height: calc(100vh - 58px);
      display: grid;
      place-items: center;
      padding: 36px 16px;
    }
    section {
      width: min(470px, 100%);
      display: grid;
      justify-items: center;
      gap: 14px;
      padding: 30px;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: rgba(255, 255, 255, .88);
      text-align: center;
      box-shadow: 5px 5px 0 var(--ink), 0 26px 70px rgba(44, 8, 52, .14);
    }
    .success-mark {
      position: relative;
      width: 64px;
      height: 64px;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--accent);
      box-shadow: 3px 3px 0 var(--ink);
    }
    .success-mark::after {
      content: "";
      position: absolute;
      left: 22px;
      top: 15px;
      width: 15px;
      height: 28px;
      border-right: 5px solid var(--ink);
      border-bottom: 5px solid var(--ink);
      transform: rotate(42deg);
    }
    .status {
      margin: 2px 0 0;
      color: var(--accent-strong);
      font-size: 13px;
      font-weight: 900;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 360px;
      font-size: 24px;
      line-height: 1.18;
      text-align: center;
      text-wrap: balance;
    }
    p {
      margin: 0;
      max-width: 360px;
      color: var(--muted);
      line-height: 1.5;
      text-align: center;
    }
    .hint {
      margin-top: 6px;
      padding-top: 14px;
      border-top: 1px solid rgba(26, 26, 26, .16);
      color: #3f303a;
      font-size: 13px;
      font-weight: 900;
    }
  </style>
</head>
<body>
  <header><img src="/brand/magclaw-logo.png" alt="" />MAGCLAW</header>
  <main>
    <section aria-labelledby="team-sharing-auth-title">
      <div class="success-mark" aria-hidden="true"></div>
      <div class="status">Successful</div>
      <h1 id="team-sharing-auth-title">Team Sharing login successful</h1>
      <p>Your Team Sharing login has been approved.</p>
      ${channelLink}
    </section>
  </main>
</body>
</html>`;
}

export async function handleTeamSharingApi(req, res, url, deps) {
  const {
    addSystemEvent = () => {},
    broadcastState = () => {},
    currentActor = () => null,
    currentUser = () => null,
    embeddingProbe = null,
    embeddingReady = null,
    getState,
    indexTeamSharingDocuments = null,
    keywordSearch = null,
    keywordSearchReady = null,
    loadWorkspaceIntoState = null,
    makeId,
    now,
    persistState = async () => {},
    readJson,
    rerank = null,
    rerankReady = null,
    saveAttachmentBuffer = null,
    sendError,
    sendJson,
    summarizeSession = null,
    attachmentStorageDir = '',
    teamSharingAuthRequired = null,
    upsertChannelMember = null,
    validTeamSharingToken = null,
    vectorSearch = null,
    zillizReady = null,
  } = deps;
  const state = getState();
  const actor = currentActor(req);
  const browserUser = currentUser(req) || actor?.user || null;
  const workspaceId = actorWorkspaceId(actor, state);
  const teamSharingState = state.teamSharing || {};
  if (!state.teamSharing) state.teamSharing = teamSharingState;

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/start') {
    const body = await readJson(req);
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const deviceCode = randomToken('tmdev');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const requestWorkspaceId = String(body.workspaceId || workspaceId || '').trim();
    const machineFingerprint = normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || '');
    let setupTarget = null;
    try {
      setupTarget = teamSharingSetupTargetFromChannelPath(body.channelPath || body.channel_path || '');
    } catch (error) {
      sendError(res, error.status || 400, error.message || 'Invalid MagClaw channel path.');
      return true;
    }
    const throttleWorkspaceId = requestWorkspaceId || setupTarget?.serverId || workspaceId || '';
    const startThrottleKey = `start:${requestIpHash(req)}:${throttleWorkspaceId}:${setupTarget?.channelId || ''}`;
    if (!consumeTeamSharingAuthThrottle(auth, startThrottleKey, { limit: TEAM_SHARING_AUTH_START_LIMIT })) {
      sendError(res, 429, 'Too many Team Sharing login attempts. Please wait and try again.');
      return true;
    }
    const request = {
      deviceCodeHash: hashSecret(deviceCode),
      userCode,
      workspaceId: requestWorkspaceId || setupTarget?.serverId || '',
      profile: body.profile || 'default',
      packageName: body.packageName || 'team-sharing',
      machineFingerprint,
      setupTarget,
      client: body.client && typeof body.client === 'object' ? {
        hostname: compactText(body.client.hostname || '', 120),
        platform: compactText(body.client.platform || '', 40),
        arch: compactText(body.client.arch || '', 40),
      } : {},
      status: actor ? 'approved' : 'pending',
      approvedUser: actor ? requestUser(actor) : null,
      createdAt: now(),
      expiresAt,
    };
    auth.deviceRequests[request.deviceCodeHash] = request;
    await persistState({ workspaceId: requestWorkspaceId || workspaceId, reason: 'team_sharing_auth_start' });
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/team-sharing/auth/approve?user_code=${encodeURIComponent(userCode)}${request.workspaceId ? `&workspaceId=${encodeURIComponent(request.workspaceId)}` : ''}`,
      expiresAt,
      intervalMs: 2000,
      status: request.status,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/token') {
    const body = await readJson(req);
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const request = auth.deviceRequests[hashSecret(body.deviceCode || body.device_code || '')];
    if (!request) {
      sendJson(res, 200, { ok: true, status: 'pending' });
      return true;
    }
    if (String(request.expiresAt || '') < now()) {
      request.status = 'expired';
      sendJson(res, 200, { ok: true, status: 'expired', error: 'Team Sharing login expired.' });
      return true;
    }
    if (request.status !== 'approved') {
      sendJson(res, 200, { ok: true, status: request.status || 'pending' });
      return true;
    }
    const requestedFingerprint = normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || '');
    if (request.machineFingerprint && request.machineFingerprint !== requestedFingerprint) {
      sendError(res, 401, 'Team Sharing login was requested from another machine.');
      return true;
    }
    const token = randomToken('tm');
    const tokenHash = hashSecret(token);
    const tokenExpiresAt = new Date(Date.now() + TEAM_SHARING_TOKEN_TTL_MS).toISOString();
    auth.tokens[tokenHash] = {
      tokenHash,
      workspaceId: request.workspaceId || workspaceId,
      profile: request.profile || 'default',
      packageName: request.packageName || 'team-sharing',
      user: request.approvedUser || { id: 'hum_local', email: '', name: '' },
      scopes: ['team_sharing:sync', 'team_sharing:search', 'team_sharing:context', 'team_sharing:feedback', 'team_sharing:share'],
      revoked: false,
      machineFingerprint: request.machineFingerprint || requestedFingerprint || '',
      expiresAt: tokenExpiresAt,
      createdAt: now(),
      lastUsedAt: now(),
    };
    delete auth.deviceRequests[request.deviceCodeHash];
    await persistState({ workspaceId: request.workspaceId || workspaceId, reason: 'team_sharing_auth_token' });
    sendJson(res, 200, {
      ok: true,
      status: 'approved',
      token,
      tokenExpiresAt,
      workspaceId: request.workspaceId || workspaceId,
      profile: request.profile || 'default',
      user: auth.tokens[tokenHash].user,
      scopes: auth.tokens[tokenHash].scopes,
      onboardingTarget: request.onboardingTarget || null,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/auth/whoami') {
    const record = actor
      ? { workspaceId, profile: 'browser', user: requestUser(actor), scopes: ['browser_session'] }
      : tokenRecordForRequest(teamSharingState, req);
    if (!record) {
      sendError(res, 401, 'Team sharing login is required.');
      return true;
    }
    record.lastUsedAt = now();
    sendJson(res, 200, { ok: true, workspaceId: record.workspaceId, profile: record.profile, user: record.user, scopes: record.scopes });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/auth/servers') {
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const record = actor
      ? { workspaceId, profile: 'browser', user: requestUser(actor), scopes: ['browser_session'] }
      : tokenRecord;
    if (!record) {
      const issue = teamSharingTokenIssueForRequest(teamSharingState, req);
      sendJson(res, issue?.status || 401, {
        ok: false,
        reason: issue?.reason || 'login_required',
        error: 'Team sharing login is required.',
      });
      return true;
    }
    record.lastUsedAt = now();
    sendJson(res, 200, {
      ok: true,
      workspaceId: record.workspaceId,
      profile: record.profile,
      user: record.user,
      scopes: record.scopes,
      servers: teamSharingServersForIdentity({
        state,
        actor,
        currentUser: browserUser,
        tokenRecord: actor ? null : record,
      }),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/revoke') {
    const record = tokenRecordForRequest(teamSharingState, req);
    if (!record) {
      sendError(res, 401, 'Team sharing login is required.');
      return true;
    }
    record.revoked = true;
    record.revokedAt = now();
    await persistState({ workspaceId: record.workspaceId || workspaceId, reason: 'team_sharing_auth_revoke' });
    sendJson(res, 200, { ok: true, revoked: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/team-sharing/auth/approve') {
    const userCode = String(url.searchParams.get('user_code') || '').trim().toUpperCase();
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const request = Object.values(auth.deviceRequests).find((item) => item.userCode === userCode);
    if (!request) {
      sendError(res, 404, 'Team Sharing login request not found.');
      return true;
    }
    const workspaceReq = {
      ...req,
      headers: {
        ...(req.headers || {}),
        'x-magclaw-workspace-id': request.workspaceId || workspaceId,
      },
    };
    let approvalActor = actor || currentActor(workspaceReq);
    const approvalUser = currentUser(workspaceReq) || approvalActor?.user || null;
    if (request.setupTarget && approvalUser) {
      try {
        const claimed = await ensureTeamSharingSetupMembership({
          req: workspaceReq,
          request,
          user: approvalUser,
          state,
          auth,
          addSystemEvent,
          loadWorkspaceIntoState,
          makeId,
          now,
          upsertChannelMember,
        });
        if (claimed) {
          approvalActor = { user: claimed.user, member: claimed.member };
          request.workspaceId = claimed.workspace.id || request.workspaceId;
          request.onboardingTarget = claimed.onboardingTarget;
        }
      } catch (error) {
        sendError(res, error.status || 400, error.message || 'Team Sharing setup approval failed.');
        return true;
      }
    }
    if (!approvalActor) {
      if (approvalUser) {
        sendError(res, 403, 'Join this MagClaw server before approving Team Sharing login.');
        return true;
      }
      redirectToLoginWithReturnTo(res, url);
      return true;
    }
    request.status = 'approved';
    request.approvedUser = requestUser(approvalActor);
    request.approvedAt = now();
    await persistState({ workspaceId: request.workspaceId || workspaceId, reason: 'team_sharing_auth_approve' });
    res.writeHead?.(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end?.(teamSharingAuthApprovedHtml(request.onboardingTarget || null));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/links/inspect') {
    const serverUrl = publicUrlFromRequest(req);
    const parsed = parseTeamSharingInspectableLink(url.searchParams.get('url') || '', serverUrl);
    if (!parsed.ok) {
      sendJson(res, 400, {
        ok: false,
        supported: false,
        reason: parsed.reason || 'unsupported_link',
        error: 'Only MagClaw Team Sharing share/context links are supported.',
        action: teamSharingLinkAction({ reason: parsed.reason || 'unsupported_link', serverUrl }),
      });
      return true;
    }

    const targetResult = inspectableTargetForLink(teamSharingState, state, parsed);
    if (!targetResult.ok) {
      sendJson(res, targetResult.status || 404, {
        ok: false,
        kind: targetResult.kind || parsed.kind,
        linkType: 'magclaw_team_sharing',
        supported: true,
        reason: targetResult.reason || 'not_found',
        target: targetResult.target || {},
        error: targetResult.error || 'MagClaw Team Sharing link target not found.',
        action: teamSharingLinkAction({
          reason: targetResult.reason || 'not_found',
          serverUrl,
          originalUrl: parsed.url?.toString() || '',
        }),
      });
      return true;
    }

    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const tokenIssue = tokenRecord ? null : teamSharingTokenIssueForRequest(teamSharingState, req);
    const browserRecord = actor
      ? { workspaceId, profile: 'browser', user: requestUser(actor), scopes: ['browser_session'] }
      : browserUser
        ? { workspaceId: '', profile: 'browser', user: browserUser, scopes: ['browser_session'] }
        : null;
    const record = browserRecord || tokenRecord;
    const baseAuth = {
      loggedIn: Boolean(record),
      via: browserRecord ? 'browser' : tokenRecord ? 'token' : 'none',
      currentWorkspaceId: String(record?.workspaceId || '').trim(),
      profile: String(record?.profile || '').trim(),
      user: record?.user || null,
      servers: record ? teamSharingServersForIdentity({
        state,
        actor,
        currentUser: browserUser,
        tokenRecord: browserRecord ? null : tokenRecord,
      }) : [],
    };

    if (!record) {
      const reason = tokenIssue?.reason || 'login_required';
      sendJson(res, 200, {
        ok: false,
        kind: targetResult.kind,
        linkType: 'magclaw_team_sharing',
        supported: true,
        reason,
        target: targetResult.target,
        auth: baseAuth,
        access: { ok: false, reason, joinRequired: false },
        action: teamSharingLinkAction({ reason, serverUrl, originalUrl: parsed.url.toString() }),
      });
      return true;
    }

    const access = targetResult.kind === 'share'
      ? shareAccess(req, { actor, currentUser: browserUser, teamSharingState, share: targetResult.share, state })
      : targetResult.kind === 'knowledge_doc'
        ? teamSharingKnowledgeAccess({ req, actor, currentUser: browserUser, teamSharingState, state, workspaceId: targetResult.workspaceId })
        : teamSharingWorkspaceAccessResult({ actor, currentUser: browserUser, state, tokenRecord, session: targetResult.session });
    const reason = access.ok ? 'ok' : access.status === 401 ? (tokenIssue?.reason || 'login_required') : 'server_membership_required';
    const response = {
      ok: Boolean(access.ok),
      kind: targetResult.kind,
      linkType: 'magclaw_team_sharing',
      supported: true,
      reason,
      target: targetResult.target,
      auth: {
        ...baseAuth,
        via: access.ok ? (access.via || baseAuth.via) : baseAuth.via,
      },
      access: {
        ok: Boolean(access.ok),
        reason,
        joinRequired: reason === 'server_membership_required',
      },
      action: teamSharingLinkAction({ reason, serverUrl, originalUrl: parsed.url.toString() }),
    };
    sendJson(res, 200, response);
    return true;
  }

  const knowledgeDocMatch = url.pathname.match(/^\/api\/team-sharing\/knowledge\/([^/]+)\/docs\/([^/]+)\/?$/);
  if (req.method === 'GET' && knowledgeDocMatch) {
    const serverSlug = decodeURIComponent(knowledgeDocMatch[1] || '');
    const docId = decodeURIComponent(knowledgeDocMatch[2] || '');
    const effectiveWorkspaceId = workspaceIdForKnowledgeTarget(state, serverSlug, workspaceId);
    const access = teamSharingKnowledgeAccess({ req, actor, currentUser: browserUser, teamSharingState, state, workspaceId: effectiveWorkspaceId });
    if (!access.ok) {
      sendTeamSharingKnowledgeAccessError(sendJson, res, access, 'Join this server before reading Knowledge Space.');
      return true;
    }
    const space = ensureKnowledgeSpace(state, effectiveWorkspaceId, { now });
    const doc = getKnowledgeDocument(space, docId);
    if (!doc) {
      sendJson(res, 404, { ok: false, kind: 'knowledge_doc', reason: 'not_found', error: 'Knowledge document not found.' });
      return true;
    }
    addSystemEvent('team_sharing_knowledge_doc_read', `Team Sharing Knowledge document read: ${compactText(doc.title || docId, 90)}`, {
      workspaceId: effectiveWorkspaceId,
      docId,
      actorId: access.actorId || '',
    });
    sendJson(res, 200, {
      ok: true,
      kind: 'knowledge_doc',
      serverSlug,
      docId,
      document: doc,
      space: publicKnowledgeSpace(space, access.actor),
      url: `${publicUrlFromRequest(req)}/s/${encodeURIComponent(serverSlug)}/knowledge/docs/${encodeURIComponent(docId)}`,
    });
    return true;
  }

  const knowledgeExportMatch = url.pathname.match(/^\/api\/team-sharing\/knowledge\/([^/]+)\/export\/?$/);
  if (req.method === 'GET' && knowledgeExportMatch) {
    const serverSlug = decodeURIComponent(knowledgeExportMatch[1] || '');
    const effectiveWorkspaceId = workspaceIdForKnowledgeTarget(state, url.searchParams.get('workspaceId') || url.searchParams.get('workspace') || serverSlug, workspaceId);
    const access = teamSharingKnowledgeAccess({ req, actor, currentUser: browserUser, teamSharingState, state, workspaceId: effectiveWorkspaceId });
    if (!access.ok) {
      sendTeamSharingKnowledgeAccessError(sendJson, res, access, 'Join this server before exporting Knowledge Space.');
      return true;
    }
    const space = ensureKnowledgeSpace(state, effectiveWorkspaceId, { now });
    try {
      const exported = exportKnowledgeConsensusMarkdown(space, {
        consensusId: url.searchParams.get('consensusId') || url.searchParams.get('consensus_id') || '',
        rootDocId: url.searchParams.get('rootDocId') || url.searchParams.get('docId') || url.searchParams.get('doc') || '',
        title: url.searchParams.get('title') || url.searchParams.get('rootTitle') || '',
      });
      addSystemEvent('team_sharing_knowledge_exported', `Team Sharing exported Knowledge consensus: ${compactText(exported.title || exported.consensusId, 90)}`, {
        workspaceId: effectiveWorkspaceId,
        consensusId: exported.consensusId,
        rootDocId: exported.rootDocId,
        actorId: access.actorId || '',
      });
      sendJson(res, 200, { ok: true, kind: 'knowledge_consensus_export', serverSlug, ...exported });
    } catch (error) {
      sendJson(res, 404, { ok: false, kind: 'knowledge_consensus_export', reason: 'not_found', error: error?.message || 'Knowledge consensus not found.' });
    }
    return true;
  }

  const knowledgeActionMatch = url.pathname.match(/^\/api\/team-sharing\/knowledge\/([^/]+)\/(import|ask|edit|align)\/?$/);
  if (req.method === 'POST' && knowledgeActionMatch) {
    const serverSlug = decodeURIComponent(knowledgeActionMatch[1] || '');
    const action = String(knowledgeActionMatch[2] || '').trim();
    const body = await readJson(req);
    const effectiveWorkspaceId = workspaceIdForKnowledgeTarget(state, body.workspaceId || body.workspace || serverSlug, workspaceId);
    const access = teamSharingKnowledgeAccess({ req, actor, currentUser: browserUser, teamSharingState, state, workspaceId: effectiveWorkspaceId });
    if (!access.ok) {
      sendTeamSharingKnowledgeAccessError(sendJson, res, access, 'Join this server before using Knowledge Space.');
      return true;
    }
    const space = ensureKnowledgeSpace(state, effectiveWorkspaceId, { now });
    try {
      if (action === 'import') {
        if (!canWriteKnowledgeContent(space, access.actor)) {
          sendJson(res, 403, { ok: false, reason: 'writer_required', error: 'Only Server owners or Knowledge Space whitelist members can import Knowledge Space Markdown.' });
          return true;
        }
        const result = importKnowledgeMarkdown({
          state,
          workspaceId: effectiveWorkspaceId,
          markdown: body.markdown || body.content || '',
          sourceName: body.sourceName || body.title || '',
          sourceUrl: body.sourceUrl || '',
          actor: access.actor,
          now,
        });
        await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_knowledge_import' });
        broadcastState();
        addSystemEvent('team_sharing_knowledge_imported', 'Team Sharing imported Knowledge Space Markdown.', {
          workspaceId: effectiveWorkspaceId,
          documents: result.imported.documents,
          anchors: result.imported.anchors,
          actorId: access.actorId || '',
        });
        sendJson(res, 201, {
          ok: true,
          mode: result.mode || 'published',
          session: result.session,
          imported: result.imported,
          space: publicKnowledgeSpace(result.space, access.actor),
        });
        return true;
      }
      if (action === 'ask') {
        const answer = await askKnowledgeConsensus(space, body.query || body.question || '', { env: deps.env || process.env });
        sendJson(res, 200, { ok: true, matches: [], ...(answer && typeof answer === 'object' ? answer : { answer: String(answer || '') }) });
        return true;
      }
      if (action === 'align') {
        const aligned = await alignKnowledgeDiscussion(space, body.text || body.query || '', { env: deps.env || process.env });
        sendJson(res, 200, { ok: true, rules: [], alignmentGaps: [], ...(aligned && typeof aligned === 'object' ? aligned : { summary: String(aligned || '') }) });
        return true;
      }
      if (action === 'edit') {
        if (!canWriteKnowledgeContent(space, access.actor)) {
          sendJson(res, 403, { ok: false, reason: 'writer_required', error: 'Only Server owners or Knowledge Space whitelist members can draft content changes.' });
          return true;
        }
        const docId = String(body.docId || body.doc || '').trim();
        const proposedMarkdown = String(body.proposedMarkdown || body.markdown || body.content || '').trim();
        if (!docId || !proposedMarkdown) {
          sendJson(res, 400, { ok: false, reason: 'invalid_request', error: 'Knowledge edit requires docId and Markdown content.' });
          return true;
        }
        const result = createKnowledgeChangeSession({
          state,
          workspaceId: effectiveWorkspaceId,
          summary: body.summary || body.title || 'Knowledge consensus edit',
          changes: [{
            docId,
            proposedMarkdown,
          }],
          actor: access.actor,
          now,
        });
        await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_knowledge_edit' });
        broadcastState();
        addSystemEvent('team_sharing_knowledge_edit_drafted', 'Team Sharing drafted a Knowledge Space change.', {
          workspaceId: effectiveWorkspaceId,
          docId,
          changeSessionId: result.session.id,
          actorId: access.actorId || '',
        });
        sendJson(res, 201, { ok: true, session: result.session, space: publicKnowledgeSpace(result.space, access.actor) });
        return true;
      }
    } catch (error) {
      const message = error?.message || 'Knowledge Space request failed.';
      const status = /not found|unknown knowledge document/i.test(message) ? 404 : /only|requires|whitelist|member|admin/i.test(message) ? 403 : 400;
      sendJson(res, status, { ok: false, reason: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request', error: message });
      return true;
    }
  }

  const publicShareMatch = url.pathname.match(/^\/s\/([^/]+)$/) || url.pathname.match(/^\/share\/([^/]+)$/);
  if (req.method === 'GET' && publicShareMatch) {
    const shareId = decodeURIComponent(publicShareMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId && item.revokedAt == null);
    if (!share) {
      sendShareHtml(res, shareChromeHtml({ title: 'Team Shares' }, '<h1>Shared page not found</h1><p>This MagClaw share link may have been removed.</p>'), { status: 404 });
      return true;
    }
    const access = shareAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
    if (!access.ok) {
      addSystemEvent('team_sharing_share_denied', 'Team sharing share access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        shareId,
        status: access.status,
      });
      if (access.status === 401) {
        redirectToLoginWithReturnTo(res, url);
        return true;
      }
      if (access.joinable && await redirectToJoinWithReturnTo(res, url, {
        state,
        workspaceId: access.workspaceId,
        currentUser: browserUser,
        makeId,
        now,
        persistState,
        addSystemEvent,
      })) {
        return true;
      }
      sendShareHtml(res, shareRootDeniedHtml(access.status, access.error), { status: access.status });
      return true;
    }
    sendShareHtml(res, renderShareHtml(share, teamSharingState));
    return true;
  }

  const shareRootPath = url.pathname === '/share'
    || url.pathname === '/share/'
    || /^\/s\/[^/]+\/share\/?$/.test(url.pathname);
  if (req.method === 'GET' && shareRootPath) {
    const access = shareRootAccess(req, {
      actor,
      currentUser: browserUser,
      teamSharingState,
      state,
      targetWorkspaceId: shareRootPathWorkspaceId(url, state),
    });
    if (!access.ok) {
      addSystemEvent('team_sharing_share_root_denied', 'Team sharing share root access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        status: access.status,
      });
      if (access.status === 401) {
        redirectToLoginWithReturnTo(res, url);
        return true;
      }
      if (access.joinable && await redirectToJoinWithReturnTo(res, url, {
        state,
        workspaceId: access.workspaceId,
        currentUser: browserUser,
        makeId,
        now,
        persistState,
        addSystemEvent,
      })) {
        return true;
      }
      sendShareHtml(res, shareRootDeniedHtml(access.status, access.error), { status: access.status });
      return true;
    }
    const activeShares = sharesForShareRoot(teamSharingState, access.workspaceId)
      .filter((share) => !share.revokedAt);
    sendShareHtml(res, renderShareIndexHtml(activeShares, teamSharingState));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/assets/resolve') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const access = assetWorkspaceAccess(req, {
      actor,
      currentUser: browserUser,
      teamSharingState,
      state,
      asset: { workspaceId: effectiveWorkspaceId },
    });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'server_membership_required',
        error: access.error || 'Join this server before resolving Team Sharing assets.',
      });
      return true;
    }
    const asset = findTeamSharingAsset(teamSharingState, {
      workspaceId: effectiveWorkspaceId,
      checksumSha256: body.sha256 || body.checksumSha256 || body.checksum_sha256 || '',
      bytes: body.bytes || body.sizeBytes || body.size || 0,
      mimeType: body.mimeType || body.type || '',
    });
    sendJson(res, 200, {
      ok: true,
      found: Boolean(asset),
      asset: asset ? publicTeamSharingAsset(req, asset) : null,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/assets') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const access = assetWorkspaceAccess(req, {
      actor,
      currentUser: browserUser,
      teamSharingState,
      state,
      asset: { workspaceId: effectiveWorkspaceId },
    });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'server_membership_required',
        error: access.error || 'Join this server before uploading Team Sharing assets.',
      });
      return true;
    }
    const decoded = decodeDataUrl(body.dataUrl || body.data_url || '');
    const mimeType = String(body.mimeType || body.type || decoded?.mimeType || '').trim();
    const buffer = decoded?.buffer || (body.base64 || body.contentBase64
      ? Buffer.from(String(body.base64 || body.contentBase64 || '').replace(/\s+/g, ''), 'base64')
      : null);
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      sendError(res, 400, 'Asset content is required.');
      return true;
    }
    const expectedHash = String(body.sha256 || body.checksumSha256 || body.checksum_sha256 || '').trim().toLowerCase();
    const actualHash = sha256Buffer(buffer);
    if (expectedHash && expectedHash !== actualHash) {
      sendError(res, 400, 'Asset checksum does not match the uploaded content.');
      return true;
    }
    try {
      const actorId = actorHumanId(actor) || tokenRecord?.user?.id || '';
      const { asset, reused } = await upsertTeamSharingAsset({
        teamSharingState,
        state,
        saveAttachmentBuffer,
        makeId,
        now,
        workspaceId: effectiveWorkspaceId,
        filename: body.filename || body.name || '',
        mimeType: mimeType || decoded?.mimeType || 'application/octet-stream',
        buffer,
        actorId,
      });
      addSystemEvent(reused ? 'team_sharing_asset_reused' : 'team_sharing_asset_uploaded', reused ? 'Team Sharing asset reused.' : 'Team Sharing asset uploaded.', {
        workspaceId: asset.workspaceId,
        assetId: asset.id,
        bytes: asset.bytes,
        mimeType: asset.mimeType,
      });
      await persistState({ workspaceId: asset.workspaceId || workspaceId, reason: reused ? 'team_sharing_asset_reused' : 'team_sharing_asset_uploaded' });
      broadcastState();
      sendJson(res, reused ? 200 : 201, {
        ok: true,
        reused,
        asset: publicTeamSharingAsset(req, asset),
      });
      return true;
    } catch (error) {
      sendError(res, error.status || 500, error.message || 'Team Sharing asset upload failed.');
      return true;
    }
  }

  const assetReadMatch = url.pathname.match(/^\/api\/team-sharing\/assets\/([^/]+)\/(.+)$/);
  if (req.method === 'GET' && assetReadMatch) {
    const assetId = decodeURIComponent(assetReadMatch[1] || '');
    const asset = findTeamSharingAsset(teamSharingState, { assetId });
    if (!asset) {
      sendError(res, 404, 'Team Sharing asset not found.');
      return true;
    }
    const access = shareAssetGrantAccess(teamSharingState, asset, url.searchParams)
      || assetWorkspaceAccess(req, { actor, currentUser: browserUser, teamSharingState, asset, state });
    if (!access.ok) {
      sendError(res, access.status || 403, access.error || 'Join this server before opening this asset.');
      return true;
    }
    const filePath = assetFilePath(asset, attachmentStorageDir);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      sendError(res, 404, 'Team Sharing asset file is unavailable.');
      return true;
    }
    const size = Number(fileStat.size || asset.bytes || 0);
    const etag = `"${String(asset.checksumSha256 || '').trim() || sha256Text(`${asset.id}:${size}`)}"`;
    const baseHeaders = {
      'content-type': asset.mimeType || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=31536000, immutable',
      etag,
    };
    if (String(req.headers?.['if-none-match'] || '').trim() === etag) {
      res.writeHead?.(304, baseHeaders);
      res.end?.();
      return true;
    }
    const range = parseAttachmentRange(req.headers?.range, size);
    if (range?.unsatisfiable) {
      res.writeHead?.(416, { ...baseHeaders, 'content-range': `bytes */${size}` });
      res.end?.();
      return true;
    }
    if (range) {
      const contentLength = range.end - range.start + 1;
      res.writeHead?.(206, {
        ...baseHeaders,
        'content-length': contentLength,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      });
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return true;
    }
    res.writeHead?.(200, { ...baseHeaders, 'content-length': size });
    createReadStream(filePath).pipe(res);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/shares') {
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const targetWorkspaceId = shareListWorkspaceIdFromUrl(url, state)
      || requestWorkspaceId({ actor, tokenRecord, state, fallback: workspaceId });
    const access = shareRootAccess(req, {
      actor,
      currentUser: browserUser,
      teamSharingState,
      state,
      targetWorkspaceId,
    });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'server_membership_required',
        error: access.error || 'Join this server before listing shared links.',
      });
      return true;
    }
    const includeRevoked = /^(1|true|yes|y|on)$/i.test(String(
      url.searchParams.get('includeRevoked')
      || url.searchParams.get('include_revoked')
      || '',
    ).trim());
    const shares = sharesForShareRoot(teamSharingState, access.workspaceId || targetWorkspaceId)
      .filter((share) => includeRevoked || !share.revokedAt)
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    addSystemEvent('team_sharing_share_listed', 'Team sharing shares listed.', {
      workspaceId: access.workspaceId || targetWorkspaceId,
      actorId: access.actorId || '',
      count: shares.length,
      includeRevoked,
    });
    sendJson(res, 200, {
      ok: true,
      kind: 'share_list',
      workspaceId: access.workspaceId || targetWorkspaceId,
      includeRevoked,
      count: shares.length,
      shares: shares.map((share) => {
        const editAccess = shareEditAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
        return shareListItemPayload(req, share, teamSharingState, {
          canEdit: Boolean(editAccess.ok && editAccess.canEdit),
          editVia: editAccess.ok && editAccess.canEdit ? String(editAccess.editVia || '').trim() : '',
        });
      }),
    });
    return true;
  }

  const shareSectionsMatch = url.pathname.match(/^\/api\/team-sharing\/shares\/([^/]+)\/sections$/);
  if (req.method === 'GET' && shareSectionsMatch) {
    const shareId = decodeURIComponent(shareSectionsMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId && item.revokedAt == null);
    if (!share) {
      sendJson(res, 404, { ok: false, reason: 'not_found', error: 'Shared page not found.' });
      return true;
    }
    const access = shareAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'server_membership_required',
        error: access.error || 'Join this server before reading the shared page sections.',
      });
      return true;
    }
    const hadVersion = Boolean(share.currentVersionId);
    ensureShareVersionModel(teamSharingState, share, { makeId, now });
    if (!hadVersion) await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_migrated' });
    sendJson(res, 200, shareSectionsPayload(req, share, teamSharingState));
    return true;
  }

  const sharePatchMatch = url.pathname.match(/^\/api\/team-sharing\/shares\/([^/]+)$/);
  if (req.method === 'PATCH' && sharePatchMatch) {
    const shareId = decodeURIComponent(sharePatchMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId && item.revokedAt == null);
    if (!share) {
      sendJson(res, 404, { ok: false, reason: 'not_found', error: 'Shared page not found.' });
      return true;
    }
    const access = shareEditAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'share_edit_forbidden',
        error: access.error || 'Only the creator, owner, or admin can edit this shared page.',
      });
      return true;
    }
    const body = await readJson(req);
    const operations = Array.isArray(body.operations) ? body.operations : [];
    if (!operations.length) {
      sendError(res, 400, 'At least one share patch operation is required.');
      return true;
    }
    ensureShareVersionModel(teamSharingState, share, { makeId, now });
    const current = shareContentRecord(teamSharingState, share);
    const baseVersionId = String(body.baseVersionId || body.base_version_id || '').trim();
    if (!baseVersionId) {
      sendJson(res, 400, { ok: false, reason: 'base_version_required', error: 'baseVersionId is required.' });
      return true;
    }
    if (baseVersionId !== String(current.version?.id || '').trim()) {
      sendJson(res, 409, {
        ok: false,
        reason: 'version_conflict',
        error: 'Shared page has changed since this patch was prepared.',
        currentVersionId: current.version?.id || '',
      });
      return true;
    }
    try {
      const currentContentType = current.contentType || normalizeShareContentType(share.contentType, current.content);
      const patched = applySharePatchOperations(current.content, currentContentType, operations);
      const metadataOperation = operations.find((operation) => String(operation?.op || operation?.type || '') === 'set_metadata') || {};
      const contentChanged = sharePatchChangesContent(operations);
      const contentType = normalizeShareContentType(body.contentType || metadataOperation.contentType || currentContentType, patched.content);
      const nextTitle = compactText(body.title || metadataOperation.title || share.title || 'MagClaw shared page', 140);
      const nextDescription = compactText(body.description || metadataOperation.description || share.description || patched.content, 260);
      let blob = current.blob;
      let contentHash = current.contentHash;
      let assetIds = Array.from(new Set([
        ...current.assetIds,
        ...asArray(body.assetIds).map(String).filter(Boolean),
      ]));
      let contentForFallback = current.content;
      if (!contentChanged && current.content && !blob) {
        blob = upsertShareContentBlob(teamSharingState, {
          workspaceId: share.workspaceId || workspaceId,
          contentType,
          content: current.content,
          assetIds,
          now,
          makeId,
        });
        contentHash = blob.contentHash;
      }
      if (contentChanged) {
        const optimized = await optimizeInlineShareAssets({
          req,
          content: patched.content,
          workspaceId: share.workspaceId || workspaceId,
          teamSharingState,
          state,
          saveAttachmentBuffer,
          makeId,
          now,
          actorId: access.editorId || access.actorId || '',
        });
        if (optimized.content.length > MAX_SHARE_CONTENT_LENGTH) {
          sendError(res, 413, 'Share content is too large.');
          return true;
        }
        assetIds = Array.from(new Set([
          ...assetIds,
          ...optimized.assetIds,
        ]));
        blob = upsertShareContentBlob(teamSharingState, {
          workspaceId: share.workspaceId || workspaceId,
          contentType,
          content: optimized.content,
          assetIds,
          now,
          makeId,
        });
        contentHash = blob.contentHash;
        contentForFallback = optimized.content;
      }
      const updatedAt = now();
      const version = {
        id: typeof makeId === 'function' ? makeId('shv') : `shv_${contentHash.slice(0, 16)}`,
        shareId: share.id,
        title: nextTitle,
        description: nextDescription,
        contentType,
        contentHash,
        contentBlobId: blob?.id || current.version?.contentBlobId || '',
        assetIds,
        baseVersionId,
        operations: operations.map((operation) => ({
          type: String(operation?.op || operation?.type || '').trim(),
          sectionId: String(operation?.sectionId || operation?.section_id || '').trim(),
          selector: String(operation?.selector || '').trim(),
        })),
        changedSections: patched.changedSections,
        createdAt: updatedAt,
        createdBy: access.editorId || access.actorId || '',
      };
      share.versions.push(version);
      share.currentVersionId = version.id;
      share.title = nextTitle;
      share.description = nextDescription;
      share.contentType = contentType;
      share.contentHash = contentHash;
      share.assetIds = assetIds;
      share.updatedAt = updatedAt;
      share.updatedBy = { id: access.editorId || access.actorId || '', via: access.editVia || '' };
      if (contentForFallback) share.content = contentForFallback;
      const shareDocuments = refreshShareVectorDocuments(teamSharingState, share);
      let indexedDocumentCount = 0;
      if (typeof indexTeamSharingDocuments === 'function' && shareDocuments.length) {
        try {
          const indexed = await indexTeamSharingDocuments({
            workspaceId: share.workspaceId || workspaceId,
            shareId,
            documents: shareDocuments,
            teamSharingState,
          });
          indexedDocumentCount = Number(indexed?.count || shareDocuments.length);
        } catch (error) {
          addSystemEvent('team_sharing_share_index_failed', `Team sharing share index failed: ${compactText(error?.message || error, 120)}`, {
            workspaceId: share.workspaceId || workspaceId,
            shareId,
          });
        }
      }
      addSystemEvent('team_sharing_share_updated', `Team sharing share updated: ${share.title}`, {
        workspaceId: share.workspaceId,
        shareId,
        versionId: version.id,
        changedSections: patched.changedSections.map((section) => section.sectionId || section.selector || section.type).filter(Boolean),
      });
      await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_updated' });
      broadcastState();
      sendJson(res, 200, {
        ok: true,
        shareId,
        url: shareUrl(req, shareId),
        versionId: version.id,
        previousVersionId: baseVersionId,
        contentHash,
        changedSections: patched.changedSections,
        assetRefs: shareAssetRefs(req, teamSharingState, assetIds),
        indexedDocumentCount,
      });
      return true;
    } catch (error) {
      if (error.status === 409 || error.reason === 'version_conflict') {
        sendJson(res, 409, {
          ok: false,
          reason: 'version_conflict',
          error: error.message || 'Shared page has changed since this patch was prepared.',
          section: error.section || null,
        });
        return true;
      }
      sendError(res, error.status || 500, error.message || 'Failed to patch shared page.');
      return true;
    }
  }

  if (req.method === 'DELETE' && sharePatchMatch) {
    const shareId = decodeURIComponent(sharePatchMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId);
    if (!share) {
      sendJson(res, 404, { ok: false, reason: 'not_found', error: 'Shared page not found.' });
      return true;
    }
    const access = shareEditAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
    if (!access.ok) {
      sendJson(res, access.status || 403, {
        ok: false,
        reason: access.status === 401 ? 'login_required' : 'share_delete_forbidden',
        error: access.error || 'Only the creator, owner, or admin can delete this shared page.',
      });
      return true;
    }
    const alreadyDeleted = Boolean(share.revokedAt);
    const revokedAt = share.revokedAt || now();
    if (!alreadyDeleted) {
      share.revokedAt = revokedAt;
      share.revokedBy = { id: access.editorId || access.actorId || '', via: access.editVia || '' };
      share.updatedAt = revokedAt;
      share.updatedBy = { id: access.editorId || access.actorId || '', via: access.editVia || '' };
      deactivateShareVectorDocuments(teamSharingState, share);
      addSystemEvent('team_sharing_share_deleted', `Team sharing share deleted: ${compactText(share.title || shareId, 90)}`, {
        workspaceId: share.workspaceId || workspaceId,
        shareId,
        actorId: access.editorId || access.actorId || '',
        via: access.editVia || '',
      });
      await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_deleted' });
      broadcastState();
    }
    sendJson(res, 200, {
      ok: true,
      kind: 'share_deleted',
      shareId,
      deleted: !alreadyDeleted,
      alreadyDeleted,
      revokedAt,
      workspaceId: String(share.workspaceId || '').trim(),
    });
    return true;
  }

  const shareApiReadMatch = url.pathname.match(/^\/api\/team-sharing\/shares\/([^/]+)$/);
  if (req.method === 'GET' && shareApiReadMatch) {
    const shareId = decodeURIComponent(shareApiReadMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId && item.revokedAt == null);
    if (!share) {
      sendJson(res, 404, { ok: false, reason: 'not_found', error: 'Shared page not found.' });
      return true;
    }
    const access = shareAccess(req, { actor, currentUser: browserUser, teamSharingState, share, state });
    if (!access.ok) {
      const reason = access.status === 401 ? 'login_required' : 'server_membership_required';
      addSystemEvent('team_sharing_share_api_denied', 'Team sharing share API access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        shareId,
        status: access.status,
        reason,
      });
      sendJson(res, access.status || 403, {
        ok: false,
        reason,
        error: access.error || (reason === 'login_required'
          ? 'Team Sharing login is required.'
          : 'Join this server before reading the shared page.'),
      });
      return true;
    }
    const hadVersion = Boolean(share.currentVersionId);
    ensureShareVersionModel(teamSharingState, share, { makeId, now });
    if (!hadVersion) await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_migrated' });
    addSystemEvent('team_sharing_share_api_read', `Team sharing share read: ${compactText(share.title || shareId, 90)}`, {
      workspaceId: share.workspaceId || workspaceId,
      shareId,
      actorId: access.actorId || '',
    });
    sendJson(res, 200, shareReadPayload(req, share, teamSharingState));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/shares') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const rawContent = String(body.content || body.markdown || body.html || body.svg || body.mermaid || '');
    if (!rawContent.trim()) {
      sendError(res, 400, 'Share content is required.');
      return true;
    }
    const rawContentType = normalizeShareContentType(body.contentType || body.type, rawContent);
    const optimizeAssets = body.optimizeAssets !== false && body.optimize_assets !== false;
    const creator = creatorFromActor(actor, tokenRecord);
    const optimized = optimizeAssets
      ? await optimizeInlineShareAssets({
          req,
          content: rawContent,
          workspaceId: effectiveWorkspaceId,
          teamSharingState,
          state,
          saveAttachmentBuffer,
          makeId,
          now,
          actorId: creator.id,
        })
      : { content: rawContent, assetIds: [], optimized: false };
    const content = optimized.content;
    if (content.length > MAX_SHARE_CONTENT_LENGTH) {
      sendError(res, 413, 'Share content is too large.');
      return true;
    }
    const createdAt = now();
    const shareId = typeof makeId === 'function' ? makeId('share') : randomToken('share');
    const assetIds = Array.from(new Set([
      ...asArray(body.assetIds).map(String).filter(Boolean),
      ...optimized.assetIds,
    ]));
    const blob = upsertShareContentBlob(teamSharingState, {
      workspaceId: effectiveWorkspaceId,
      contentType: rawContentType,
      content,
      assetIds,
      now,
      makeId,
    });
    const version = {
      id: typeof makeId === 'function' ? makeId('shv') : `shv_${blob.contentHash.slice(0, 16)}`,
      shareId,
      title: compactText(body.title || body.name || 'MagClaw shared page', 140),
      description: compactText(body.description || content, 260),
      contentType: rawContentType,
      contentHash: blob.contentHash,
      contentBlobId: blob.id,
      assetIds,
      createdAt,
      createdBy: creator.id,
      reason: 'create',
    };
    const share = {
      id: shareId,
      workspaceId: effectiveWorkspaceId,
      channelId: String(body.channelId || '').trim(),
      channelPath: String(body.channelPath || '').trim(),
      projectKey: String(body.projectKey || '').trim(),
      title: version.title,
      description: version.description,
      contentType: rawContentType,
      contentHash: blob.contentHash,
      contentBlobId: blob.id,
      assetIds,
      versions: [version],
      currentVersionId: version.id,
      creator,
      source: body.source && typeof body.source === 'object' ? body.source : {},
      public: true,
      createdAt,
      updatedAt: createdAt,
    };
    ensureTeamSharingShares(teamSharingState).push(share);
    const shareDocuments = refreshShareVectorDocuments(teamSharingState, share);
    let indexedDocumentCount = 0;
    if (typeof indexTeamSharingDocuments === 'function' && shareDocuments.length) {
      try {
        const indexed = await indexTeamSharingDocuments({
          workspaceId: share.workspaceId || workspaceId,
          shareId,
          documents: shareDocuments,
          teamSharingState,
        });
        indexedDocumentCount = Number(indexed?.count || shareDocuments.length);
      } catch (error) {
        addSystemEvent('team_sharing_share_index_failed', `Team sharing share index failed: ${compactText(error?.message || error, 120)}`, {
          workspaceId: share.workspaceId,
          shareId,
        });
      }
    }
    addSystemEvent('team_sharing_share_created', `Team sharing share created: ${share.title}`, {
      workspaceId: share.workspaceId,
      shareId,
      channelId: share.channelId,
      projectKey: share.projectKey,
      contentType: share.contentType,
      assetCount: assetIds.length,
    });
    await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_created' });
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      shareId,
      url: shareUrl(req, shareId),
      indexedDocumentCount,
      share: {
        id: share.id,
        title: share.title,
        contentType: share.contentType,
        versionId: share.currentVersionId,
        contentHash: share.contentHash,
        assetRefs: shareAssetRefs(req, teamSharingState, assetIds),
        creator: share.creator,
        createdAt: share.createdAt,
        channelId: share.channelId,
        channelPath: share.channelPath,
        projectKey: share.projectKey,
      },
    });
    return true;
  }

  const scopedContextPageMatch = url.pathname.match(/^\/s\/([^/]+)\/team-sharing\/context\/([^/]+)$/);
  const contextPageMatch = url.pathname.match(/^\/team-sharing\/context\/([^/]+)$/) || (scopedContextPageMatch ? [scopedContextPageMatch[0], scopedContextPageMatch[2]] : null);
  if (req.method === 'GET' && contextPageMatch) {
    if (!requestHasTeamSharingIdentity(req, { actor, teamSharingState, validTeamSharingToken }) && !browserUser) {
      redirectToLoginWithReturnTo(res, url);
      return true;
    }
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(contextPageMatch[1]);
    const session = teamSharingState.sessions?.[sessionId] || null;
    if (!session) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    const access = teamSharingWorkspaceAccessResult({ actor, currentUser: browserUser, state, tokenRecord, session });
    if (!access.ok) {
      if (access.joinable && await redirectToJoinWithReturnTo(res, url, {
        state,
        workspaceId: access.workspaceId,
        currentUser: browserUser,
        makeId,
        now,
        persistState,
        addSystemEvent,
      })) {
        return true;
      }
      sendError(res, 403, 'This Team Sharing context belongs to another server.');
      return true;
    }
    sendContextHtml(res, {
      sessionId,
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      vectorDocumentId: url.searchParams.get('vectorDocumentId') || '',
      queryId: url.searchParams.get('queryId') || '',
      sourceRef: url.searchParams.get('sourceRef') || '',
      order: url.searchParams.get('order') || 'asc',
      workspaceId: session.workspaceId || actor?.member?.workspaceId || tokenRecord?.workspaceId || workspaceId || '',
      serverSlug: scopedContextPageMatch ? decodeURIComponent(scopedContextPageMatch[1]) : (url.searchParams.get('serverSlug') || ''),
    });
    return true;
  }

  const scopedWorkspaceFilePageMatch = url.pathname.match(/^\/s\/([^/]+)\/team-sharing\/workspace\/([^/]+)\/file$/);
  const workspaceFilePageMatch = url.pathname.match(/^\/team-sharing\/workspace\/([^/]+)\/file$/)
    || (scopedWorkspaceFilePageMatch ? [scopedWorkspaceFilePageMatch[0], scopedWorkspaceFilePageMatch[2]] : null);
  if (req.method === 'GET' && workspaceFilePageMatch) {
    if (!requestHasTeamSharingIdentity(req, { actor, teamSharingState, validTeamSharingToken }) && !browserUser) {
      redirectToLoginWithReturnTo(res, url);
      return true;
    }
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(workspaceFilePageMatch[1]);
    const session = teamSharingState.sessions?.[sessionId] || null;
    if (!session) {
      sendError(res, 404, 'Team sharing workspace not found.');
      return true;
    }
    const targetWorkspaceId = String(session.workspaceId || '').trim();
    const access = teamSharingWorkspaceAccessResult({ actor, currentUser: browserUser, state, tokenRecord, session });
    if (!access.ok) {
      if (access.joinable && await redirectToJoinWithReturnTo(res, url, {
        state,
        workspaceId: access.workspaceId,
        currentUser: browserUser,
        makeId,
        now,
        persistState,
        addSystemEvent,
      })) {
        return true;
      }
      sendError(res, 403, 'This Team Sharing workspace belongs to another server.');
      return true;
    }
    const workspace = buildTeamSharingWorkspace(teamSharingState, sessionId);
    if (!workspace) {
      sendError(res, 404, 'Team sharing workspace not found.');
      return true;
    }
    const rawPath = url.searchParams.has('path') ? url.searchParams.get('path') : 'abstract.md';
    const filePath = normalizeTeamSharingWorkspaceFilePath(rawPath);
    const file = teamSharingWorkspaceFileByPath(workspace, filePath);
    if (!file) {
      sendError(res, 404, 'Team sharing workspace file not found.');
      return true;
    }
    addSystemEvent('team_sharing_workspace_file_read', `Team sharing workspace file read: ${compactText(file.path || sessionId, 90)}`, {
      workspaceId: targetWorkspaceId || workspaceId,
      sessionId,
      path: file.path,
      messageId: workspace.session.messageId,
    });
    sendWorkspaceFileHtml(res, {
      workspace,
      file,
      serverSlug: scopedWorkspaceFilePageMatch ? decodeURIComponent(scopedWorkspaceFilePageMatch[1]) : (url.searchParams.get('serverSlug') || ''),
    });
    return true;
  }

  const workspaceMatch = url.pathname.match(/^\/api\/team-sharing\/workspace\/([^/]+)$/);
  if (req.method === 'GET' && workspaceMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(workspaceMatch[1]);
    const workspace = buildTeamSharingWorkspace(teamSharingState, sessionId);
    if (!workspace) {
      sendError(res, 404, 'Team sharing workspace not found.');
      return true;
    }
    if (!teamSharingWorkspaceAccess({ actor, currentUser: browserUser, state, tokenRecord, session: workspace.session })) {
      sendError(res, 403, 'This Team Sharing workspace belongs to another server.');
      return true;
    }
    addSystemEvent('team_sharing_workspace_read', `Team sharing workspace read: ${compactText(workspace.session.title || sessionId, 90)}`, {
      workspaceId,
      sessionId,
      messageId: workspace.session.messageId,
    });
    sendJson(res, 200, workspace);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/sync') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const requestUploader = teamSharingRequestUser({ actor, tokenRecord, body });
    const result = await syncTeamSharingBatch({
      ...body,
      workspaceId: effectiveWorkspaceId,
      humanId: requestUploader.id,
      humanName: requestUploader.name,
      humanEmail: requestUploader.email,
      humanAvatar: requestUploader.avatar,
    }, {
      state,
      makeId,
      now,
      summarizeSession,
    });
    if (!result.ok) {
      sendError(res, result.code === 'channel_not_found' ? 404 : 400, result.error || 'Team sharing sync failed.');
      return true;
    }
    if (!result.duplicate && result.appendedEventCount > 0 && typeof indexTeamSharingDocuments === 'function') {
      const documents = asArray(state.teamSharing?.vectorDocuments)
        .filter((doc) => doc.sessionId === result.sessionId && doc.active !== false);
      try {
        const indexed = await indexTeamSharingDocuments({
          workspaceId: effectiveWorkspaceId,
          sessionId: result.sessionId,
          documents,
          teamSharingState: state.teamSharing || {},
        });
        result.indexedDocumentCount = Number(indexed?.count || documents.length || 0);
      } catch (error) {
        result.indexedDocumentCount = 0;
        result.indexError = 'Team sharing vector indexing failed.';
        addSystemEvent('team_sharing_index_error', 'Team sharing vector indexing failed.', {
          workspaceId: effectiveWorkspaceId,
          sessionId: result.sessionId,
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }
    addSystemEvent('team_sharing_sync', `Team sharing synced ${result.appendedEventCount} event(s).`, {
      workspaceId: effectiveWorkspaceId,
      sessionId: result.sessionId,
      messageId: result.messageId,
      duplicate: result.duplicate,
    });
    await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_sync' });
    broadcastState();
    sendJson(res, result.duplicate ? 200 : 202, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/search') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const limit = Math.max(1, Math.min(20, Number(body.limit || 5)));
    const candidateK = Math.max(limit, Math.min(200, Number(body.candidateK || 40)));
    const memberResolution = resolveTeamSharingMembers({
      state,
      teamSharingState,
      workspaceId: effectiveWorkspaceId,
      body,
      query: body.query || '',
    });
    if (memberResolution.needsClarification || memberResolution.status === 'ambiguous') {
      sendJson(res, 200, {
        ok: true,
        results: [],
        needsClarification: true,
        memberResolution,
        candidateCount: 0,
        semanticCandidateCount: 0,
        keywordCandidateCount: 0,
      });
      return true;
    }
    if (memberResolution.status === 'not_found') {
      sendJson(res, 200, {
        ok: true,
        results: [],
        memberResolution,
        candidateCount: 0,
        semanticCandidateCount: 0,
        keywordCandidateCount: 0,
      });
      return true;
    }
    const contentQuery = String(memberResolution.contentQuery ?? body.query ?? '').replace(/\s+/g, ' ').trim();
    const searchBody = { ...body, query: contentQuery, semanticQuery: body.semanticQuery || body.semantic_query ? body.semanticQuery || body.semantic_query : undefined };
    if (!body.semanticQuery && !body.semantic_query) searchBody.semanticQuery = contentQuery;
    const intent = normalizeTeamSharingSearchIntentBody(searchBody, now?.());
    const searchMode = intent.searchMode;
    const searchScope = normalizeTeamSharingSearchScope(body.scope || body.retrievalScope || body.retrievalIntent?.scope || '');
    const sortBy = normalizeTeamSharingSearchSort(body.sortBy || body.sort || body.orderBy);
    const dateRange = intent.dateRange;
    const uploaderIds = memberResolution.status === 'matched' ? memberResolution.uploaderIds : [];
    const memberOnly = uploaderIds.length > 0 && !intent.query && !intent.keywords.length && !intent.topics.length;
    const needsSemantic = !memberOnly && intent.useSemantic;
    const needsKeyword = !memberOnly && intent.useKeyword;
    const currentChannelId = String(body.channelId || '').trim();
    const projectKey = String(body.projectKey || '').trim();
    const searchScopes = teamSharingSearchScopes(searchScope, currentChannelId);
    const scopedSearchBase = (scope) => ({
      teamSharingState,
      workspaceId: effectiveWorkspaceId,
      channelId: scope.channelId || '',
      excludeChannelId: scope.excludeChannelId || '',
      projectKey,
      uploaderIds,
      dateRange,
      limit: candidateK,
    });
    const semanticRemoteReady = needsSemantic && vectorSearch && (typeof zillizReady !== 'function' || zillizReady());
    if (needsSemantic && searchMode === 'semantic' && !semanticRemoteReady) {
      sendError(res, 503, 'Team sharing vector index is not ready.');
      return true;
    }
    const semanticPromise = needsSemantic
      ? Promise.all(searchScopes.map(async (scope) => {
        const result = semanticRemoteReady
          ? await vectorSearch({
            ...scopedSearchBase(scope),
            query: intent.semanticQuery,
            actor,
            searchMode,
            modeBias: intent.modeBias,
            keywords: intent.keywords,
            topics: intent.topics,
          }).catch((error) => ({ ok: false, error: error?.message || 'Team sharing vector search failed.' }))
          : localVectorSearch({
            ...scopedSearchBase(scope),
            query: intent.semanticQuery,
          });
        return annotateScopedCandidates(result, scope, currentChannelId);
      })).then((results) => mergeScopedSearchResults(results, candidateK))
      : Promise.resolve({ ok: true, candidates: [] });
    const keywordPromise = needsKeyword
      ? (async () => {
        const canUseRemoteKeyword = keywordSearch && (typeof keywordSearchReady !== 'function' || keywordSearchReady());
        const results = await Promise.all(searchScopes.map(async (scope) => {
          if (canUseRemoteKeyword) {
            const remote = await keywordSearch({
              ...scopedSearchBase(scope),
              query: intent.keywordQuery || intent.query,
              keywordQuery: intent.keywordQuery,
              keywords: intent.keywords,
              topics: intent.topics,
              actor,
              searchMode,
              modeBias: intent.modeBias,
            }).catch((error) => ({ ok: false, error: error?.message || 'Team sharing keyword search failed.' }));
            if (remote?.ok) return annotateScopedCandidates(remote, scope, currentChannelId);
            const fallback = localKeywordSearch({
              ...scopedSearchBase(scope),
              query: intent.query,
              keywordQuery: intent.keywordQuery,
              keywords: intent.keywords,
              topics: intent.topics,
            });
            return annotateScopedCandidates({ ...fallback, degraded: true, remoteError: remote?.error || remote?.code || 'keyword_search_failed' }, scope, currentChannelId);
          }
          const fallback = localKeywordSearch({
            ...scopedSearchBase(scope),
            query: intent.query,
            keywordQuery: intent.keywordQuery,
            keywords: intent.keywords,
            topics: intent.topics,
          });
          return annotateScopedCandidates({ ...fallback, degraded: Boolean(keywordSearch), remoteError: keywordSearch ? 'keyword_search_not_ready' : '' }, scope, currentChannelId);
        }));
        return mergeScopedSearchResults(results, candidateK);
      })()
      : Promise.resolve({ ok: true, candidates: [] });
    const [semantic, keyword] = memberOnly
      ? [
          mergeScopedSearchResults(searchScopes.map((scope) => annotateScopedCandidates(recentUploaderDocuments({
            ...scopedSearchBase(scope),
          }), scope, currentChannelId)), candidateK),
          { ok: true, candidates: [] },
        ]
      : await Promise.all([semanticPromise, keywordPromise]);
    if (needsSemantic && !semantic?.ok && searchMode === 'semantic') {
      sendError(res, 503, semantic?.error || 'Team sharing vector search failed.');
      return true;
    }
    const candidates = memberOnly
      ? asArray(semantic.candidates)
      : searchMode === 'semantic'
      ? asArray(semantic.candidates)
      : searchMode === 'keyword'
        ? asArray(keyword.candidates)
        : fuseTeamSharingCandidates({
          semanticCandidates: asArray(semantic?.ok ? semantic.candidates : []),
          keywordCandidates: asArray(keyword.candidates),
          limit: candidateK,
        });
    const filteredCandidates = uploaderIds.length
      ? candidates.filter((candidate) => uploaderMatchesFilter(candidate, uploaderIds))
      : candidates;
    const rerankQuery = uniqueSearchList([
      intent.query,
      intent.semanticQuery,
      intent.keywords.join(' '),
    ], 3).join('\n');
    const rerankResults = memberOnly
      ? []
      : rerank
      ? await rerank({ query: rerankQuery, candidates: filteredCandidates, limit: candidateK })
      : localRerank({ query: rerankQuery, candidates: filteredCandidates });
    const ranked = rankTeamSharingCandidates({
      query: intent.query,
      semanticQuery: intent.semanticQuery,
      keywords: intent.keywords,
      topics: intent.topics,
      intent,
      candidates: filteredCandidates,
      teamSharingState,
      rerankResults,
      keywordCandidates: keyword.candidates || [],
      searchMode,
      scope: searchScope,
      modeBias: intent.modeBias,
      sortBy,
      minScore: body.minScore,
      now,
      limit,
    });
    for (const item of ranked.results) {
      applyTeamSharingFeedback(teamSharingState, {
        workspaceId: effectiveWorkspaceId,
        actorId: actorHumanId(actor) || tokenRecord?.user?.id || '',
        queryId: ranked.queryId,
        vectorDocumentId: item.vectorDocumentId,
        sessionId: item.sessionId,
        sourceRef: item.sourceRef,
        eventType: 'served',
        createdAt: now(),
      });
    }
    addSystemEvent('team_sharing_search', `Team sharing searched: ${compactText(body.query || '', 90)}`, {
      workspaceId: effectiveWorkspaceId,
      queryId: ranked.queryId,
      resultCount: ranked.results.length,
      candidateCount: filteredCandidates.length,
      searchMode,
      scope: searchScope,
      modeBias: intent.modeBias,
      sortBy,
      keywordCount: intent.keywords.length,
      topicCount: intent.topics.length,
      memberStatus: memberResolution.status,
      uploaderIds,
    });
    await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_search' });
    sendJson(res, 200, {
      ok: true,
      queryId: ranked.queryId,
      traceId: ranked.queryId,
      memberResolution,
      needsClarification: false,
      results: ranked.results.map((item) => {
        const contextUrl = resultContextUrl(item, ranked.queryId);
        const contextWebUrl = resultContextWebUrl(req, state, item, ranked.queryId);
        const sourceKind = String(item.sourceKind || (item.shareId ? 'share' : 'session')).trim() || 'session';
        const uploader = {
          id: String(item.uploaderId || '').trim(),
          name: String(item.uploaderName || '').trim(),
          email: String(item.uploaderEmail || '').trim(),
          avatar: String(item.uploaderAvatar || '').trim(),
        };
        const anchorEventId = sourceKind === 'share'
          ? ''
          : String(item.rawEventId || '').trim() || sourceAnchorEventId(item.sourceRef);
        return {
          vectorDocumentId: item.vectorDocumentId,
          sourceKind,
          workspaceId: String(item.workspaceId || '').trim(),
          channelId: String(item.channelId || '').trim(),
          projectKey: String(item.projectKey || '').trim(),
          retrievalScope: String(item.retrievalScope || '').trim(),
          sameChannel: Boolean(item.sameChannel),
          sessionId: item.sessionId,
          shareId: String(item.shareId || '').trim(),
          shareSectionId: String(item.shareSectionId || '').trim(),
          contentType: String(item.contentType || '').trim(),
          topicId: item.topicId,
          layer: item.layer,
          title: item.title,
          conclusion: compactText(item.text || item.title, 320),
          evidence: compactText(item.text || '', 320),
          sourceRef: item.sourceRef,
          rawEventId: anchorEventId,
          anchorEventId,
          contextUrl,
          contextWebUrl,
          contextPageUrl: contextWebUrl,
          shareUrl: sourceKind === 'share' ? contextWebUrl : '',
          uploader,
          finalScore: item.finalScore,
          vectorScore: item.vectorScore,
          rerankScore: item.rerankScore,
          keywordScore: item.keywordScore,
          hotnessScore: item.hotnessScore,
        };
      }),
      rerankUsed: Boolean(rerankResults?.length),
      candidateCount: filteredCandidates.length,
      semanticCandidateCount: asArray(semantic?.candidates).length,
      keywordCandidateCount: asArray(keyword?.candidates).length,
      searchMode,
      scope: searchScope,
      modeBias: intent.modeBias,
      sortBy,
      dateRange,
      timePreference: intent.timePreference,
      semanticQuery: intent.semanticQuery,
      keywords: intent.keywords,
      topics: intent.topics,
      retrievalIntent: {
        useKeyword: needsKeyword,
        useSemantic: needsSemantic,
        modeBias: intent.modeBias,
        scope: searchScope,
        ...(memberResolution.status !== 'none' ? { member: {
          uploaderIds,
          status: memberResolution.status,
        } } : {}),
      },
      degraded: {
        semantic: needsSemantic && !semantic?.ok ? (semantic?.error || 'semantic_search_failed') : '',
        keyword: keyword?.degraded ? (keyword.remoteError || 'keyword_search_degraded') : '',
      },
      trace: ranked.trace,
    });
    return true;
  }

  const contextMatch = url.pathname.match(/^\/api\/team-sharing\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(contextMatch[1]);
    const session = teamSharingState.sessions?.[sessionId] || null;
    if (!session) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    if (!teamSharingWorkspaceAccess({ actor, currentUser: browserUser, state, tokenRecord, session })) {
      sendError(res, 403, 'This Team Sharing context belongs to another server.');
      return true;
    }
    const result = contextWindowForTeamSharingSession(state.teamSharing || {}, sessionId, {
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      direction: url.searchParams.get('direction') || 'around',
      limit: url.searchParams.get('limit') || 21,
      order: url.searchParams.get('order') || 'asc',
    });
    if (!result.ok) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    const contextUrl = contextPagePath(sessionId, {
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      vectorDocumentId: url.searchParams.get('vectorDocumentId') || '',
      queryId: url.searchParams.get('queryId') || '',
      sourceRef: url.searchParams.get('sourceRef') || '',
      limit: url.searchParams.get('limit') || '21',
      order: url.searchParams.get('order') || 'asc',
    });
    const contextWebUrl = absoluteContextPageUrl(req, state, contextUrl, result.session?.workspaceId || session.workspaceId || '');
    sendJson(res, 200, {
      ...enrichTeamSharingContextResult(result, state),
      contextUrl,
      contextWebUrl,
      contextPageUrl: contextWebUrl,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/feedback') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const body = await readJson(req);
    const result = applyTeamSharingFeedback(state.teamSharing || {}, {
      ...body,
      workspaceId,
      actorId: body.actorId || actorHumanId(actor),
      createdAt: body.createdAt || now(),
    });
    if (!result.ok) {
      sendError(res, 400, 'Invalid team sharing feedback.');
      return true;
    }
    addSystemEvent('team_sharing_feedback', `Team sharing feedback recorded: ${body.eventType || ''}`, {
      workspaceId,
      vectorDocumentId: body.vectorDocumentId || '',
      eventType: body.eventType || '',
    });
    await persistState({ workspaceId, reason: 'team_sharing_feedback' });
    broadcastState();
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/doctor') {
    const embeddingCheck = {
      ready: dependencyReady(embeddingReady, ['MAGCLAW_EMBEDDING_BASE_URL', 'MAGCLAW_EMBEDDING_API_KEY', 'MAGCLAW_EMBEDDING_MODEL']),
    };
    if (url.searchParams.get('probe') === '1' && embeddingCheck.ready && typeof embeddingProbe === 'function') {
      try {
        const probe = await embeddingProbe();
        if (probe?.dimension) embeddingCheck.dimension = Number(probe.dimension);
      } catch (error) {
        embeddingCheck.ready = false;
        embeddingCheck.error = String(error?.message || error).slice(0, 160);
      }
    }
    const checks = {
      sync: { ready: true },
      zilliz: {
        ready: dependencyReady(zillizReady, ['MAGCLAW_ZILLIZ_ENDPOINT', 'MAGCLAW_ZILLIZ_TOKEN']),
      },
      embedding: embeddingCheck,
      rerank: {
        ready: dependencyReady(rerankReady, ['MAGCLAW_RERANK_URL', 'MAGCLAW_RERANK_API_KEY']),
      },
      llm: {
        ready: ['MAGCLAW_LLM_BASE_URL', 'MAGCLAW_LLM_API_KEY', 'MAGCLAW_LLM_MODEL']
          .every((key) => String(process.env[key] || '').trim()),
      },
    };
    sendJson(res, 200, {
      ok: Object.values(checks).every((item) => item.ready),
      checks,
    });
    return true;
  }

  return false;
}
