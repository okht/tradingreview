import { validateResult } from '../../server/contracts.js';
import { cases, context } from './cases.mjs';
const results = cases.map(item => {
  let accepted = false, error = null;
  try { validateResult('review', item.candidate, item.context || context); accepted = true; } catch (cause) { error = cause.message; }
  return { id: item.id, expected: item.good ? 'accept' : 'reject', actual: accepted ? 'accept' : 'reject', passed: accepted === item.good, error };
});
const report = { kind: 'deterministic-contract-challenge', modelQualityEvaluation: false, total: results.length, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, results };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
