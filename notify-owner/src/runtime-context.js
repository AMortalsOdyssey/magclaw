const runtimes = new Map();

function keyFor(profilePaths) {
  return String(profilePaths?.dir || '');
}

export function registerNotifyRuntime(profilePaths, runtime) {
  const key = keyFor(profilePaths);
  if (!key) throw new Error('Notify runtime profile path is required.');
  runtimes.set(key, runtime || {});
  return () => {
    if (runtimes.get(key) === runtime) runtimes.delete(key);
  };
}

export function notifyRuntime(profilePaths) {
  return runtimes.get(keyFor(profilePaths)) || {};
}
