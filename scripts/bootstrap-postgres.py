#!/usr/bin/env python3
"""Bootstrap or inspect the MagClaw PostgreSQL schema from a Python-only host.

The production jump host used for MagClaw does not always have psql, Node.js, or
Python PostgreSQL drivers installed. This script intentionally uses only the
Python standard library and talks to PostgreSQL using the wire protocol.
"""
import argparse
import base64
import getpass
import gzip
import hashlib
import hmac
import os
import secrets
import socket
import ssl
import struct
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse
MIGRATION_ID = '20260506_cloud_base'
DEFAULT_DATABASE = 'magclaw_cloud'
DEFAULT_SCHEMA = 'magclaw'
DEFAULT_MAINTENANCE_DATABASE = 'postgres'
DEFAULT_PORT = 5432
DEFAULT_CONNECT_TIMEOUT_SECONDS = 10
DEFAULT_LOCK_TIMEOUT_MS = 10000
DEFAULT_STATEMENT_TIMEOUT_MS = 120000
DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30000
DEFAULT_STARTUP_LOCK_TIMEOUT_MS = 30000
EXPECTED_CLOUD_TABLES = ('cloud_agent_deliveries', 'cloud_agents', 'cloud_attachments', 'cloud_audit_logs', 'cloud_auth_accounts', 'cloud_channels', 'cloud_computer_tokens', 'cloud_computers', 'cloud_daemon_events', 'cloud_dms', 'cloud_humans', 'cloud_invitations', 'cloud_join_links', 'cloud_messages', 'cloud_pairing_tokens', 'cloud_password_resets', 'cloud_release_notes', 'cloud_replies', 'cloud_sessions', 'cloud_state_records', 'cloud_tasks', 'cloud_users', 'cloud_work_items', 'cloud_workspace_members', 'cloud_workspaces')
EMBEDDED_SCHEMA_GZIP_B64 = '''
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
7RE8uSZYLn2/0ApETFL/B7Pz3RMAXAAA
'''

class PgError(RuntimeError):

    def __init__(self, message, fields=None):
        super().__init__(message)
        self.fields = fields or {}

class PgResult:

    def __init__(self, rows=None, result_sets=None, command_tags=None):
        self.rows = rows if rows is not None else []
        self.result_sets = result_sets if result_sets is not None else []
        self.command_tags = command_tags if command_tags is not None else []

class ConnectionOptions:

    def __init__(self, host, port, user, password, database, sslmode, connect_timeout, application_name):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.database = database
        self.sslmode = sslmode
        self.connect_timeout = connect_timeout
        self.application_name = application_name

def recv_exact(sock, size):
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise PgError('connection closed by PostgreSQL server')
        chunks.extend(chunk)
    return bytes(chunks)

def cstring(value):
    return value.encode('utf-8') + b'\x00'

def parse_error_fields(payload):
    fields = {}
    index = 0
    while index < len(payload) and payload[index] != 0:
        code = chr(payload[index])
        index += 1
        end = payload.find(b'\x00', index)
        if end == -1:
            break
        fields[code] = payload[index:end].decode('utf-8', 'replace')
        index = end + 1
    return fields

def error_message(payload):
    fields = parse_error_fields(payload)
    severity = fields.get('S') or fields.get('V') or 'ERROR'
    message = fields.get('M') or 'PostgreSQL error'
    code = fields.get('C')
    detail = fields.get('D')
    hint = fields.get('H')
    pieces = [f'{severity}: {message}']
    if code:
        pieces.append(f'SQLSTATE={code}')
    if detail:
        pieces.append(f'detail={detail}')
    if hint:
        pieces.append(f'hint={hint}')
    return '; '.join(pieces)

def sasl_pairs(value):
    pairs = {}
    for part in value.split(','):
        if '=' in part:
            key, raw = part.split('=', 1)
            pairs[key] = raw
    return pairs

def hi(password, salt, iterations):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)

