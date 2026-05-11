-- MagClaw Cloud PostgreSQL schema v1.
--
-- When MAGCLAW_DATABASE_URL is configured, MagClaw uses this
-- schema for cloud auth and relay control-plane persistence: users, workspace
-- memberships, invitations, browser sessions, computers, daemon tokens, and
-- queued remote agent deliveries. Collaboration tables remain production-shaped
-- targets for the next cloud repository migrations.

CREATE TABLE IF NOT EXISTS cloud_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  avatar_url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cloud_users
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

DROP INDEX IF EXISTS cloud_users_normalized_email_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS cloud_users_active_normalized_email_uidx
  ON cloud_users(normalized_email)
  WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_users_created_at_idx
  ON cloud_users(created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_auth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL DEFAULT '',
  refresh_token_hash TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_auth_accounts_provider_uidx
  ON cloud_auth_accounts(provider, provider_account_id);

CREATE TABLE IF NOT EXISTS cloud_workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  onboarding_agent_id TEXT NOT NULL DEFAULT '',
  new_agent_greeting_enabled BOOLEAN NOT NULL DEFAULT true,
  owner_user_id TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cloud_workspaces
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES cloud_users(id) ON DELETE SET NULL;
ALTER TABLE cloud_workspaces
  ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE cloud_workspaces
  ADD COLUMN IF NOT EXISTS onboarding_agent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE cloud_workspaces
  ADD COLUMN IF NOT EXISTS new_agent_greeting_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cloud_workspaces
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS cloud_workspaces_slug_uidx
  ON cloud_workspaces(slug);

CREATE TABLE IF NOT EXISTS cloud_workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  human_id TEXT,
  role TEXT NOT NULL CHECK (
    role IN ('member', 'admin')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('invited', 'active', 'disabled', 'removed')
  ),
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_workspace_members_workspace_user_uidx
  ON cloud_workspace_members(workspace_id, user_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_workspace_members_user_idx
  ON cloud_workspace_members(user_id);

CREATE INDEX IF NOT EXISTS cloud_workspace_members_workspace_role_idx
  ON cloud_workspace_members(workspace_id, role);

CREATE TABLE IF NOT EXISTS cloud_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_sessions_token_hash_uidx
  ON cloud_sessions(token_hash);

CREATE INDEX IF NOT EXISTS cloud_sessions_user_active_idx
  ON cloud_sessions(user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_sessions_expires_at_idx
  ON cloud_sessions(expires_at);

CREATE TABLE IF NOT EXISTS cloud_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  human_id TEXT,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('member', 'admin')
  ),
  token_hash TEXT NOT NULL,
  invited_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cloud_workspace_members
  DROP CONSTRAINT IF EXISTS cloud_workspace_members_role_check;

ALTER TABLE cloud_invitations
  DROP CONSTRAINT IF EXISTS cloud_invitations_role_check;

ALTER TABLE cloud_invitations
  ADD COLUMN IF NOT EXISTS human_id TEXT;

ALTER TABLE cloud_invitations
  ADD COLUMN IF NOT EXISTS accepted_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL;

UPDATE cloud_workspace_members
  SET role = CASE role
    WHEN 'owner' THEN 'admin'
    WHEN 'viewer' THEN 'member'
    WHEN 'core' || '_' || 'member' THEN 'member'
    WHEN 'agent' || '_' || 'admin' THEN 'admin'
    WHEN 'computer' || '_' || 'admin' THEN 'admin'
    ELSE role
  END;

UPDATE cloud_invitations
  SET role = CASE role
    WHEN 'owner' THEN 'admin'
    WHEN 'viewer' THEN 'member'
    WHEN 'core' || '_' || 'member' THEN 'member'
    WHEN 'agent' || '_' || 'admin' THEN 'admin'
    WHEN 'computer' || '_' || 'admin' THEN 'admin'
    ELSE role
  END;

ALTER TABLE cloud_workspace_members
  ADD CONSTRAINT cloud_workspace_members_role_check
  CHECK (role IN ('member', 'admin'));

ALTER TABLE cloud_invitations
  ADD CONSTRAINT cloud_invitations_role_check
  CHECK (role IN ('member', 'admin'));

CREATE UNIQUE INDEX IF NOT EXISTS cloud_invitations_token_hash_uidx
  ON cloud_invitations(token_hash);

CREATE INDEX IF NOT EXISTS cloud_invitations_workspace_email_idx
  ON cloud_invitations(workspace_id, normalized_email, created_at DESC);

CREATE INDEX IF NOT EXISTS cloud_invitations_active_idx
  ON cloud_invitations(workspace_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_password_resets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_password_resets_token_hash_uidx
  ON cloud_password_resets(token_hash);

CREATE INDEX IF NOT EXISTS cloud_password_resets_user_active_idx
  ON cloud_password_resets(user_id, expires_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_password_resets_workspace_idx
  ON cloud_password_resets(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_join_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_join_links_workspace_created_idx
  ON cloud_join_links(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_computers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  daemon_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (
    status IN ('pairing', 'connected', 'offline', 'disabled')
  ),
  connected_via TEXT NOT NULL DEFAULT 'daemon',
  runtime_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  runtime_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  running_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  machine_fingerprint TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  daemon_connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cloud_computers
  ADD COLUMN IF NOT EXISTS runtime_details JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE cloud_computers
  ADD COLUMN IF NOT EXISTS machine_fingerprint TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS cloud_computers_workspace_status_idx
  ON cloud_computers(workspace_id, status);

CREATE INDEX IF NOT EXISTS cloud_computers_last_seen_idx
  ON cloud_computers(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS cloud_humans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'offline',
  avatar TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_humans_workspace_idx
  ON cloud_humans(workspace_id, name);

CREATE INDEX IF NOT EXISTS cloud_humans_user_idx
  ON cloud_humans(user_id);

CREATE TABLE IF NOT EXISTS cloud_computer_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  computer_id TEXT NOT NULL REFERENCES cloud_computers(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_computer_tokens_token_hash_uidx
  ON cloud_computer_tokens(token_hash);

CREATE INDEX IF NOT EXISTS cloud_computer_tokens_computer_active_idx
  ON cloud_computer_tokens(computer_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS cloud_computer_tokens_workspace_idx
  ON cloud_computer_tokens(workspace_id);

CREATE TABLE IF NOT EXISTS cloud_pairing_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  computer_id TEXT NOT NULL REFERENCES cloud_computers(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  created_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_pairing_tokens_token_hash_uidx
  ON cloud_pairing_tokens(token_hash);

CREATE INDEX IF NOT EXISTS cloud_pairing_tokens_computer_active_idx
  ON cloud_pairing_tokens(computer_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  computer_id TEXT REFERENCES cloud_computers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  handle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  runtime TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  workspace_path TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_updated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_agents_workspace_status_idx
  ON cloud_agents(workspace_id, status);

CREATE INDEX IF NOT EXISTS cloud_agents_computer_idx
  ON cloud_agents(computer_id);

CREATE TABLE IF NOT EXISTS cloud_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_channels_workspace_name_uidx
  ON cloud_channels(workspace_id, name)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_dms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  participant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_dms_workspace_idx
  ON cloud_dms(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  space_type TEXT NOT NULL CHECK (space_type IN ('channel', 'dm')),
  space_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'human', 'agent', 'system')),
  author_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentioned_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentioned_human_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_count INTEGER NOT NULL DEFAULT 0,
  saved_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  read_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_messages_space_created_idx
  ON cloud_messages(workspace_id, space_type, space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cloud_messages_author_created_idx
  ON cloud_messages(workspace_id, author_type, author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_replies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  parent_message_id TEXT NOT NULL REFERENCES cloud_messages(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'human', 'agent', 'system')),
  author_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentioned_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentioned_human_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  saved_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  read_by JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_replies_parent_created_idx
  ON cloud_replies(parent_message_id, created_at ASC);

CREATE TABLE IF NOT EXISTS cloud_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  number INTEGER,
  space_type TEXT NOT NULL CHECK (space_type IN ('channel', 'dm')),
  space_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (
    status IN ('todo', 'in_progress', 'in_review', 'done')
  ),
  created_by TEXT NOT NULL DEFAULT '',
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TIMESTAMPTZ,
  review_requested_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_message_id TEXT,
  source_reply_id TEXT,
  thread_message_id TEXT,
  assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  local_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_tasks_space_number_uidx
  ON cloud_tasks(workspace_id, space_type, space_id, number)
  WHERE number IS NOT NULL;

CREATE INDEX IF NOT EXISTS cloud_tasks_status_idx
  ON cloud_tasks(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES cloud_agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES cloud_tasks(id) ON DELETE SET NULL,
  message_id TEXT,
  parent_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  send_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS cloud_work_items_agent_status_idx
  ON cloud_work_items(agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_state_records (
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, kind, id)
);

CREATE INDEX IF NOT EXISTS cloud_state_records_kind_position_idx
  ON cloud_state_records(workspace_id, kind, position);

CREATE TABLE IF NOT EXISTS cloud_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'pvc',
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'upload',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE cloud_attachments
  ADD COLUMN IF NOT EXISTS storage_mode TEXT NOT NULL DEFAULT 'pvc';

CREATE INDEX IF NOT EXISTS cloud_attachments_workspace_created_idx
  ON cloud_attachments(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_agent_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  computer_id TEXT NOT NULL REFERENCES cloud_computers(id) ON DELETE CASCADE,
  message_id TEXT,
  work_item_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  command_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'sent', 'acked', 'failed', 'stopped')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_agent_deliveries_agent_computer_seq_uidx
  ON cloud_agent_deliveries(agent_id, computer_id, seq);

CREATE INDEX IF NOT EXISTS cloud_agent_deliveries_computer_pending_idx
  ON cloud_agent_deliveries(computer_id, status, seq)
  WHERE status IN ('queued', 'sent');

CREATE INDEX IF NOT EXISTS cloud_agent_deliveries_workspace_created_idx
  ON cloud_agent_deliveries(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_daemon_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  computer_id TEXT REFERENCES cloud_computers(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cloud_daemon_events_workspace_created_idx
  ON cloud_daemon_events(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cloud_daemon_events_computer_created_idx
  ON cloud_daemon_events(computer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_release_notes (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL CHECK (component IN ('web', 'daemon')),
  version TEXT NOT NULL,
  released_at DATE NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('features', 'fixes', 'improved')),
  body TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_release_notes_component_position_uidx
  ON cloud_release_notes(component, version, category, position);

CREATE INDEX IF NOT EXISTS cloud_release_notes_component_released_idx
  ON cloud_release_notes(component, released_at DESC, version DESC);

CREATE TABLE IF NOT EXISTS cloud_audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES cloud_workspaces(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES cloud_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cloud_audit_logs_workspace_created_idx
  ON cloud_audit_logs(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cloud_audit_logs_actor_created_idx
  ON cloud_audit_logs(actor_user_id, created_at DESC);
