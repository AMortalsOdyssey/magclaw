import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Legacy mission runner for one-off Codex exec jobs.
// Chat Agents use the runtime manager; this module keeps mission-control runs
// separate so their CLI process lifecycle is easier to inspect.
export function createMissionRunner(deps) {
  const {
    addRunEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    displayActor,
    ensureTaskThread,
    findTask,
    getState,
    localReferenceLines,
    now,
    persistState,
    runningProcesses,
    ROOT,
    RUNS_DIR,
    taskLabel,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  function createPrompt(mission, run, attachments) {
    const contract = {
      goal: mission.goal,
      workspace: mission.workspace,
      scopeAllow: mission.scopeAllow,
      scopeDeny: mission.scopeDeny,
      gates: mission.gates,
      evidenceRequired: mission.evidenceRequired,
      humanCheckpoints: mission.humanCheckpoints,
      localReferences: mission.localReferences || [],
    };
  
    const attachmentLines = attachments.length
      ? attachments.map((item) => `- ${item.name} (${item.type || 'file'}): ${item.path}`).join('\n')
      : '- none';
  
    return [
      'You are Codex running under Magclaw local mission control.',
      '',
      'Mission contract:',
      JSON.stringify(contract, null, 2),
      '',
      'Operating rules:',
      '- Stay inside the mission scope unless the user explicitly asks otherwise.',
      '- Prefer small, verifiable changes.',
      '- Run the requested gates when practical.',
      '- End with a concise evidence report: changed files, tests run, residual risks.',
      '- Do not claim completion if evidence is missing.',
      '',
      `Run id: ${run.id}`,
      `Mission id: ${mission.id}`,
      '',
      'Attachments saved locally:',
      attachmentLines,
      '',
      'Local project references are original files/folders, not attachment copies:',
      localReferenceLines(mission.localReferences || []) || '- none',
      '',
      'User request:',
      mission.goal,
    ].join('\n');
  }
  
  function summarizeCodexEvent(event) {
    if (!event || typeof event !== 'object') return String(event || '');
    const candidates = [
      event.message,
      event.text,
      event.output,
      event.delta,
      event.type,
      event.msg?.message,
      event.msg?.text,
      event.item?.text,
      event.item?.message,
    ].filter(Boolean);
  
    if (candidates.length) return String(candidates[0]);
    return JSON.stringify(event).slice(0, 600);
  }
  
  function handleCodexLine(run, line) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      addRunEvent(run.id, 'codex', summarizeCodexEvent(event), { raw: event });
    } catch {
      addRunEvent(run.id, 'stdout', line);
    }
  }
  
  function startCodexRun(mission, run) {
    const workspace = path.resolve(mission.workspace || state.settings.defaultWorkspace || ROOT);
    const attachments = state.attachments.filter((item) => mission.attachmentIds.includes(item.id));
    const imageAttachments = attachments.filter((item) => String(item.type || '').startsWith('image/'));
    const outputFile = path.join(RUNS_DIR, `${run.id}-last-message.txt`);
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      state.settings.sandbox || 'workspace-write',
      '-C',
      workspace,
      '-o',
      outputFile,
    ];
  
    if (state.settings.model) {
      args.push('-m', state.settings.model);
    }
  
    for (const image of imageAttachments) {
      args.push('-i', image.path);
    }
  
    args.push('-');
  
    run.status = 'running';
    run.startedAt = now();
    run.workspace = workspace;
    run.command = `${state.settings.codexPath} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
    mission.status = 'running';
    mission.updatedAt = now();
    addRunEvent(run.id, 'runner', `Starting Codex in ${workspace}`);
    persistState().then(broadcastState);
  
    const child = spawn(state.settings.codexPath || 'codex', args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
  
    runningProcesses.set(run.id, child);
  
    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) handleCodexLine(run, line);
      persistState();
    });
  
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) addRunEvent(run.id, 'stderr', message);
      persistState();
    });
  
    child.on('error', (error) => {
      runningProcesses.delete(run.id);
      run.status = 'failed';
      run.completedAt = now();
      run.exitCode = null;
      mission.status = 'failed';
      mission.updatedAt = now();
      addRunEvent(run.id, 'runner-error', error.message);
      persistState().then(broadcastState);
    });
  
    child.on('close', async (code) => {
      runningProcesses.delete(run.id);
      if (stdoutBuffer.trim()) handleCodexLine(run, stdoutBuffer.trim());
      run.exitCode = code;
      run.completedAt = now();
  
      let finalMessage = '';
      try {
        finalMessage = (await readFile(outputFile, 'utf8')).trim();
      } catch {
        finalMessage = '';
      }
  
      run.finalMessage = finalMessage;
      if (run.stopRequested) {
        run.status = 'stopped';
        mission.status = 'ready';
      } else {
        run.status = code === 0 ? 'succeeded' : 'failed';
        mission.status = code === 0 ? 'review' : 'failed';
      }
      if (run.taskId) {
        const task = findTask(run.taskId);
        if (task) {
          if (run.status === 'succeeded') {
            task.status = 'in_review';
            task.reviewRequestedAt = now();
            addTaskHistory(task, 'review_requested', `Codex run ${run.id} succeeded; moved to review.`, task.claimedBy || 'agt_codex', { runId: run.id });
            addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} finished. Review requested.`);
            addTaskTimelineMessage(task, `👀 ${displayActor(task.claimedBy || 'agt_codex')} moved ${taskLabel(task)} to In Review`, 'task_review');
          } else if (run.status === 'failed') {
            addTaskHistory(task, 'run_failed', `Codex run ${run.id} failed.`, task.claimedBy || 'agt_codex', { runId: run.id });
            addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} failed. Check evidence.`);
          } else if (run.status === 'stopped') {
            addTaskHistory(task, 'run_stopped', `Codex run ${run.id} stopped.`, task.claimedBy || 'agt_codex', { runId: run.id });
            addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} stopped.`);
          }
        }
      }
      mission.updatedAt = now();
      addRunEvent(run.id, 'runner', `Codex exited with code ${code ?? 'unknown'}.`);
      await persistState();
      broadcastState();
    });
  
    child.stdin.write(createPrompt(mission, run, attachments));
    child.stdin.end();
  }

  return {
    createPrompt,
    handleCodexLine,
    startCodexRun,
    summarizeCodexEvent,
  };
}
