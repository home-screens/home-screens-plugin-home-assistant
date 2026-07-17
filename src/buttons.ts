// Pure model for the `buttons` view: config-row normalization, the tone
// palette, HA /api/services catalog parsing + friendly grouping for the
// editor's service picker, and small helpers shared by the view and the
// editor. No React, no fetch — everything here is unit-testable.

import type { HAButtonRow, HAButtonTone } from './types';
import { isIconName, type IconName } from './icons';

// ── Tones ───────────────────────────────────────────────────────────────────

export interface ToneColors {
  /** Icon-chip accent (icon stroke, hold sweep, dot in the tone picker). */
  accent: string;
  /** Icon-chip background tint. */
  chipBg: string;
  /** Label color while the hold sweep runs. */
  holdText: string;
}

/** Tone tints the icon chip only — tile chrome stays uniform so a busy
 *  panel stays calm (mockup contract). */
export const BUTTON_TONES: Record<HAButtonTone, ToneColors> = {
  default: { accent: 'rgba(255,255,255,0.8)', chipBg: 'rgba(255,255,255,0.06)', holdText: '#fff' },
  amber: { accent: '#fbbf24', chipBg: 'rgba(251,191,36,0.14)', holdText: '#fde68a' },
  blue: { accent: '#60a5fa', chipBg: 'rgba(96,165,250,0.14)', holdText: '#bfdbfe' },
  green: { accent: '#4ade80', chipBg: 'rgba(74,222,128,0.14)', holdText: '#bbf7d0' },
  purple: { accent: '#c084fc', chipBg: 'rgba(192,132,252,0.14)', holdText: '#e9d5ff' },
  red: { accent: '#f87171', chipBg: 'rgba(248,113,113,0.14)', holdText: '#fca5a5' },
};

export const TONE_ORDER: HAButtonTone[] = ['default', 'amber', 'blue', 'green', 'purple', 'red'];

/** The hold sweep needs a visible fill even on tone `default`, where the
 *  accent is near-white — fall back to the plugin's amber active color. */
export function holdSweepColor(tone: HAButtonTone): string {
  return tone === 'default' ? BUTTON_TONES.amber.accent : BUTTON_TONES[tone].accent;
}

// ── Row normalization ───────────────────────────────────────────────────────

const VALID_TONES = new Set<string>(TONE_ORDER);

/** Filter persisted config rows down to usable buttons. A row without a
 *  domain + service can't do anything, so it is dropped; everything else
 *  gets defaults. Ids are minted by the editor — a missing one (hand-edited
 *  config) falls back to a position-derived key. */
export function normalizeButtons(raw: unknown): HAButtonRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: HAButtonRow[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r == null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const domain = typeof o.domain === 'string' ? o.domain.trim() : '';
    const service = typeof o.service === 'string' ? o.service.trim() : '';
    if (!domain || !service) continue;
    const label = typeof o.label === 'string' && o.label.trim()
      ? o.label.trim()
      : `${domain}.${service}`;
    const icon = typeof o.icon === 'string' && isIconName(o.icon)
      ? o.icon
      : defaultIconForDomain(domain);
    const tone: HAButtonTone = typeof o.tone === 'string' && VALID_TONES.has(o.tone)
      ? (o.tone as HAButtonTone)
      : 'default';
    const entityId = typeof o.entityId === 'string' && o.entityId.trim()
      ? o.entityId.trim() : undefined;
    const serviceData = o.serviceData != null && typeof o.serviceData === 'object'
      && !Array.isArray(o.serviceData)
      ? (o.serviceData as Record<string, unknown>) : undefined;
    rows.push({
      id: typeof o.id === 'string' && o.id ? o.id : `button-${i}`,
      label, icon, tone, domain, service, entityId, serviceData,
      holdToRun: o.holdToRun === true,
    });
  }
  return rows;
}

/** Icon a fresh (or icon-less) button gets, keyed by service domain. The
 *  editor also uses this to auto-swap the icon when the user picks a service
 *  from a new domain and hasn't customized the icon yet. */
export function defaultIconForDomain(domain: string): IconName {
  switch (domain) {
    case 'light': return 'lightbulb';
    case 'switch': case 'input_boolean': return 'power';
    case 'lock': return 'lock';
    case 'cover': return 'garage';
    case 'climate': return 'thermometer';
    case 'media_player': return 'music';
    case 'scene': return 'palette';
    case 'script': case 'automation': case 'vacuum': return 'robot';
    case 'fan': return 'fan';
    case 'camera': return 'camera';
    case 'alarm_control_panel': return 'shield';
    case 'notify': return 'megaphone';
    default: return 'bolt';
  }
}

/** Curated picker strip — the full glyph set minus sensor-only shapes. */
export const BUTTON_ICON_CHOICES: IconName[] = [
  'power', 'lightbulb', 'moon', 'sun', 'lock', 'unlock', 'garage', 'house',
  'door', 'tv', 'music', 'play', 'megaphone', 'thermometer', 'fan', 'robot',
  'palette', 'shield', 'bolt', 'camera', 'plug', 'droplet', 'user', 'wind',
];

// ── Service catalog (HA /api/services) ──────────────────────────────────────

export interface HAServiceDef {
  domain: string;
  service: string;
  /** Friendly name from HA ("Turn on"), falling back to the service id. */
  name: string;
  description: string;
  /** True when HA declares an entity target — the editor then requires a
   *  device pick before the button is complete. */
  needsEntity: boolean;
}