def xor_bytes(left, right):
    return bytes((a ^ b for a, b in zip(left, right)))

class PgWireClient:

    def __init__(self, options):
        self.options = options
        self.sock = None
        self._scram_server_signature = None

    def connect(self):
        raw = socket.create_connection((self.options.host, self.options.port), timeout=self.options.connect_timeout)
        raw.settimeout(self.options.connect_timeout)
        self.sock = self._maybe_start_tls(raw)
        self._send_startup()
        self._read_startup_messages()

    def close(self):
        if not self.sock:
            return
        try:
            self.sock.sendall(b'X' + struct.pack('!I', 4))
        except OSError:
            pass
        try:
            self.sock.close()
        finally:
            self.sock = None

    def _maybe_start_tls(self, raw):
        sslmode = self.options.sslmode
        if sslmode == 'disable':
            return raw
        request = struct.pack('!II', 8, 80877103)
        raw.sendall(request)
        response = recv_exact(raw, 1)
        if response == b'S':
            context = ssl.create_default_context()
            if sslmode == 'allow-invalid':
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            return context.wrap_socket(raw, server_hostname=self.options.host)
        if response == b'N':
            if sslmode == 'require':
                raw.close()
                raise PgError('PostgreSQL server does not support TLS, but --sslmode=require was requested')
            return raw
        raw.close()
        raise PgError(f'unexpected SSL negotiation response: {response!r}')

    def _send_startup(self):
        assert self.sock is not None
        params = {'user': self.options.user, 'database': self.options.database, 'application_name': self.options.application_name, 'client_encoding': 'UTF8'}
        body = struct.pack('!I', 196608)
        for key, value in params.items():
            body += cstring(key) + cstring(value)
        body += b'\x00'
        self.sock.sendall(struct.pack('!I', len(body) + 4) + body)

    def _send_password_message(self, password):
        self._send_message(b'p', cstring(password))

    def _send_message(self, tag, payload):
        assert self.sock is not None
        self.sock.sendall(tag + struct.pack('!I', len(payload) + 4) + payload)

    def _read_message(self):
        assert self.sock is not None
        tag = recv_exact(self.sock, 1)
        length = struct.unpack('!I', recv_exact(self.sock, 4))[0]
        if length < 4:
            raise PgError(f'invalid PostgreSQL message length: {length}')
        return (tag, recv_exact(self.sock, length - 4))

    def _read_startup_messages(self):
        while True:
            tag, payload = self._read_message()
            if tag == b'R':
                self._handle_authentication(payload)
            elif tag == b'E':
                raise PgError(error_message(payload), parse_error_fields(payload))
            elif tag in {b'S', b'K', b'N'}:
                continue
            elif tag == b'Z':
                return
            else:
                raise PgError(f'unexpected startup message from PostgreSQL: {tag!r}')

    def _handle_authentication(self, payload):
        auth_type = struct.unpack('!I', payload[:4])[0]
        if auth_type == 0:
            if self._scram_server_signature is not None:
                self._scram_server_signature = None
            return
        if auth_type == 3:
            self._send_password_message(self.options.password)
            return
        if auth_type == 5:
            salt = payload[4:8]
            inner = hashlib.md5((self.options.password + self.options.user).encode('utf-8')).hexdigest()
            outer = hashlib.md5(inner.encode('ascii') + salt).hexdigest()
            self._send_password_message('md5' + outer)
            return
        if auth_type == 10:
            mechanisms = payload[4:].rstrip(b'\x00').split(b'\x00')
            if b'SCRAM-SHA-256' not in mechanisms:
                raise PgError(f'unsupported SASL mechanisms: {mechanisms!r}')
            self._start_scram()
            return
        if auth_type == 11:
            self._continue_scram(payload[4:].decode('utf-8'))
            return
        if auth_type == 12:
            final = payload[4:].decode('utf-8')
            fields = sasl_pairs(final)
            verifier = base64.b64decode(fields.get('v', ''))
            if self._scram_server_signature is not None and (not hmac.compare_digest(verifier, self._scram_server_signature)):
                raise PgError('SCRAM server signature verification failed')
            return
        raise PgError(f'unsupported PostgreSQL authentication request: {auth_type}')

    def _start_scram(self):
        self._scram_nonce = base64.b64encode(secrets.token_bytes(18)).decode('ascii')
        self._scram_client_first_bare = f'n={self.options.user},r={self._scram_nonce}'
        initial = f'n,,{self._scram_client_first_bare}'.encode('utf-8')
        payload = cstring('SCRAM-SHA-256') + struct.pack('!I', len(initial)) + initial
        self._send_message(b'p', payload)

    def _continue_scram(self, server_first):
        fields = sasl_pairs(server_first)
        nonce = fields.get('r', '')
        if not nonce.startswith(self._scram_nonce):
            raise PgError('SCRAM server nonce does not extend client nonce')
        salt = base64.b64decode(fields.get('s', ''))
        iterations = int(fields.get('i', '0'))
        if iterations <= 0:
            raise PgError('SCRAM server sent invalid iteration count')
        client_final_without_proof = f'c=biws,r={nonce}'
        auth_message = ','.join([self._scram_client_first_bare, server_first, client_final_without_proof])
        salted = hi(self.options.password, salt, iterations)
        client_key = hmac.new(salted, b'Client Key', hashlib.sha256).digest()
        stored_key = hashlib.sha256(client_key).digest()
        client_signature = hmac.new(stored_key, auth_message.encode('utf-8'), hashlib.sha256).digest()
        proof = xor_bytes(client_key, client_signature)
        server_key = hmac.new(salted, b'Server Key', hashlib.sha256).digest()
        self._scram_server_signature = hmac.new(server_key, auth_message.encode('utf-8'), hashlib.sha256).digest()
        final = f"{client_final_without_proof},p={base64.b64encode(proof).decode('ascii')}"
        self._send_message(b'p', final.encode('utf-8'))

    def execute(self, sql):
        self._send_message(b'Q', sql.encode('utf-8') + b'\x00')
        fields = []
        current_rows = None
        result_sets = []
        command_tags = []
        while True:
            tag, payload = self._read_message()
            if tag == b'T':
                fields = self._parse_row_description(payload)
                current_rows = []
                result_sets.append(current_rows)
            elif tag == b'D':
                if current_rows is None:
                    current_rows = []
                    result_sets.append(current_rows)
                current_rows.append(self._parse_data_row(payload, fields))
            elif tag == b'C':
                command_tags.append(payload.rstrip(b'\x00').decode('utf-8', 'replace'))
            elif tag == b'E':
                raise PgError(error_message(payload), parse_error_fields(payload))
            elif tag == b'N':
                continue
            elif tag == b'Z':
                rows = result_sets[-1] if result_sets else []
                return PgResult(rows=rows, result_sets=result_sets, command_tags=command_tags)

    @staticmethod
    def _parse_row_description(payload):
        count = struct.unpack('!H', payload[:2])[0]
        index = 2
        fields = []
        for _ in range(count):
            end = payload.find(b'\x00', index)
            name = payload[index:end].decode('utf-8', 'replace')
            fields.append(name)
            index = end + 1 + 18
        return fields

    @staticmethod
    def _parse_data_row(payload, fields):
        count = struct.unpack('!H', payload[:2])[0]
        index = 2
        row = {}
        for column in range(count):
            length = struct.unpack('!i', payload[index:index + 4])[0]
            index += 4
            if length == -1:
                value = None
            else:
                value = payload[index:index + length].decode('utf-8', 'replace')
                index += length
            name = fields[column] if column < len(fields) else f'column_{column + 1}'
            row[name] = value
        return row

