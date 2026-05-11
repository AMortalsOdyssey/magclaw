import os from 'node:os';

// Cloud connection and sync API routes.
// Pairing, import/export, and manual push/pull live here so the main server
// does not mix deployment transport concerns with chat, task, or Agent runtime
// routes. State mutation remains explicit through the injected dependencies.

export async function handleCloudApi(req, res, url, deps) {
  const {
    addSystemEvent,
    applyCloudSnapshot,
    broadcastState,
    cloudFetch,
    cloudSnapshot,
    cloudAuth,
    daemonRelay,
    dataDir,
    getState,
    host,
    normalizeCloudUrl,
    now,
    persistState,
    port,
    protocolVersion,
    publicConnection,
    pullStateFromCloud,
    pushStateToCloud,
    readJson,
    requireCloudAccess,
    sendError,
    sendJson,
  } = deps;
  const state = getState();

  async function sendAction(action) {
    try {
      return await action();
    } catch (error) {
      sendError(res, error.status || 500, error.message || 'Cloud action failed.');
      return null;
    }
  }

  function requireCloudRole(allowedRoles = []) {
    if (!cloudAuth?.isLoginRequired?.()) return true;
    return Boolean(cloudAuth.requireUser(req, res, sendError, allowedRoles));
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/health') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, {
      ok: true,
      name: 'Magclaw Control Plane',
      deployment: state.connection?.deployment || 'local',
      protocolVersion,
      workspaceId: url.searchParams.get('workspaceId') || state.connection?.workspaceId || 'local',
      time: now(),
      authInitialized: cloudAuth ? cloudAuth.publicCloudState(req).auth.initialized : false,
      relay: daemonRelay ? daemonRelay.publicRelayState() : null,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/auth/status') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    sendJson(res, 200, cloudAuth.publicCloudState(req));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/admin/apis') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    if (!cloudAuth.requireUser(req, res, sendError, ['admin'])) return true;
    sendJson(res, 200, {
      auth: {
        sessionLogin: '/api/cloud/auth/login',
        basicAuth: true,
        note: 'Use browser session cookies or HTTP Basic Auth over HTTPS for admin API calls.',
      },
      modules: [
        {
          id: 'members',
          name: 'Members',
          description: 'Invite workspace users, manage member roles, and create password reset links.',
          endpoints: [
            {
              method: 'POST',
              path: '/api/cloud/invitations/batch',
              role: 'admin',
              request: {
                emails: ['member@example.com', 'admin@example.com'],
                role: 'member',
              },
              response: {
                invitations: [
                  {
                    email: 'member@example.com',
                    role: 'member',
                    inviteToken: 'mc_inv_...',
                    inviteUrl: 'https://your-magclaw-host/activate?email=member%40example.com&token=mc_inv_...',
                  },
                ],
              },
              note: 'Target role must be member or admin. Each request issues a fresh invitation token.',
            },
            {
              method: 'POST',
              path: '/api/cloud/password-resets',
              role: 'admin',
              request: {
                memberId: 'wmem_...',
              },
              response: {
                email: 'member@example.com',
                resetToken: 'mc_reset_...',
                resetUrl: 'https://your-magclaw-host/reset-password?token=mc_reset_...',
              },
              note: 'Creates a fresh one-time reset link, revokes older unused reset links, invalidates existing sessions, and disables the old password.',
            },
            {
              method: 'PATCH',
              path: '/api/cloud/members/:id',
              role: 'admin',
              request: {
                role: 'admin',
              },
              response: {
                member: { id: 'wmem_...', role: 'admin' },
              },
              note: 'Admins can switch active members between Member and Admin. Owner rows are immutable.',
            },
          ],
        },
      ],
      endpoints: [
        { method: 'GET', path: '/api/cloud/auth/status', role: 'guest' },
        { method: 'POST', path: '/api/cloud/auth/login', role: 'guest' },
        { method: 'PATCH', path: '/api/cloud/auth/preferences', role: 'member' },
        { method: 'POST', path: '/api/cloud/auth/logout', role: 'member' },
        { method: 'POST', path: '/api/cloud/auth/heartbeat', role: 'member' },
        { method: 'POST', path: '/api/cloud/auth/register', role: 'invite' },
        { method: 'GET', path: '/api/cloud/auth/invitation-status', role: 'guest' },
        { method: 'GET', path: '/api/cloud/auth/reset-status', role: 'guest' },
        { method: 'POST', path: '/api/cloud/auth/reset-password', role: 'guest' },
        { method: 'GET', path: '/api/cloud/admin/apis', role: 'admin' },
          { method: 'GET', path: '/api/cloud/invitations', role: 'member' },
          { method: 'POST', path: '/api/cloud/invitations', role: 'admin' },
          { method: 'POST', path: '/api/cloud/invitations/batch', role: 'admin' },
          { method: 'PATCH', path: '/api/cloud/members/:id', role: 'admin' },
          { method: 'DELETE', path: '/api/cloud/members/:id', role: 'admin' },
          { method: 'POST', path: '/api/cloud/password-resets', role: 'admin' },
        { method: 'POST', path: '/api/settings', role: 'admin' },
        { method: 'POST', path: '/api/settings/fanout', role: 'admin' },
        { method: 'PATCH', path: '/api/settings/fanout', role: 'admin' },
        { method: 'POST', path: '/api/cloud/config', role: 'admin' },
        { method: 'POST', path: '/api/cloud/pair', role: 'admin' },
        { method: 'POST', path: '/api/cloud/disconnect', role: 'admin' },
        { method: 'POST', path: '/api/cloud/sync/push', role: 'admin' },
        { method: 'POST', path: '/api/cloud/sync/pull', role: 'admin' },
          { method: 'POST', path: '/api/cloud/computers/pairing-tokens', role: 'admin' },
      ],
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/auth/login') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.login(body, req, res));
    if (result) sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.login(body, req, res));
    if (result) sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    return true;
  }

  if (['PATCH', 'POST'].includes(req.method) && url.pathname === '/api/cloud/auth/preferences') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.updateUserPreferences(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/auth/logout') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.logout(req, res));
    if (result) {
      broadcastState();
      sendJson(res, 200, result);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.logout(req, res));
    if (result) {
      broadcastState();
      sendJson(res, 200, result);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/auth/heartbeat') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.touchPresence(req));
    if (result) sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/auth/register') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.registerWithInvite(body, req, res));
    if (result) {
      broadcastState();
      sendJson(res, 201, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.registerOpenAccount(body, req, res));
    if (result) {
      broadcastState();
      sendJson(res, 201, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.requestPasswordReset(body, req));
    if (result) sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/auth/invitation-status') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.invitationStatus(url.searchParams.get('token') || ''));
    if (result) sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/auth/reset-status') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.resetStatus(url.searchParams.get('token') || ''));
    if (result) sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/reset-status') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.resetStatus(url.searchParams.get('token') || ''));
    if (result) sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/auth/reset-password') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.resetPassword(body, req, res));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.resetPassword(body, req, res));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/console/invitations') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const user = cloudAuth.currentUser(req);
    if (!user) {
      sendError(res, 401, 'Login is required.');
      return true;
    }
    sendJson(res, 200, { invitations: cloudAuth.consoleStateForUser(user).invitations });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/console/servers') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const user = cloudAuth.currentUser(req);
    if (!user) {
      sendError(res, 401, 'Login is required.');
      return true;
    }
    sendJson(res, 200, { servers: cloudAuth.consoleStateForUser(user).workspaces });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/console/servers') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.createConsoleServer(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 201, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  const consoleServerSwitchMatch = url.pathname.match(/^\/api\/console\/servers\/([^/]+)\/switch$/);
  if (req.method === 'POST' && consoleServerSwitchMatch) {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.switchConsoleServer(decodeURIComponent(consoleServerSwitchMatch[1]), req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  const consoleServerRestoreMatch = url.pathname.match(/^\/api\/console\/servers\/([^/]+)\/restore$/);
  if (req.method === 'POST' && consoleServerRestoreMatch) {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.restoreConsoleServer(decodeURIComponent(consoleServerRestoreMatch[1]), req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  const consoleServerDeleteMatch = url.pathname.match(/^\/api\/console\/servers\/([^/]+)$/);
  if (req.method === 'DELETE' && consoleServerDeleteMatch) {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.deleteConsoleServer(decodeURIComponent(consoleServerDeleteMatch[1]), req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  const consoleInviteMatch = url.pathname.match(/^\/api\/console\/invitations\/([^/]+)\/(accept|decline)$/);
  if (req.method === 'POST' && consoleInviteMatch) {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const invitationId = decodeURIComponent(consoleInviteMatch[1]);
    const action = consoleInviteMatch[2];
    const result = await sendAction(() => (
      action === 'accept'
        ? cloudAuth.acceptConsoleInvitation(invitationId, req)
        : cloudAuth.declineConsoleInvitation(invitationId, req)
    ));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

    if (req.method === 'GET' && url.pathname === '/api/cloud/invitations') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
      if (!cloudAuth.requireUser(req, res, sendError)) return true;
      sendJson(res, 200, { invitations: cloudAuth.publicCloudState(req).invitations });
      return true;
    }

  if (req.method === 'POST' && url.pathname === '/api/cloud/invitations') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
      const body = await readJson(req);
      const result = await sendAction(() => cloudAuth.createInvitation(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 201, result);
    }
      return true;
    }

  if (req.method === 'POST' && url.pathname === '/api/cloud/invitations/batch') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.batchCreateInvitations(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 201, result);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/password-resets') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.createPasswordReset(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 201, result);
    }
    return true;
  }

    const cloudMemberMatch = url.pathname.match(/^\/api\/cloud\/members\/([^/]+)$/);
    if (cloudMemberMatch && req.method === 'PATCH') {
      if (!cloudAuth) {
        sendError(res, 503, 'Cloud auth service is unavailable.');
        return true;
      }
      const body = await readJson(req);
      const result = await sendAction(() => cloudAuth.updateMemberRole(cloudMemberMatch[1], body, req));
      if (result) {
        broadcastState();
        sendJson(res, 200, result);
      }
      return true;
    }

    if (cloudMemberMatch && req.method === 'DELETE') {
      if (!cloudAuth) {
        sendError(res, 503, 'Cloud auth service is unavailable.');
        return true;
      }
      const result = await sendAction(() => cloudAuth.removeMember(cloudMemberMatch[1], req));
      if (result) {
        broadcastState();
        sendJson(res, 200, result);
      }
      return true;
    }

  if (req.method === 'GET' && url.pathname === '/api/cloud/relay/status') {
    sendJson(res, 200, daemonRelay ? daemonRelay.publicRelayState() : { onlineComputerIds: [], daemonEvents: [] });
    return true;
  }

  if (['POST', 'PATCH'].includes(req.method) && url.pathname === '/api/cloud/server/profile') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.updateServerProfile(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/join-links') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.createJoinLink(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 201, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/join-links/status') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.joinLinkStatus(url.searchParams.get('token') || '', req));
    if (result) sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/join-links/accept') {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const body = await readJson(req);
    const result = await sendAction(() => cloudAuth.acceptJoinLink(body, req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  const revokeJoinLinkMatch = url.pathname.match(/^\/api\/cloud\/join-links\/([^/]+)\/revoke$/);
  if (req.method === 'POST' && revokeJoinLinkMatch) {
    if (!cloudAuth) {
      sendError(res, 503, 'Cloud auth service is unavailable.');
      return true;
    }
    const result = await sendAction(() => cloudAuth.revokeJoinLink(decodeURIComponent(revokeJoinLinkMatch[1]), req));
    if (result) {
      broadcastState();
      sendJson(res, 200, { ok: true, ...result, cloud: cloudAuth.publicCloudState(req) });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/computers/pairing-tokens') {
    if (!daemonRelay || !cloudAuth) {
      sendError(res, 503, 'Cloud relay service is unavailable.');
      return true;
    }
      if (cloudAuth.isLoginRequired() && !cloudAuth.requireUser(req, res, sendError, ['admin'])) return true;
    const body = await readJson(req);
    const current = cloudAuth.currentUser(req);
    const result = daemonRelay.createPairingToken({ ...body, createdBy: current?.id || null }, req);
    if (cloudAuth.persistCloudState) await cloudAuth.persistCloudState();
    else await persistState();
    broadcastState();
    sendJson(res, 201, result);
    return true;
  }

  const revokeComputerTokenMatch = url.pathname.match(/^\/api\/cloud\/computers\/([^/]+)\/tokens\/revoke$/);
  if (req.method === 'POST' && revokeComputerTokenMatch) {
    if (!daemonRelay || !cloudAuth) {
      sendError(res, 503, 'Cloud relay service is unavailable.');
      return true;
    }
      if (!cloudAuth.requireUser(req, res, sendError, ['admin'])) return true;
    const body = await readJson(req);
    const result = await daemonRelay.revokeComputerToken(revokeComputerTokenMatch[1], body.tokenId || '');
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/status') {
    sendJson(res, 200, {
      connection: publicConnection(),
      health: {
        localUrl: `http://${host}:${port}`,
        dataDir,
        protocolVersion,
      },
      cloud: cloudAuth ? cloudAuth.publicCloudState(req) : null,
      relay: daemonRelay ? daemonRelay.publicRelayState() : null,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/config') {
    if (!requireCloudRole(['admin'])) return true;
    const body = await readJson(req);
    const previousMode = state.connection.mode;
    state.connection = {
      ...state.connection,
      mode: body.mode === 'cloud' ? 'cloud' : 'local',
      deployment: body.deployment ? String(body.deployment) : state.connection.deployment,
      controlPlaneUrl: normalizeCloudUrl(body.controlPlaneUrl ?? state.connection.controlPlaneUrl),
      relayUrl: normalizeCloudUrl(body.relayUrl ?? state.connection.relayUrl),
      cloudToken: body.cloudToken !== undefined ? String(body.cloudToken || '').trim() : state.connection.cloudToken,
      workspaceId: String(body.workspaceId || state.connection.workspaceId || 'local'),
      deviceName: String(body.deviceName || state.connection.deviceName || os.hostname()),
      autoSync: Boolean(body.autoSync),
      protocolVersion,
    };
    if (state.connection.mode === 'local') {
      state.connection.pairingStatus = 'local';
    } else if (previousMode !== 'cloud' && state.connection.pairingStatus === 'local') {
      state.connection.pairingStatus = 'configured';
    }
    addSystemEvent('cloud_configured', `Connection mode set to ${state.connection.mode}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/pair') {
    if (!requireCloudRole(['admin'])) return true;
    const body = await readJson(req);
    if (body.controlPlaneUrl !== undefined) state.connection.controlPlaneUrl = normalizeCloudUrl(body.controlPlaneUrl);
    if (body.relayUrl !== undefined) state.connection.relayUrl = normalizeCloudUrl(body.relayUrl);
    if (body.cloudToken !== undefined) state.connection.cloudToken = String(body.cloudToken || '').trim();
    if (body.workspaceId !== undefined) state.connection.workspaceId = String(body.workspaceId || 'local');
    if (body.deviceName !== undefined) state.connection.deviceName = String(body.deviceName || os.hostname());
    state.connection.mode = 'cloud';
    state.connection.pairingStatus = 'pairing';
    await persistState();

    try {
      const health = await cloudFetch(`/api/cloud/health?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
      state.connection.pairingStatus = 'paired';
      state.connection.pairedAt = now();
      state.connection.lastError = '';
      addSystemEvent('cloud_paired', `Paired with ${state.connection.controlPlaneUrl}.`, { health });
      await persistState();
      broadcastState();
      sendJson(res, 200, { connection: publicConnection(), health });
    } catch (error) {
      state.connection.pairingStatus = 'configured';
      state.connection.lastError = error.message;
      await persistState();
      broadcastState();
      sendError(res, 502, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/disconnect') {
    if (!requireCloudRole(['admin'])) return true;
    state.connection.mode = 'local';
    state.connection.pairingStatus = 'local';
    state.connection.pairedAt = null;
    state.connection.lastSyncAt = null;
    state.connection.lastSyncDirection = null;
    state.connection.lastError = '';
    state.connection.autoSync = false;
    addSystemEvent('cloud_disconnected', 'Switched back to local-only mode.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/export-state') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, { snapshot: cloudSnapshot() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/import-state') {
    if (!requireCloudAccess(req, res)) return true;
    const body = await readJson(req);
    const snapshot = body.snapshot || body;
    applyCloudSnapshot(snapshot);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'import';
    state.connection.lastError = '';
    addSystemEvent('cloud_imported', `Cloud snapshot imported${body.reason ? ` (${body.reason})` : ''}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, importedAt: state.connection.lastSyncAt });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/push') {
    if (!requireCloudRole(['admin'])) return true;
    const result = await pushStateToCloud('manual_push');
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/pull') {
    if (!requireCloudRole(['admin'])) return true;
    const result = await pullStateFromCloud();
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  return false;
}
