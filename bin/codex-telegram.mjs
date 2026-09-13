#!/usr/bin/env node
import { main } from '../src/cli.ts';
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Не удалось выполнить команду.');
  process.exitCode = 1;
});