def validate_identifier(value, label):
    name = str(value or '').strip()
    if not name:
        raise SystemExit(f'{label} is required')
    if len(name) > 63:
        raise SystemExit(f'{label} must be 63 characters or fewer')
    if not (name[0].isalpha() or name[0] == '_'):
        raise SystemExit(f'{label} must start with a letter or underscore')
    allowed = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_')
    if any((char not in allowed for char in name)):
        raise SystemExit(f'{label} must contain only letters, numbers, and underscores')
    return name

def quote_ident(value):
    return '"' + validate_identifier(value, 'identifier').replace('"', '""') + '"'

def quote_literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def normalize_database_url(value):
    return (value or '').strip().replace('postgresql+asyncpg://', 'postgresql://', 1).replace('postgres+asyncpg://', 'postgres://', 1)

def redact_url(value):
    normalized = normalize_database_url(value)
    if not normalized:
        return ''
    parsed = urlparse(normalized)
    if not parsed.password:
        return normalized
    auth = parsed.username or ''
    if parsed.hostname:
        auth += ':***@' + parsed.hostname
    redacted = parsed._replace(netloc=auth + (f':{parsed.port}' if parsed.port else ''))
    return redacted.geturl()

def parse_database_url(value):
    normalized = normalize_database_url(value)
    if not normalized:
        return {}
    parsed = urlparse(normalized)
    if parsed.scheme not in {'postgres', 'postgresql'}:
        raise SystemExit(f'unsupported database URL scheme: {parsed.scheme}')
    result = {}
    if parsed.hostname:
        result['host'] = parsed.hostname
    if parsed.port:
        result['port'] = parsed.port
    if parsed.username:
        result['user'] = unquote(parsed.username)
    if parsed.password:
        result['password'] = unquote(parsed.password)
    database = unquote(parsed.path.lstrip('/').split('/', 1)[0])
    if database:
        result['database'] = database
    return result

