// Shared-state bus helpers for the host's conditional-module-visibility
// feature. Pure module — no React, no SDK access — so it is unit-testable
// and importable by the editor-facing deriveProvidedKeys export without
// dragging in the component tree.

/** Must match "id" in manifest.json — the host force-prefixes published
 *  keys with `plugin:<id>:`, and deriveProvidedKeys reproduces that prefix
 *  so the editor's key picker matches what actually lands on the bus. */
export const PLUGIN_ID = 'home-assistant';

// The host validates full bus keys against this pattern and silently drops
// anything else (publishState returns void, no error surface). Mirrored here
// so the picker never advertises a key the publish path can't land.
const HOST_KEY_RE = /^[a-z0-9_:.-]{1,128}$/;

/** Full bus key for an entity, exactly as the host prefixes it. */
export function providedKey(entityId: string): string {
  return `plugin:${PLUGIN_ID}:${entityId}`;
}

/** True when the entity id yields a host-accepted bus key. Canonical HA ids
 *  (lowercase `domain.object_id`) always pass; overlong (the prefix leaves
 *  106 of the 128 chars for the id) or malformed config entries don't, and
 *  are skipped by both the picker and the publish loop so the two never
 *  disagree about which keys exist. */
export function isPublishableEntityId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && HOST_KEY_RE.test(providedKey(id));
}

/** Advertises an instance's shared-state keys to the host editor (condition
 *  key picker + the "Run hidden in the background" toggle). Called by the
 *  host with the instance's raw config — must be pure and defensive: the
 *  editor may call it with partial/legacy configs. */
export function deriveProvidedKeys(
  config: Record<string, unknown>,
): { key: string; label: string }[] {
  const entities = Array.isArray(config?.entities) ? (config.entities as unknown[]) : [];
  return entities
    .filter(isPublishableEntityId)
    .map((id) => ({ key: providedKey(id), label: id }));
}

// ── Cross-instance clear arbitration ───────────────────────────────────────
//
// The bus keyspace is global, and the README's recommended setup (a hidden
// background provider plus a visible widget) makes overlapping entity lists
// across instances the NORMAL configuration. One IIFE bundle serves every
// instance on the page, so this module-level refcount lets an instance ask
// "does anyone else still configure this entity?" before clearing its key —
// otherwise removing an entity from one instance would wipe a key a sibling
// still publishes, hiding gated modules until the sibling's next poll.

const configuredCounts = new Map<string, number>();

/** Register an instance's configured entities. Returns a release function
 *  for the effect cleanup. Counts rather than a set, so two instances with
 *  the same entity stack correctly; release is idempotent because React
 *  guarantees at most one cleanup call but defensive code is cheap. */
export function retainEntities(ids: readonly string[]): () => void {
  for (const id of ids) configuredCounts.set(id, (configuredCounts.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const n = configuredCounts.get(id) ?? 0;
      if (n <= 1) configuredCounts.delete(id);
      else configuredCounts.set(id, n - 1);
    }
  };
}

/** True while any live instance on this page configures the entity. */
export function isEntityConfigured(id: string): boolean {
  return (configuredCounts.get(id) ?? 0) > 0;
}
