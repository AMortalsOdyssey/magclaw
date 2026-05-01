import path from 'node:path';

// Mission and Codex run API routes.
// A mission captures the human's requested work, while a run is the concrete
// Codex CLI process that executes it. Keeping this boundary separate makes the
// process lifecycle easier to inspect without mixing it into chat routing.

export async function handleMissionApi(req, res, url, deps) {
  const {
    addRunEvent,
    addSystemEvent,
    broadcastState,
    findMission,
    findRun,
    getRunningProcess,
    getState,
    makeId,
    now,
    persistState,
    readJson,
    root,
    sendError,
    sendJson,
    splitLines,
    startCodexRun,
  } = deps;
  const state = getState();

  if (req.method === 'POST' && url.pathname === '/api/missions') {
    const body = await readJson(req);
    const mission = {
      id: makeId('mis'),
      title: String(body.title || 'Untitled mission').slice(0, 140),
      goal: String(body.goal || '').trim(),
      status: 'ready',
      priority: body.priority || 'normal',
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || root)),
      scopeAllow: splitLines(body.scopeAllow || '**/*'),
      scopeDeny: splitLines(body.scopeDeny || '.env*\nnode_modules/**\n.git/**'),
      gates: splitLines(body.gates),
      evidenceRequired: splitLines(body.evidenceRequired || 'diff summary\ntest output\nrisk notes'),
      humanCheckpoints: splitLines(body.humanCheckpoints || 'before dangerous command\nbefore deploy'),
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      localReferences: Array.isArray(body.localReferences) ? body.localReferences : [],
      createdAt: now(),
      updatedAt: now(),
    };

    if (!mission.goal) {
      sendError(res, 400, 'Mission goal is required.');
      return true;
    }

    state.missions.unshift(mission);
    addSystemEvent('mission_created', `Mission created: ${mission.title}`, { missionId: mission.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { mission });
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
  if (req.method === 'POST' && runMatch) {
    const mission = findMission(runMatch[1]);
    if (!mission) {
      sendError(res, 404, 'Mission not found.');
      return true;
    }

    // Runs are intentionally small records; the long-lived output stream stays
    // with startCodexRun and runningProcesses so API state stays serializable.
    const run = {
      id: makeId('run'),
      missionId: mission.id,
      runtime: 'codex',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      finalMessage: '',
    };
    state.runs.unshift(run);
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { run });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const run = findRun(cancelMatch[1]);
    const child = getRunningProcess(cancelMatch[1]);
    if (!run || !child) {
      sendError(res, 404, 'Running Codex process not found.');
      return true;
    }

    // Cancellation is persisted before the SIGTERM so the UI can reflect the
    // user's intent even if the child process exits immediately.
    run.cancelRequested = true;
    child.kill('SIGTERM');
    addRunEvent(run.id, 'runner', 'Cancellation requested.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { run });
    return true;
  }

  return false;
}
