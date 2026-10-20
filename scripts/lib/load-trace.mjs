// `node --import scripts/lib/load-trace.mjs dist/via.js …` with VIA_TRACE_FILE set records the
// modules the run loads (one URL per line), in load order.
import { register } from 'node:module';

register('./load-trace-hook.mjs', import.meta.url);