def schema_file_candidates(explicit):
    if explicit:
        yield Path(explicit)
        return
    script_dir = Path(__file__).resolve().parent
    yield (script_dir.parent / 'server' / 'cloud' / 'postgres-schema.sql')
    yield (Path.cwd() / 'server' / 'cloud' / 'postgres-schema.sql')
    yield (Path.cwd() / 'postgres-schema.sql')

def load_schema_sql(explicit):
    for path in schema_file_candidates(explicit):
        if path.exists():
            return (path.read_text(encoding='utf-8'), path)
    if explicit:
        raise SystemExit(f'Cannot find schema file: {explicit}')
    embedded = gzip.decompress(base64.b64decode(EMBEDDED_SCHEMA_GZIP_B64)).decode('utf-8')
    return (embedded, Path('<embedded:server/cloud/postgres-schema.sql>'))

def schema_checksum(sql):
    return hashlib.sha256(sql.encode('utf-8')).hexdigest()

def advisory_lock_key(scope, database, schema):
    digest = hashlib.sha256(f'magclaw:{scope}:{database}:{schema}'.encode('utf-8')).digest()
    return (int.from_bytes(digest[0:4], 'big', signed=True), int.from_bytes(digest[4:8], 'big', signed=True))

def connect(options):
    client = PgWireClient(options)
    client.connect()
    return client

def with_database(options, database):
    return ConnectionOptions(host=options.host, port=options.port, user=options.user, password=options.password, database=database, sslmode=options.sslmode, connect_timeout=options.connect_timeout, application_name=options.application_name)

def set_session_defaults(client, application_name, args):
    client.execute(f"SELECT set_config('application_name', {quote_literal(application_name)}, false), set_config('lock_timeout', {quote_literal(str(args.lock_timeout_ms) + 'ms')}, false), set_config('statement_timeout', {quote_literal(str(args.statement_timeout_ms) + 'ms')}, false), set_config('idle_in_transaction_session_timeout', {quote_literal(str(args.idle_in_transaction_timeout_ms) + 'ms')}, false)")

