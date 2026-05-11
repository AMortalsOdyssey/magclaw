function computerIsDisabled(computer = {}) {
  if (!computer) return false;
  return String(computer.status || '').toLowerCase() === 'disabled' || Boolean(computer.disabledAt);
}

function computerIsDeleted(computer = {}) {
  if (!computer) return false;
  return Boolean(computer.deletedAt || computer.archivedAt) || String(computer.status || '').toLowerCase() === 'deleted';
}

function agentIsDeleted(agent = {}) {
  if (!agent) return false;
  return Boolean(agent.deletedAt || agent.archivedAt) || String(agent.status || '').toLowerCase() === 'deleted';
}

function agentIsDisabled(agent = {}) {
  if (!agent) return false;
  return String(agent.status || '').toLowerCase() === 'disabled' || Boolean(agent.disabledAt || agent.disabledByComputerAt || agent.disabledByServerDeletedAt);
}

function agentComputerUnavailable(agent = {}) {
  if (!agent) return true;
  const computer = agent.computerId ? byId(appState?.computers, agent.computerId) : null;
  if (agent.computerId && !computer && agent.computerId !== 'cmp_local') return true;
  return Boolean(computer && (computerIsDisabled(computer) || computerIsDeleted(computer)));
}

function agentIsActiveInWorkspace(agent = {}) {
  return Boolean(agent?.id) && !agentIsDeleted(agent) && !agentIsDisabled(agent) && !agentComputerUnavailable(agent);
}

function computerIsConnected(computer = {}) {
  if (!computer) return false;
  if (computerIsDisabled(computer) || computerIsDeleted(computer)) return false;
  return presenceTone(computer.status || 'offline') === 'online' || String(computer.status || '').toLowerCase() === 'connected';
}

function computerCreatedMs(computer = {}) {
  if (!computer) return 0;
  const value = Date.parse(computer.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

function sortComputersByAvailability(computers = []) {
  return computers.filter(Boolean).sort((a, b) => {
    const disabledDelta = Number(computerIsDisabled(a)) - Number(computerIsDisabled(b));
    if (disabledDelta) return disabledDelta;
    const createdDelta = computerCreatedMs(a) - computerCreatedMs(b);
    if (createdDelta) return createdDelta;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}
