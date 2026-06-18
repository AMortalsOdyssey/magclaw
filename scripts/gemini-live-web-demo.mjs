#!/usr/bin/env node
import { runGeminiLiveDemoCli } from '../server/gemini-live-demo.js';

runGeminiLiveDemoCli(process.argv.slice(2)).catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