def ensure_database(base_options, args):
    if not args.create_database or args.dry_run:
        return {'created': False, 'exists': None}
    maintenance = connect(with_database(base_options, args.maintenance_database))
    try:
        set_session_defaults(maintenance, 'magclaw-python-maintenance', args)
        result = maintenance.execute(f'SELECT 1 AS exists FROM pg_database WHERE datname = {quote_literal(args.database)}')
        if result.rows:
            return {'created': False, 'exists': True}
        maintenance.execute(f'CREATE DATABASE {quote_ident(args.database)}')
        return {'created': True, 'exists': False}
    finally:
        maintenance.close()

def acquire_lock(client, database, schema, timeout_ms):
    left, right = advisory_lock_key('migration', database, schema)
    deadline = time.monotonic() + timeout_ms / 1000
    logged = False
    while True:
        result = client.execute(f'SELECT pg_try_advisory_lock({left}::int, {right}::int) AS locked')
        locked = str(result.rows[0].get('locked', '')).lower() in {'t', 'true', '1'}
        if locked:
            if logged:
                print('[magclaw-pg] acquired migration advisory lock')
            return (left, right)
        if not logged:
            print('[magclaw-pg] waiting for migration advisory lock...', file=sys.stderr)
            logged = True
        if time.monotonic() >= deadline:
            raise PgError(f'timed out waiting for migration advisory lock after {timeout_ms}ms')
        time.sleep(0.25)

def release_lock(client, lock_key):
    left, right = lock_key
    client.execute(f'SELECT pg_advisory_unlock({left}::int, {right}::int) AS unlocked')

def existing_migration(client, schema):
    result = client.execute(f'SELECT id, checksum, applied_at FROM {quote_ident(schema)}.magclaw_migrations WHERE id = {quote_literal(MIGRATION_ID)}')
    return result.rows[0] if result.rows else None

