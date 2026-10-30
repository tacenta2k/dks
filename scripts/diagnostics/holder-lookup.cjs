'use strict';

/**
 * Print who holds a file open — on demand, from any workflow step.
 *
 *   node scripts/diagnostics/holder-lookup.cjs release/win-unpacked/DKS.exe
 *
 * Exit codes: 0 = an answer was produced (including "nobody holds it"),
 * 1 = the lookup itself could not run (reported, never silent).
 */

const { existsSync } = require('node:fs');
const path = require('node:path');

const { findFileHolders, formatHolders } = require('../lib/file-holders.cjs');

async function main(argv) {
  const target = argv[0];
  if (!target) {
    console.error('usage: node scripts/diagnostics/holder-lookup.cjs <path>');
    return 2;
  }
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    console.log(`[holders] ${resolved} does not exist`);
    return 0;
  }

  const report = await findFileHolders(resolved, {
    log: (line) => console.log(line),
  });
  if (!report.supported) {
    console.log(`[holders] lookup unavailable: ${report.reason}`);
    return 1;
  }
  console.log(formatHolders(resolved, report.holders));
  if (report.output && report.holders.length === 0) {
    // The raw output is kept when it is short: it distinguishes "the API said
    // zero holders" from "the script printed nothing at all".
    console.log(`[holders] raw: ${report.output.trim().split(/\r?\n/).slice(-3).join(' / ')}`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[holders] failed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
