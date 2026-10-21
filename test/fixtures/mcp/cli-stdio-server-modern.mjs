// `cli-stdio-server.mjs` on the stateless protocol (2.x SDK); see test/helpers/generation.ts.
process.env.CLI_FIXTURE_PROTOCOL = 'modern';
await import('./cli-stdio-server.mjs');
