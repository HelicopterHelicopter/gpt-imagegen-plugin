#!/usr/bin/env node
'use strict';

const { run, safeRun } = require('../src/cli');

// A trivial entry point: all logic lives in src/cli.js so it is testable
// without spawning a process. process.exitCode (not process.exit) is set so
// stdout has a chance to flush before the process exits naturally.
safeRun(() => run(process.argv.slice(2), process.stdout, process.stderr), process.stdout, process.stderr).then(
  (code) => {
    process.exitCode = code;
  }
);
