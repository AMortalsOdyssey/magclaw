function stringValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || value.name || '';
  if (value && typeof value === 'object') {
    return [
      value.message,
      value.error,
      value.detail,
      value.text,
      value.name,
      value.code,
    ].filter(Boolean).map(String).join('\n');
  }
  return String(value || '');
}

function runtimeErrorText(input) {
  const text = stringValue(input).trim();
  if (text) return text;
  try {
    return JSON.stringify(input ?? {}).slice(0, 2000);
  } catch {
    return '';
  }
}

function classifyRuntimeCode(lower) {
  if (/(not logged in|login is required|login required|reauthori[sz]e|refresh token|oauth|unauthorized|authentication|401)/i.test(lower)) {
    return 'login_required';
  }
  if (/(session replay|replay rejected|thread\/resume|thread resume|thread not found|invalid thread|resume failed|unknown thread|stale session)/i.test(lower)) {
    return 'session_replay_rejected';
  }
  if (/(credential proxy|credential.*proxy|bind.*credential|eaddrinuse|econnrefused.*credential|credential server)/i.test(lower)) {
    return 'credential_proxy_unavailable';
  }
  if (/(responses_websocket|failed to connect to websocket|\/v1\/responses|http_proxy|https_proxy|proxy|connection reset|network.*error|enotfound|etimedout|econnreset)/i.test(lower)) {
    return 'network_or_proxy_failure';
  }
  if (/(enoent|spawn.*failed|command not found|no such file or directory|exited before thread start|app-server exited before thread start|invalid executable|einval)/i.test(lower)) {
    return 'spawn_failed';
  }
  if (/(startup timeout|timed out|timeout|waited too long|deadline exceeded)/i.test(lower)) {
    return 'startup_timeout';
  }
  return 'unknown_runtime_error';
}

const RUNTIME_ERROR_INFO = {
  login_required: {
    title: 'Runtime login required',
    recoverable: true,
    recoveryAction: 'reauthorize_runtime',
    userAction: 'Open the computer and sign in to the runtime, then retry the agent.',
  },
  session_replay_rejected: {
    title: 'Runtime session expired',
    recoverable: true,
    recoveryAction: 'start_new_session',
    userAction: 'MagClaw will start a fresh runtime session and retry queued work.',
  },
  credential_proxy_unavailable: {
    title: 'Credential proxy unavailable',
    recoverable: true,
    recoveryAction: 'restart_credential_proxy',
    userAction: 'Restart the computer daemon or free the credential proxy port, then retry.',
  },
  network_or_proxy_failure: {
    title: 'Runtime network failure',
    recoverable: true,
    recoveryAction: 'check_proxy_then_retry',
    userAction: 'Check proxy/network access to the runtime provider, then retry.',
  },
  spawn_failed: {
    title: 'Runtime failed to start',
    recoverable: false,
    recoveryAction: 'fix_runtime_path',
    userAction: 'Check the configured runtime path and install status.',
  },
  startup_timeout: {
    title: 'Runtime startup timed out',
    recoverable: true,
    recoveryAction: 'restart_runtime',
    userAction: 'Restart the runtime or computer daemon, then retry.',
  },
  unknown_runtime_error: {
    title: 'Runtime error',
    recoverable: false,
    recoveryAction: 'inspect_logs',
    userAction: 'Open activity logs to inspect the raw runtime error.',
  },
};

export function classifyRuntimeError(input, context = {}) {
  const detail = runtimeErrorText(input).slice(0, 2000);
  const lower = detail.toLowerCase();
  const code = classifyRuntimeCode(lower);
  const info = RUNTIME_ERROR_INFO[code] || RUNTIME_ERROR_INFO.unknown_runtime_error;
  const message = stringValue(input).trim() || detail || info.title;
  return {
    code,
    title: info.title,
    message: message.slice(0, 600),
    detail,
    source: context.source || input?.source || input?.origin || '',
    runtime: context.runtime || input?.runtime || '',
    phase: context.phase || input?.phase || '',
    recoverable: Boolean(info.recoverable),
    recoveryAction: info.recoveryAction,
    userAction: info.userAction,
  };
}

export function isRuntimeSessionReplayError(input) {
  const error = input?.code && input?.recoveryAction ? input : classifyRuntimeError(input);
  return error.code === 'session_replay_rejected' && error.recoveryAction === 'start_new_session';
}

export function runtimeActivityWithStructuredError(activity = {}, errorInput = '', context = {}) {
  const runtimeError = classifyRuntimeError(errorInput || activity, {
    source: context.source || activity?.source || '',
    runtime: context.runtime || activity?.runtime || '',
    phase: context.phase || activity?.phase || '',
  });
  return {
    ...(activity && typeof activity === 'object' && !Array.isArray(activity) ? activity : {}),
    source: activity?.source || context.source || 'runtime-error',
    error: runtimeError.detail || runtimeError.message,
    errorCode: runtimeError.code,
    errorTitle: runtimeError.title,
    errorDetail: runtimeError.detail,
    recoverable: runtimeError.recoverable,
    recoveryAction: runtimeError.recoveryAction,
    userAction: runtimeError.userAction,
    runtimeError,
  };
}
