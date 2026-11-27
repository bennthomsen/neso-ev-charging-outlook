import { runTests } from "./cases.js";
const results = await runTests(console.log);
const failures = results.filter((result) => !result.passed);
console.log(`${results.length - failures.length}/${results.length} tests passed`);
if (failures.length) process.exitCode = 1;
