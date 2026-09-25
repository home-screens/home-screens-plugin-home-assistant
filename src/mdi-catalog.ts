// Home Assistant's full icon catalog: every @mdi/js path keyed by its export
// name, written to dist/mdi.json at build time (vite.config.ts) and served by
// the host's plugin asset route. Only the editor loads it. Picking an icon
// saves its path on the look rule, so displays never download or parse the
// 2.7 MB catalog and the display bundle stays small.

import React from 'react';
import { PLUGIN_ID } from './api';
import { canonicalMdiRef, mdiExportName, type MdiIcon } from './icons';

/** Fetched with plain same-origin fetch, which carries the editor's session
 *  cookie. Displays sign in with a token instead, so this is editor-only. */
export const MDI_CATALOG_URL = `/api/plugins/asset/${encodeURIComponent(PLUGIN_ID)}/dist/mdi.json`;

export type MdiCatalog = Readonly<Record<string, string>>;

/** Look typed text up as a Home Assistant icon. Anything typed is read as an
 *  `mdi:` name, so `fan` finds Home Assistant's fan, never the built-in
 *  glyph of the same name. */
export function lookupMdiIcon(catalog: MdiCatalog, input: string): MdiIcon | undefined {
  const ref = canonicalMdiRef(input);
  if (!ref) return undefined;
  const key = mdiExportName(ref);
  const path = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
  return typeof path === 'string' ? { ref, path } : undefined;
}

let pending: Promise<MdiCatalog> | null = null;

/** One fetch per page, shared by every rule row. A failure clears the cache
 *  so reopening the editor tries again. */
export function loadMdiCatalog(): Promise<MdiCatalog> {
  if (!pending) {
    pending = fetch(MDI_CATALOG_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Icon catalog: HTTP ${res.status}`);
        return res.json() as Promise<MdiCatalog>;
      })
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

export type MdiCatalogState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; catalog: MdiCatalog };

export function useMdiCatalog(): MdiCatalogState {
  const [state, setState] = React.useState<MdiCatalogState>({ status: 'loading' });
  React.useEffect(() => {
    let live = true;
    loadMdiCatalog().then(
      (catalog) => { if (live) setState({ status: 'ready', catalog }); },
      () => { if (live) setState({ status: 'error' }); },
    );
    return () => { live = false; };
  }, []);
  return state;
}
