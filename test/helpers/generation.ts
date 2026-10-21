// Which protocol generation the fixture servers speak by default (docs/development/testing.md, "两代协议").
// The tests run against the old handshake unless `VIA_TEST_PROTOCOL=modern` is set, which CI does for a
// second pass over the end-to-end suites; a test that is about one generation says so explicitly.
import { fileURLToPath } from 'node:url';

export type Generation = 'legacy' | 'modern';

export function defaultGeneration(): Generation {
  return process.env.VIA_TEST_PROTOCOL === 'modern' ? 'modern' : 'legacy';
}

/** `test/fixtures/mcp/<name>.mjs`, or its `-modern` twin, which starts the same server on the stateless protocol. */
export function fixtureScript(name: 'stdio-server' | 'cli-stdio-server', generation: Generation): string {
  return fileURLToPath(new URL(`../fixtures/mcp/${name}${generation === 'modern' ? '-modern' : ''}.mjs`, import.meta.url));
}
