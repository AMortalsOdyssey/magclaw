import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

function htmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function httpOriginFromValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function resetEmailLogoUrl(env = process.env, resetUrl = '') {
  const configured = String(env.MAGCLAW_MAIL_LOGO_URL || env.MAGCLAW_LOGO_URL || '').trim();
  if (configured) return configured;
  const origin = httpOriginFromValue(env.MAGCLAW_PUBLIC_URL) || httpOriginFromValue(resetUrl);
  return origin ? `${origin}/brand/magclaw-logo.png` : '';
}

function smtpConfigured(env = process.env) {
  return Boolean(env.MAGCLAW_SMTP_HOST || env.SMTP_HOST || env.MAGCLAW_MAIL_TRANSPORT === 'file');
}

function smtpAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function smtpB64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function smtpHeaderValue(value) {
  const text = String(value || '');
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${smtpB64(text)}?=`;
}

function smtpEscapeData(value) {
  return String(value || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function smtpMessage({ from, to, subject, text, html }) {
  const boundary = `magclaw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${smtpHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function readSmtpResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP response timed out.'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || '';
      if (!/^\d{3} /.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      resolve({ code, lines, raw: buffer });
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function smtpCommand(socket, line, expectedCodes, timeoutMs) {
  if (line) socket.write(`${line}\r\n`);
  const response = await readSmtpResponse(socket, timeoutMs);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP command failed (${response.code}): ${response.lines.join(' | ')}`);
  }
  return response;
}

async function openSmtpSocket({ host, port, secure, rejectUnauthorized, timeoutMs }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized })
    : net.connect({ host, port });
  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs);
  socket.on('timeout', () => socket.destroy(new Error('SMTP socket timed out.')));
  if (secure) await once(socket, 'secureConnect');
  else await once(socket, 'connect');
  return socket;
}

async function sendSmtpMail(env, message) {
  const host = env.MAGCLAW_SMTP_HOST || env.SMTP_HOST;
  if (!host) return { sent: false, reason: 'smtp-host-missing' };
  const secure = /^(1|true|yes)$/i.test(String(env.MAGCLAW_SMTP_SECURE || ''))
    || Number(env.MAGCLAW_SMTP_PORT || env.SMTP_PORT || 0) === 465;
  const port = Number(env.MAGCLAW_SMTP_PORT || env.SMTP_PORT || (secure ? 465 : 587));
  const timeoutMs = Math.max(1000, Number(env.MAGCLAW_SMTP_TIMEOUT_MS || 10000));
  const rejectUnauthorized = !/^(0|false|no)$/i.test(String(env.MAGCLAW_SMTP_TLS_REJECT_UNAUTHORIZED || ''));
  const helo = env.MAGCLAW_SMTP_HELO || 'magclaw.local';
  const user = env.MAGCLAW_SMTP_USER || env.SMTP_USER || '';
  const password = env.MAGCLAW_SMTP_PASSWORD || env.SMTP_PASSWORD || '';
  let socket = await openSmtpSocket({ host, port, secure, rejectUnauthorized, timeoutMs });
  try {
    await smtpCommand(socket, '', [220], timeoutMs);
    await smtpCommand(socket, `EHLO ${helo}`, [250], timeoutMs);
    const shouldStartTls = !secure && (
      /^(1|true|yes)$/i.test(String(env.MAGCLAW_SMTP_STARTTLS || ''))
      || (port === 587 && !/^(0|false|no)$/i.test(String(env.MAGCLAW_SMTP_STARTTLS || '')))
    );
    if (shouldStartTls) {
      await smtpCommand(socket, 'STARTTLS', [220], timeoutMs);
      socket = tls.connect({ socket, servername: host, rejectUnauthorized });
      socket.setEncoding('utf8');
      socket.setTimeout(timeoutMs);
      await once(socket, 'secureConnect');
      await smtpCommand(socket, `EHLO ${helo}`, [250], timeoutMs);
    }
    if (user || password) {
      await smtpCommand(socket, 'AUTH LOGIN', [334], timeoutMs);
      await smtpCommand(socket, smtpB64(user), [334], timeoutMs);
      await smtpCommand(socket, smtpB64(password), [235], timeoutMs);
    }
    await smtpCommand(socket, `MAIL FROM:<${smtpAddress(message.from)}>`, [250], timeoutMs);
    await smtpCommand(socket, `RCPT TO:<${smtpAddress(message.to)}>`, [250, 251], timeoutMs);
    await smtpCommand(socket, 'DATA', [354], timeoutMs);
    await smtpCommand(socket, `${smtpEscapeData(smtpMessage(message))}\r\n.`, [250], timeoutMs);
    await smtpCommand(socket, 'QUIT', [221], timeoutMs);
    return { sent: true, transport: 'smtp', host, port };
  } finally {
    socket.destroy();
  }
}

export function createMailService(options = {}) {
  const env = options.env || process.env;
  const from = env.MAGCLAW_MAIL_FROM || env.MAGCLAW_SMTP_FROM || 'MagClaw <noreply@magclaw.local>';
  const transport = env.MAGCLAW_MAIL_TRANSPORT || (env.MAGCLAW_SMTP_HOST ? 'smtp' : 'disabled');
  const outbox = env.MAGCLAW_MAIL_OUTBOX || path.join(env.MAGCLAW_DATA_DIR || '.', 'mail-outbox.jsonl');

  async function sendPasswordReset({ to, name, resetUrl }) {
    const email = String(to || '').trim();
    if (!email || !resetUrl) return { sent: false, reason: 'missing-recipient-or-url' };
    const subject = '重置你的 MagClaw 密码';
    const safeName = htmlEscape(name || email.split('@')[0]);
    const safeUrl = htmlEscape(resetUrl);
    const safeLogoUrl = htmlEscape(resetEmailLogoUrl(env, resetUrl));
    const logoHtml = safeLogoUrl
      ? `<img src="${safeLogoUrl}" width="56" height="56" alt="MagClaw" style="display:block;width:56px;height:56px;border:0;border-radius:14px;" />`
      : '<div style="width:56px;height:56px;border-radius:14px;background:#ff66cc;color:#1a0020;font-size:24px;font-weight:900;line-height:56px;text-align:center;">M</div>';
    const text = [
      `你好，${name || email.split('@')[0]}：`,
      '',
      '有人请求重置你的 MagClaw 账户密码。',
      `重置密码：${resetUrl}`,
      '',
      '此链接将在 24 小时后过期。如果这不是你本人发起的请求，可以忽略这封邮件。',
    ].join('\n');
    const html = `
      <div style="margin:0;padding:34px 18px;background:#fffaf7;color:#1d1022;font-family:Inter,Arial,sans-serif;">
        <div style="max-width:520px;margin:0 auto;">
          <div style="margin:0 0 14px;text-align:center;">
            <div style="display:inline-block;padding:6px;border:1px solid #1a0020;border-radius:18px;background:#ffffff;box-shadow:3px 3px 0 #1a0020;">${logoHtml}</div>
            <div style="margin-top:10px;color:#7d6075;font-size:12px;font-weight:800;letter-spacing:0;text-transform:uppercase;">MagClaw</div>
          </div>
          <div style="border:2px solid #1a0020;border-radius:8px;background:#ffffff;box-shadow:5px 5px 0 #1a0020;padding:30px 30px 28px;">
            <h1 style="margin:0 0 16px;color:#1d1022;font-size:26px;line-height:1.2;font-weight:800;">重置你的密码</h1>
            <p style="margin:0 0 14px;color:#4e3e4a;font-size:15px;line-height:1.55;">你好，${safeName}：</p>
            <p style="margin:0 0 22px;color:#4e3e4a;font-size:15px;line-height:1.55;">有人请求重置你的 MagClaw 账户密码。点击下方按钮设置新密码：</p>
            <p style="margin:0 0 24px;">
              <a href="${safeUrl}" style="display:inline-block;min-width:164px;background:#ff66cc;color:#1a0020;padding:13px 22px;border:2px solid #1a0020;border-radius:8px;box-shadow:3px 3px 0 #1a0020;text-align:center;text-decoration:none;font-size:15px;font-weight:900;line-height:1;">重置密码</a>
            </p>
            <p style="margin:0 0 8px;color:#777;font-size:13px;line-height:1.45;">也可以复制此链接：<a href="${safeUrl}" style="color:#d93682;font-weight:800;text-decoration:underline;text-underline-offset:3px;">${safeUrl}</a></p>
            <p style="margin:0;color:#777;font-size:13px;line-height:1.45;">此链接将在 24 小时后过期。如果这不是你本人发起的请求，可以安全地忽略这封邮件。</p>
          </div>
        </div>
      </div>
    `;

    if (transport === 'file') {
      await mkdir(path.dirname(outbox), { recursive: true });
      await appendFile(outbox, `${JSON.stringify({
        type: 'password_reset',
        from,
        to: email,
        subject,
        text,
        html,
        createdAt: new Date().toISOString(),
      })}\n`);
      return { sent: true, transport: 'file', outbox };
    }

    if (transport === 'smtp') {
      if (!smtpConfigured(env)) return { sent: false, reason: 'smtp-not-configured' };
      return sendSmtpMail(env, { from, to: email, subject, text, html });
    }

    return { sent: false, reason: 'mail-disabled' };
  }

  return {
    transport,
    configured: smtpConfigured(env),
    sendPasswordReset,
  };
}
