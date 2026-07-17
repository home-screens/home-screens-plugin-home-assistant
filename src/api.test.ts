import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEntityRefs, fetchHistory, PLUGIN_ID } from './api';
import { HISTORY_TTL_MS } from './history';

// fetchEntityRefs is the fast lane's only upstream call and every fast-poll
// test mocks it away — these tests pin its real behavior: ref parsing into
// (entity, attribute) pairs, the state_attr()/states() template selection,
// and reassembly of the template response into {ref, value} rows.
// fetchHistory's tests pin its hand-assembled batched URL and the window
// threading into parseHistoryResponse.

const pluginFetch = vi.fn();

beforeEach(() => {
  pluginFetch.mockReset();
  vi.stubGlobal('window', { __HS_SDK__: { pluginFetch } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function templateResponse(rows: Array<{ e: string; a: string; v: unknown }>): Response {
  return new Response(JSON.stringify(rows), { status: 200 });
}

function sentTemplate(): string {
  const [, request] = pluginFetch.mock.calls[0];
  return (JSON.parse(request.payload) as { template: string }).template;
}

describe('fetchEntityRefs', () => {
  it('maps a mixed batch: state, scalar attribute, missing attribute, list attribute', async () => {
    pluginFetch.mockResolvedValue(templateResponse([
      { e: 'media_player.tv', a: '', v: 'playing' },
      { e: 'sensor.phone', a: 'battery_level', v: 84 },
      // state_attr() answers null for a vanished attribute…
      { e: 'media_player.tv', a: 'media_title', v: null },
      // …and non-scalar attributes must not publish.
      { e: 'sensor.phone', a: 'forecast', v: [{ temp: 1 }] },
    ]));
    const results = await fetchEntityRefs('http://ha:8123', [
      'media_player.tv',
      'sensor.phone:battery_level',
      'media_player.tv:media_title',
      'sensor.phone:forecast',
    ]);
    expect(results).toEqual([
      { ref: 'media_player.tv', value: 'playing' },
      { ref: 'sensor.phone:battery_level', value: '84' },
      { ref: 'media_player.tv:media_title', value: null },
      { ref: 'sensor.phone:forecast', value: null },
    ]);
  });

  it('embeds each ref as an (entity, attribute) pair and selects state_attr vs states', async () => {
    pluginFetch.mockResolvedValue(templateResponse([]));
    await fetchEntityRefs('http://ha:8123', ['media_player.tv', 'sensor.phone:battery_level']);

    const template = sentTemplate();
    // State refs carry an empty attribute slot (Jinja has no null literal);
    // attribute refs carry the attribute name verbatim.
    expect(template).toContain(JSON.stringify([
      ['media_player.tv', ''],
      ['sensor.phone', 'battery_level'],
    ]));
    // The per-item branch: attribute present → state_attr, else states.
    expect(template).toContain("state_attr(it[0], it[1]) if it[1] else states(it[0])");
    // Each value is guarded to a JSON-serializable primitive before `tojson`,
    // so a single datetime attribute can't 400 the whole batch (Fix 3).
    expect(template).toContain('(v if (v is string or v is number or v is boolean) else none)');

    const [pluginId, request] = pluginFetch.mock.calls[0];
    expect(pluginId).toBe(PLUGIN_ID);
    expect(request).toMatchObject({ url: 'http://ha:8123/api/template', method: 'POST' });
  });

  it('short-circuits an empty ref list without calling the proxy', async () => {
    expect(await fetchEntityRefs('http://ha:8123', [])).toEqual([]);
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response', async () => {
    pluginFetch.mockResolvedValue(new Response('', { status: 500 }));
    await expect(fetchEntityRefs('http://ha:8123', ['light.a']))
      .rejects.toThrow('Failed to fetch entity states: 500');
  });

  it('surfaces a non-JSON template body (Jinja error) instead of pretending success', async () => {
    pluginFetch.mockResolvedValue(new Response('TemplateSyntaxError: boom', { status: 200 }));
    await expect(fetchEntityRefs('http://ha:8123', ['light.a']))
      .rejects.toThrow('Template endpoint returned non-JSON: TemplateSyntaxError: boom');
  });

  it('rejects a JSON body that is not an array', async () => {
    pluginFetch.mockResolvedValue(new Response('{"e":"light.a"}', { status: 200 }));
    await expect(fetchEntityRefs('http://ha:8123', ['light.a']))
      .rejects.toThrow('unexpected shape');
  });
});

describe('fetchHistory', () => {
  // Fixed clock so historyWindow's quantized edges are deterministic:
  // 12:07:33 snaps to end 12:00:00, start 24h earlier.
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-07-16T12:07:33Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('short-circuits an empty id list without calling the proxy', async () => {
    expect(await fetchHistory('http://ha:8123', [])).toEqual({});
    expect(pluginFetch).not.toHaveBeenCalled();
  });

  it('assembles the batched quantized-window URL with the history TTL', async () => {
    pluginFetch.mockResolvedValue(new Response('[]', { status: 200 }));
    await fetchHistory('http://ha:8123', ['sensor.a', 'sensor.b']);

    const [pluginId, request] = pluginFetch.mock.calls[0];
    expect(pluginId).toBe(PLUGIN_ID);
    expect(request.cacheTtlMs).toBe(HISTORY_TTL_MS);
    const url = request.url as string;
    expect(url.startsWith(
      `http://ha:8123/api/history/period/${encodeURIComponent('2026-07-15T12:00:00.000Z')}`,
    )).toBe(true);
    expect(url).toContain('filter_entity_id=sensor.a,sensor.b');
    expect(url).toContain(`end_time=${encodeURIComponent('2026-07-16T12:00:00.000Z')}`);
    expect(url).toContain('minimal_response&no_attributes');
  });

  it('throws on a non-ok response', async () => {
    pluginFetch.mockResolvedValue(new Response('', { status: 500 }));
    await expect(fetchHistory('http://ha:8123', ['sensor.a']))
      .rejects.toThrow('Failed to fetch history: 500');
  });

  it('returns series keyed by entity with the window threaded through unswapped', async () => {
    // Both entries sit inside the window. Swapped start/end would make the
    // span non-positive and drop the series, so a non-empty result pins the
    // argument order into parseHistoryResponse.
    const body = [[
      { entity_id: 'sensor.a', state: '10', last_changed: '2026-07-15T13:00:00Z' },
      { state: '20', last_changed: '2026-07-16T11:00:00Z' },
    ]];
    pluginFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const out = await fetchHistory('http://ha:8123', ['sensor.a']);
    expect(Object.keys(out)).toEqual(['sensor.a']);
    expect(out['sensor.a'].min).toBe(10);
    expect(out['sensor.a'].max).toBe(20);
  });
});