/** Parse the raw /api/services response:
 *  `[{ domain, services: { <service>: { name?, description?, target? } } }]`.
 *  Tolerant of older HA payloads where service values are bare objects. */
export function parseServicesResponse(raw: unknown): HAServiceDef[] {
  if (!Array.isArray(raw)) return [];
  const out: HAServiceDef[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const domain = (item as Record<string, unknown>).domain;
    const services = (item as Record<string, unknown>).services;
    if (typeof domain !== 'string' || services == null || typeof services !== 'object') continue;
    for (const [service, def] of Object.entries(services as Record<string, unknown>)) {
      const d = def != null && typeof def === 'object' ? def as Record<string, unknown> : {};
      const target = d.target != null && typeof d.target === 'object'
        ? d.target as Record<string, unknown> : null;
      out.push({
        domain,
        service,
        name: typeof d.name === 'string' && d.name ? d.name : service.replace(/_/g, ' '),
        description: typeof d.description === 'string' ? d.description : '',
        needsEntity: Boolean(target && 'entity' in target),
      });
    }
  }
  return out;
}

/** Friendly group labels for the picker; unknown domains fall back to a
 *  capitalized domain name. */
const SERVICE_GROUP_LABELS: Record<string, string> = {
  script: 'Scripts', scene: 'Scenes', automation: 'Automations',
  light: 'Lights', switch: 'Switches', lock: 'Locks', cover: 'Covers & doors',
  climate: 'Heating & cooling', media_player: 'Speakers & TVs', fan: 'Fans',
  vacuum: 'Vacuums', camera: 'Cameras', notify: 'Announcements',
  alarm_control_panel: 'Alarm', button: 'Buttons', input_boolean: 'Toggles',
  water_heater: 'Water heater', humidifier: 'Humidifier', siren: 'Sirens',
  homeassistant: 'Home Assistant',
};

/** Family-relevant domains float to the top of the picker in this order;
 *  everything else follows alphabetically. */
const GROUP_PRIORITY = [
  'script', 'scene', 'light', 'switch', 'lock', 'cover', 'climate',
  'media_player', 'vacuum', 'fan', 'notify', 'automation',
];

export function serviceGroupLabel(domain: string): string {
  return SERVICE_GROUP_LABELS[domain]
    ?? domain.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface ServiceGroup {
  domain: string;
  label: string;
  services: HAServiceDef[];
}

export const SERVICE_PICKER_CAP = 60;

/** Group + rank the catalog for the picker, optionally filtered by a search
 *  query matched against `domain.service`, the friendly name, the
 *  description, and the group label. Results are capped so an unfiltered
 *  3000-service instance doesn't render a mile-long popup — the caller shows
 *  a "keep typing" hint when `truncated`. */
export function groupServicesForPicker(
  catalog: HAServiceDef[], query: string,
): { groups: ServiceGroup[]; truncated: boolean } {
  const q = query.trim().toLowerCase();
  const matched = q
    ? catalog.filter((s) =>
        `${s.domain}.${s.service}`.toLowerCase().includes(q)
        || s.name.toLowerCase().includes(q)
        || s.description.toLowerCase().includes(q)
        || serviceGroupLabel(s.domain).toLowerCase().includes(q))
    : catalog;
  const truncated = matched.length > SERVICE_PICKER_CAP;
  const capped = matched.slice(0, SERVICE_PICKER_CAP);

  const byDomain = new Map<string, HAServiceDef[]>();
  for (const s of capped) {
    if (!byDomain.has(s.domain)) byDomain.set(s.domain, []);
    byDomain.get(s.domain)!.push(s);
  }
  const rank = (d: string) => {
    const i = GROUP_PRIORITY.indexOf(d);
    return i === -1 ? GROUP_PRIORITY.length : i;
  };
  const groups = Array.from(byDomain.entries())
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([domain, services]) => ({
      domain,
      label: serviceGroupLabel(domain),
      services: services.sort((a, b) => a.service.localeCompare(b.service)),
    }));
  return { groups, truncated };
}

export function findServiceDef(
  catalog: HAServiceDef[], domain: string, service: string,
): HAServiceDef | undefined {
  return catalog.find((s) => s.domain === domain && s.service === service);
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** One-line "what this does" for compact pills and the editor summary.
 *  Domain phrasing first (kid-readable), then the catalog's friendly name. */
export function buttonSubtitle(row: HAButtonRow, catalog?: HAServiceDef[]): string {
  switch (row.domain) {
    case 'script': return 'Runs a script';
    case 'scene': return 'Sets a scene';
    case 'automation': return 'Runs an automation';
    case 'notify': return 'Sends an announcement';
    case 'vacuum': return 'Controls the vacuum';
  }
  const def = catalog && findServiceDef(catalog, row.domain, row.service);
  if (def?.name) return capitalize(def.name);
  return `${row.domain}.${row.service}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Service-data JSON ───────────────────────────────────────────────────────

export type ServiceDataParse =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

/** Validate the Advanced JSON field. Empty text clears the field; anything
 *  else must parse to a plain object (HA service payloads are objects). */
export function parseServiceDataJson(text: string): ServiceDataParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'Not valid JSON. Example: { "code": "1234" }' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Extra settings must be a JSON object like { "code": "1234" }' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Payload for the service call: extra settings first so a configured
 *  entity target always wins over a stray entity_id in the JSON. */
export function buildServicePayload(row: HAButtonRow): Record<string, unknown> {
  return {
    ...(row.serviceData ?? {}),
    ...(row.entityId ? { entity_id: row.entityId } : {}),
  };
}
