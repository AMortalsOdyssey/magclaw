#!/usr/bin/env node
import { runNotifyCli } from '../src/cli.js';

runNotifyCli(process.argv).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
