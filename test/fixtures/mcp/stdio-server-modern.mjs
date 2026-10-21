// `stdio-server.mjs` on the stateless protocol (2.x SDK); see test/helpers/generation.ts.
process.env.MOCK_PROTOCOL = 'modern';
await import('./stdio-server.mjs');
