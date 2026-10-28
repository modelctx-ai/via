import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

// MCP Apps marks a tool that only the server's own UI calls with a `_meta.ui.visibility` that leaves
// out "model". It is not an agent's tool: via leaves it out of every view, of find and of calls, as
// if the server had not listed it (discovery.md, step 1; ADR 0031).

const APP_ONLY = { name: 'ui_get', description: 'Fetch a UI resource for the app', inputSchema: { type: 'object', properties: { uri: { type: 'string' } } }, _meta: { ui: { visibility: ['app'] } } };
const BOTH = { name: 'widget_show', description: 'Show a widget', inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: 'ui://fixture/widget', visibility: ['model', 'app'] } } };

async function setup() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  const listed = srv.state.tools.length;
  srv.state.tools = [...srv.state.tools, APP_ONLY, BOTH] as typeof srv.state.tools;
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb, visible: listed + 1 };
}

describe('a tool whose _meta.ui.visibility has no "model"', () => {
  it('is not counted or listed, and a tool the model may also call stays', async () => {
    const { sb, visible } = await setup();
    const root = await sb.via([]);
    expect(root.code).toBe(0);
    expect(root.stdout).toMatch(new RegExp(`^gh {2}${visible} tools$`, 'm'));
    const view = JSON.parse((await sb.via(['gh', '-o', 'json'])).stdout) as { resources: Array<{ name: string }>; tools: string[] };
    expect(view.resources.map((r) => r.name)).not.toContain('ui');
    expect(view.tools).toContain('widget-show');
  });

  it('is not found, by find or by name', async () => {
    const { srv, sb } = await setup();
    const found = await sb.via(['find', 'ui', 'resource', 'app']);
    expect(found.stdout + found.stderr).not.toContain('ui:get');
    expect(found.stdout + found.stderr).not.toContain('ui_get');
    for (const argv of [['gh', 'ui:get'], ['call', 'gh/ui_get', '--args', '{}']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(3);
      expect(r.stderr, argv.join(' ')).toMatch(/^error: no such tool: ui[_:]get\n/);
    }
    expect(srv.state.calls.map((c) => c.name)).not.toContain('ui_get');
  });
});
