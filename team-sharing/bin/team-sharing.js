#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv).catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
});
