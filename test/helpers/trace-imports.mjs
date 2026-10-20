// `node --import test/helpers/trace-imports.mjs <script>`: appends every import specifier that starts
// with one of the names in TRACE_IMPORTS (comma separated) to the file named by TRACE_FILE.
import { register } from 'node:module';

register(new URL('./trace-hooks.mjs', import.meta.url), import.meta.url);