def apply_schema(args, options, schema_sql):
    database_result = ensure_database(options, args)
    checksum = schema_checksum(schema_sql)
    client = connect(with_database(options, args.database))
    lock_key = None
    checksum_changed = False
    try:
        set_session_defaults(client, 'magclaw-python-migration', args)
        lock_key = acquire_lock(client, args.database, args.schema, args.startup_lock_timeout_ms)
        if args.dry_run:
            status = schema_status(args, options, client=client)
            previous = status.get('migration')
            checksum_changed = bool(isinstance(previous, dict) and previous.get('checksum') and (previous.get('checksum') != checksum))
            return {'ok': True, 'dryRun': True, 'database': args.database, 'schema': args.schema, 'migrationId': MIGRATION_ID, 'checksum': checksum, 'checksumChanged': checksum_changed, 'databaseCreated': database_result['created'], 'cloudTableCount': status['cloudTableCount'], 'missingCloudTables': status['missingCloudTables']}
        client.execute(f'CREATE SCHEMA IF NOT EXISTS {quote_ident(args.schema)}')
        client.execute(f'CREATE TABLE IF NOT EXISTS {quote_ident(args.schema)}.magclaw_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
        previous = existing_migration(client, args.schema)
        checksum_changed = bool(previous and previous.get('checksum') != checksum)
        client.execute('BEGIN')
        try:
            client.execute(f"SELECT set_config('lock_timeout', {quote_literal(str(args.lock_timeout_ms) + 'ms')}, true), set_config('statement_timeout', {quote_literal(str(args.statement_timeout_ms) + 'ms')}, true), set_config('idle_in_transaction_session_timeout', {quote_literal(str(args.idle_in_transaction_timeout_ms) + 'ms')}, true)")
            client.execute(f'SET LOCAL search_path TO {quote_ident(args.schema)}, public')
            client.execute(schema_sql)
            client.execute(f'INSERT INTO {quote_ident(args.schema)}.magclaw_migrations (id, checksum) VALUES ({quote_literal(MIGRATION_ID)}, {quote_literal(checksum)}) ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum')
            client.execute('COMMIT')
        except Exception:
            try:
                client.execute('ROLLBACK')
            finally:
                raise
        status = schema_status(args, options, client=client)
        return {'ok': True, 'dryRun': False, 'database': args.database, 'schema': args.schema, 'migrationId': MIGRATION_ID, 'checksum': checksum, 'checksumChanged': checksum_changed, 'databaseCreated': database_result['created'], 'cloudTableCount': status['cloudTableCount'], 'missingCloudTables': status['missingCloudTables']}
    finally:
        if lock_key is not None:
            try:
                release_lock(client, lock_key)
            except Exception as error:
                print(f'[magclaw-pg] warning: failed to release advisory lock: {error}', file=sys.stderr)
        client.close()

def database_health(args, options):
    client = connect(with_database(options, args.database))
    try:
        set_session_defaults(client, 'magclaw-python-health', args)
        identity = client.execute('SELECT current_database() AS database, current_user AS user, inet_server_addr() AS server_addr, inet_server_port() AS server_port, now() AS checked_at').rows[0]
        activity = client.execute("SELECT COUNT(*) AS sessions, COUNT(*) FILTER (WHERE state = 'active') AS active_sessions, COUNT(*) FILTER (WHERE wait_event_type IS NOT NULL) AS waiting_sessions FROM pg_stat_activity WHERE datname = current_database()").rows[0]
        locks = client.execute('SELECT COUNT(*) AS locks, COUNT(*) FILTER (WHERE NOT granted) AS waiting_locks FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())').rows[0]
        return {'ok': True, 'database': identity.get('database'), 'user': identity.get('user'), 'server': f"{identity.get('server_addr')}:{identity.get('server_port')}", 'checkedAt': identity.get('checked_at'), 'sessions': activity.get('sessions'), 'activeSessions': activity.get('active_sessions'), 'waitingSessions': activity.get('waiting_sessions'), 'locks': locks.get('locks'), 'waitingLocks': locks.get('waiting_locks')}
    finally:
        client.close()

def schema_status(args, options, client=None):
    close_client = False
    if client is None:
        client = connect(with_database(options, args.database))
        close_client = True
    try:
        set_session_defaults(client, 'magclaw-python-status', args)
        tables = client.execute(f"SELECT table_name FROM information_schema.tables WHERE table_schema = {quote_literal(args.schema)} AND (table_name LIKE 'cloud_%' OR table_name = 'magclaw_migrations') ORDER BY table_name").rows
        table_names = [str(row['table_name']) for row in tables]
        migration = []
        if 'magclaw_migrations' in table_names:
            migration = client.execute(f'SELECT id, checksum, applied_at FROM {quote_ident(args.schema)}.magclaw_migrations WHERE id = {quote_literal(MIGRATION_ID)}').rows
        missing = sorted(set(EXPECTED_CLOUD_TABLES) - set(table_names))
        return {'ok': True, 'database': args.database, 'schema': args.schema, 'cloudTableCount': len([name for name in table_names if name.startswith('cloud_')]), 'tables': table_names, 'missingCloudTables': missing, 'migration': migration[0] if migration else None}
    finally:
        if close_client:
            client.close()

def print_result(result):
    for key, value in result.items():
        if key == 'tables' and isinstance(value, list):
            print(f'{key}:')
            for item in value:
                print(f'  - {item}')
        elif key == 'missingCloudTables' and isinstance(value, list):
            if value:
                print(f'{key}:')
                for item in value:
                    print(f'  - {item}')
            else:
                print(f'{key}: []')
        else:
            print(f'{key}: {value}')

def build_parser():
    parser = argparse.ArgumentParser(description='Apply or inspect the MagClaw PostgreSQL schema with Python stdlib only.')
    parser.add_argument('command', choices=['migrate', 'status', 'health', 'schema-summary'], nargs='?', default='migrate')
    parser.add_argument('--database-url', default=os.environ.get('MAGCLAW_DATABASE_URL', ''))
    parser.add_argument('--host', default=os.environ.get('PGHOST', ''))
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--user', default=os.environ.get('PGUSER', ''))
    parser.add_argument('--database', default=os.environ.get('MAGCLAW_DATABASE') or os.environ.get('PGDATABASE') or '')
    parser.add_argument('--schema', default=os.environ.get('MAGCLAW_DATABASE_SCHEMA', DEFAULT_SCHEMA))
    parser.add_argument('--maintenance-database', default=os.environ.get('MAGCLAW_MAINTENANCE_DATABASE', DEFAULT_MAINTENANCE_DATABASE))
    parser.add_argument('--schema-file', default='')
    parser.add_argument('--sslmode', choices=['disable', 'prefer', 'require', 'allow-invalid'], default=os.environ.get('PGSSLMODE', 'prefer'))
    parser.add_argument('--create-database', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--connect-timeout', type=int, default=int(os.environ.get('MAGCLAW_DATABASE_CONNECT_TIMEOUT_SECONDS', DEFAULT_CONNECT_TIMEOUT_SECONDS)))
    parser.add_argument('--lock-timeout-ms', type=int, default=int(os.environ.get('MAGCLAW_DATABASE_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS)))
    parser.add_argument('--statement-timeout-ms', type=int, default=int(os.environ.get('MAGCLAW_DATABASE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS)))
    parser.add_argument('--idle-in-transaction-timeout-ms', type=int, default=int(os.environ.get('MAGCLAW_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS)))
    parser.add_argument('--startup-lock-timeout-ms', type=int, default=int(os.environ.get('MAGCLAW_DATABASE_STARTUP_LOCK_TIMEOUT_MS', DEFAULT_STARTUP_LOCK_TIMEOUT_MS)))
    return parser

def options_from_args(args):
    url_options = parse_database_url(args.database_url)
    args.host = args.host or str(url_options.get('host', ''))
    args.port = args.port or int(url_options.get('port') or os.environ.get('PGPORT') or DEFAULT_PORT)
    args.user = args.user or str(url_options.get('user', ''))
    args.database = args.database or str(url_options.get('database', DEFAULT_DATABASE))
    password = os.environ.get('PGPASSWORD', '') or str(url_options.get('password', ''))
    args.database = validate_identifier(args.database or DEFAULT_DATABASE, 'database')
    args.schema = validate_identifier(args.schema or DEFAULT_SCHEMA, 'schema')
    args.maintenance_database = validate_identifier(args.maintenance_database, 'maintenance database')
    if not args.host:
        raise SystemExit('--host or --database-url is required')
    if not args.user:
        raise SystemExit('--user or --database-url is required')
    if not password and args.command != 'schema-summary':
        password = getpass.getpass('PostgreSQL password: ')
    return ConnectionOptions(host=args.host, port=args.port, user=args.user, password=password, database=args.database, sslmode=args.sslmode, connect_timeout=args.connect_timeout, application_name='magclaw-python-bootstrap')

def schema_summary(args):
    schema_sql, schema_path = load_schema_sql(args.schema_file or None)
    table_count = schema_sql.count('CREATE TABLE IF NOT EXISTS cloud_')
    return {'schemaFile': str(schema_path), 'migrationId': MIGRATION_ID, 'checksum': schema_checksum(schema_sql), 'expectedCloudTableCount': len(EXPECTED_CLOUD_TABLES), 'createTableStatements': table_count}

def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == 'schema-summary':
        print_result(schema_summary(args))
        return 0
    schema_sql, schema_path = load_schema_sql(args.schema_file or None)
    options = options_from_args(args)
    if args.database_url:
        print(f'databaseUrl: {redact_url(args.database_url)}')
    print(f'host: {args.host}:{args.port}')
    print(f'database: {args.database}')
    print(f'schema: {args.schema}')
    print(f'schemaFile: {schema_path}')
    print(f'schemaChecksum: {schema_checksum(schema_sql)}')
    if args.command == 'status':
        print_result(schema_status(args, options))
        return 0
    if args.command == 'health':
        print_result(database_health(args, options))
        return 0
    print_result(apply_schema(args, options, schema_sql))
    return 0
if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except PgError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
