// Preloaded (`node --import`) into the daemons the test harness starts: appends this process's id
// to VIA_TEST_PID_LOG, so teardown can end every daemon a sandbox started even when `via daemon
// status` cannot reach it (a test broke the token, a killed daemon's pipe is going away).
import { appendFileSync } from 'node:fs';

const log = process.env.VIA_TEST_PID_LOG;
if (log) appendFileSync(log, `${process.pid}\n`);
