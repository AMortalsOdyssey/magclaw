#!/usr/bin/env node

process.stderr.write('magclaw-notify-daemon is deprecated; use magclaw-notify-owner instead.\n');
await import('./magclaw-notify-owner.js');
