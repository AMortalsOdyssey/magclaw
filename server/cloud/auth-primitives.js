import crypto from 'node:crypto';
import { publicLinkOrigin, requestOrigin } from './auth-utils.js';

export const SESSION_COOKIE = 'magclaw_session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
export const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60 * 24;
export const HUMAN_PRESENCE_TIMEOUT_MS = Number(process.env.MAGCLAW_HUMAN_PRESENCE_TIMEOUT_MS || 1000 * 60 * 2);
export const HUMAN_PRESENCE_PERSIST_INTERVAL_MS = 1000 * 60;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 30;
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function token(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function numericToken(prefix, max = 100_000_000) {
  return `${prefix}_${String(crypto.randomInt(0, max)).padStart(8, '0')}`;
}

export function scryptPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sessionCookie(rawToken, req) {
  const secure = requestOrigin(req).startsWith('https://') || process.env.MAGCLAW_SECURE_COOKIES === '1';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

function slugifyWorkspace(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeWorkspaceSlug(value, fallback = '') {
  return slugifyWorkspace(value) || slugifyWorkspace(fallback);
}

export function validatePassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    const error = new Error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`);
    error.status = 400;
    throw error;
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    const error = new Error('Password must include both letters and numbers.');
    error.status = 400;
    throw error;
  }
  return value;
}

export function configuredAdminCredentials() {
  if (process.env.MAGCLAW_ALLOW_SIGNUPS === '1') return null;
  const email = normalizeEmail(process.env.MAGCLAW_ADMIN_EMAIL || '');
  const password = String(process.env.MAGCLAW_ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  return {
    email,
    password,
    name: String(process.env.MAGCLAW_ADMIN_NAME || email.split('@')[0]).trim(),
  };
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  void passwordHash;
  return safe;
}

export function publicInvitation(invitation) {
  if (!invitation) return null;
  const { tokenHash, ...safe } = invitation;
  void tokenHash;
  const metadata = safe.metadata && typeof safe.metadata === 'object' ? safe.metadata : {};
  const expiresAt = new Date(safe.expiresAt || 0).getTime();
  const status = safe.acceptedAt
    ? 'accepted'
    : metadata.declinedAt
      ? 'declined'
      : safe.revokedAt
        ? 'revoked'
        : expiresAt && expiresAt <= Date.now()
          ? 'expired'
          : 'pending';
  return { ...safe, status, metadata };
}

export function publicJoinLink(link, rawToken = '', req = null) {
  if (!link) return null;
  const { tokenHash, ...safe } = link;
  void tokenHash;
  const metadata = safe.metadata && typeof safe.metadata === 'object' ? safe.metadata : {};
  const expiresAt = safe.expiresAt ? new Date(safe.expiresAt).getTime() : 0;
  const status = safe.revokedAt
    ? 'revoked'
    : expiresAt && expiresAt <= Date.now()
      ? 'expired'
      : safe.maxUses && Number(safe.usedCount || 0) >= Number(safe.maxUses)
        ? 'exhausted'
        : 'active';
  const displayToken = rawToken || metadata.rawToken || '';
  const url = displayToken
    ? `${publicLinkOrigin(req).replace(/\/+$/, '')}/join/${encodeURIComponent(displayToken)}`
    : '';
  return { ...safe, metadata: { ...metadata, rawToken: undefined }, status, url };
}

export function publicPasswordReset(reset, user = null) {
  if (!reset) return null;
  const { tokenHash, ...safe } = reset;
  void tokenHash;
  return {
    ...safe,
    email: user?.email || safe.email || '',
    name: user?.name || safe.name || '',
  };
}

export function publicSystemNotification(notification) {
  return notification ? { ...notification } : null;
}

export function basicAuthCredentials(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return {
      email: normalizeEmail(decoded.slice(0, separator)),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}
