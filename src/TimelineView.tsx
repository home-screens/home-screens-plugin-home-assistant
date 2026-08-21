// Timeline view: what happened at home today. A 24-hour lane chart on top,
// one row per thing that turns on and off, and the same day as sentences
// underneath, newest first. Pure logic lives in timeline.ts; the view owns
// its own history fetch (on mount and every minute).

import React from 'react';
import type { HAStateObject } from './types';
import { EmptyState, type ViewProps } from './views';
import { Chip } from './cards';
import { useElementSize } from './hooks';
import { Icon, iconFor } from './icons';
import { friendlyName, formatClock } from './utils';
import { hostTimezone } from './settings';
import { fetchTimeline } from './api';
import { tr } from './i18n';
import { useScale } from './scale';
import { useTheme, withAlpha } from './theme';
import {
  timelineWindow, segments, laneTone, timelineEvents, eventSentence,
  splitAroundName, summarizeLane, hourTicks, spanBox,
  liveTransition, countHome, tickStepFor, feedColumnsFor, quantizeNow, isActiveTimelineState,
  TIMELINE_POLL_MS, TIMELINE_FEED_CAP, TIMELINE_MIN_SPAN_MS,
  type TimelineData, type TimelineEvent, type TimelineTransition,
} from './timeline';

/** Last good response per connection, keyed by the entity set, so a
 *  remount (the editor preview, a config save) paints immediately instead
 *  of waiting a round trip. One entry per haUrl: a changed entity set
 *  replaces the old one, so the map never grows with config edits. The
 *  proxy cache already dedupes the request itself. */
const lastData = new Map<string, { idsKey: string; data: TimelineData }>();

function cachedData(haUrl: string, idsKey: string): TimelineData | null {
  const hit = lastData.get(haUrl);
  return hit && hit.idsKey === idsKey ? hit.data : null;
}

/** How long the editor preview waits after the last entity toggle before
 *  fetching history. */
const PREVIEW_FETCH_DELAY_MS = 1_000;

function useTimelineData(haUrl: string, entityIds: readonly string[], preview: boolean | undefined) {
  const idsKey = [...entityIds].sort().join(',');
  const [state, setState] = React.useState<{ key: string; data: TimelineData | null; failed: boolean }>(
    () => ({ key: `${haUrl}|${idsKey}`, data: cachedData(haUrl, idsKey), failed: false }),
  );

  React.useEffect(() => {
    let cancelled = false;
    let inflight = false;
    const key = `${haUrl}|${idsKey}`;
    const ids = idsKey ? idsKey.split(',') : [];
    // A new connection or entity set starts from what the cache holds for
    // it, never from the previous set's rows.
    setState({ key, data: cachedData(haUrl, idsKey), failed: false });
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const next = await fetchTimeline(haUrl, ids);
        if (cancelled) return;
        lastData.set(haUrl, { idsKey, data: next });
        setState({ key, data: next, failed: false });
      } catch (e) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, key, failed: true }));
        window.__HS_SDK__?.emit({
          type: 'log', level: 'warn',
          message: `HA timeline fetch failed: ${e instanceof Error ? e.message : 'unknown'}`,
        });
      } finally {
        inflight = false;
      }
    };
    // The preview pane shows whatever it has; one load is enough there,
    // and it waits until the entity list has stopped changing so ticking
    // ten boxes in the editor is one history request, not ten.
    if (preview && cachedData(haUrl, idsKey)) return undefined;
    if (preview) {
      const timer = setTimeout(() => { void load(); }, PREVIEW_FETCH_DELAY_MS);
      return () => { cancelled = true; clearTimeout(timer); };
    }
    void load();
    const timer = setInterval(() => { void load(); }, TIMELINE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [haUrl, idsKey, preview]);

  return { data: state.data, failed: state.failed };
}

export function TimelineView({ states, config, preview }: ViewProps) {
  const u = useScale();
  const t = useTheme();
  const { data, failed } = useTimelineData(config.haUrl, config.entities, preview);
  const [bodyRef, { width: bodyWidth }] = useElementSize<HTMLDivElement>();
  // Re-render on the minute so the Now line and the window keep moving even
  // when nothing changes at home.
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    const timer = setInterval(tick, TIMELINE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const byId = React.useMemo(() => new Map(states.map((s) => [s.entity_id, s])), [states]);
  // Lanes follow the order the entities were picked in.
  const lanes = React.useMemo(
    () => config.entities.map((id) => byId.get(id)).filter((s): s is HAStateObject => s != null),
    [config.entities, byId],
  );
  const timeZone = hostTimezone();
  const endMs = quantizeNow();
  const { startMs } = timelineWindow(endMs);

  const liveById = React.useMemo(
    () => new Map<string, TimelineTransition>(lanes.map((s) => [s.entity_id, liveTransition(s)])),
    [lanes],
  );
  const events = React.useMemo(
    () => (data ? timelineEvents(data, liveById, startMs, endMs) : []),
    [data, liveById, startMs, endMs],
  );

  const home = countHome(lanes);
  const hasPeople = lanes.some((s) => s.entity_id.startsWith('person.') || s.entity_id.startsWith('device_tracker.'));
  const compact = config.compactMode;
  const pad = compact ? u(12) : u(14);

  let body: React.ReactNode;
  if (data == null) {
    body = (
      <EmptyState message={failed
        ? tr('timeline.loadFailed', 'Could not load today\'s history.')
        : tr('timeline.loading', 'Looking back over the day...')} />
    );
  } else if (events.length === 0) {
    body = <EmptyState message={tr('timeline.nothingChanged', 'Nothing has changed in the last day.')} />;
  } else {
    body = (
      <>
        <div style={{
          display: 'flex', gap: u(8), flexWrap: 'wrap', alignItems: 'center',
          padding: `${u(2)}px ${u(2)}px 0`,
        }}>
          <Chip>{events.length === 1
            ? tr('timeline.oneThingHappened', '1 thing happened today')
            : tr('timeline.thingsHappened', '{count} things happened today', { count: events.length })}</Chip>
          {hasPeople && (
            <Chip dot={home > 0 ? t.accent.green.base : undefined}>
              {tr('timeline.homeCount', '{count} home', { count: home })}
            </Chip>
          )}
        </div>

        <LaneChart lanes={lanes} data={data} liveById={liveById}
          startMs={startMs} endMs={endMs} timeZone={timeZone} width={bodyWidth - pad * 2} />

        <Feed events={events} byId={byId} timeZone={timeZone}
          columns={feedColumnsFor(config.columns, bodyWidth - pad * 2, u(230))} />
      </>
    );
  }

  return (
    <div ref={bodyRef} style={{
      flex: 1, minHeight: 0, overflowY: 'auto',
      padding: `${u(4)}px ${pad}px ${pad}px`,
      display: 'flex', flexDirection: 'column', gap: u(18),
    }}>
      {body}
    </div>
  );
}

function LaneChart({ lanes, data, liveById, startMs, endMs, timeZone, width }: {
  lanes: HAStateObject[];
  data: TimelineData;
  liveById: ReadonlyMap<string, TimelineTransition>;
  startMs: number;
  endMs: number;
  timeZone: string | undefined;
  /** Available width in px, 0 before the first measurement. */
  width: number;
}) {
  const u = useScale();
  const t = useTheme();
  // The name column gives way on a narrow module so the lanes keep room to
  // show a span; on a wall display it holds its authored width.
  const nameWidth = width > 0 ? Math.min(u(165), Math.max(u(90), width * 0.36)) : u(165);
  const gap = u(10);
  const laneHeight = u(22);
  const laneWidth = Math.max(0, width - nameWidth - gap);
  const step = tickStepFor(laneWidth, u(48));
  // The last label would sit under "Now", so ticks in the final stretch are
  // left out.
  const ticks = hourTicks(startMs, endMs, timeZone, step).filter((tick) => tick.fraction <= 0.92);
  // The spans are positioned in percent of the lane, so the minimum width
  // is a fraction too; u(3) of a lane that is at least a few hundred px
  // wide lands at about 1%, and a blip of under TIMELINE_MIN_SPAN_MS is the
  // case it exists for.
  const minFraction = Math.max(TIMELINE_MIN_SPAN_MS / (endMs - startMs), 0.006);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: `${nameWidth}px 1fr`,
        columnGap: gap, rowGap: u(6), alignItems: 'center',
      }}>
        <div style={{
          gridColumn: 2, position: 'relative', height: u(14),
          fontSize: u(10), color: t.fg(0.4), fontVariantNumeric: 'tabular-nums',
        }}>
          {ticks.map((tick) => (
            <span key={tick.ms} style={{
              position: 'absolute', left: `${(tick.fraction * 100).toFixed(3)}%`,
              // A label near the left edge hangs right so it never spills
              // into the name column.
              transform: tick.fraction < 0.04 ? 'none' : 'translateX(-50%)',
              whiteSpace: 'nowrap', lineHeight: 1, top: u(2),
            }}>
              {tick.label}
            </span>
          ))}
        </div>
        {lanes.map((s) => {
          const deviceClass = typeof s.attributes.device_class === 'string' ? s.attributes.device_class : undefined;
          const segs = segments(s.entity_id, data[s.entity_id] ?? [], startMs, endMs, liveById.get(s.entity_id));
          const tone = t.accent[laneTone(s.entity_id, deviceClass)];
          const summary = summarizeLane(s.entity_id, segs, s.state, deviceClass);
          return (
            <React.Fragment key={s.entity_id}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: u(8), minWidth: 0,
                height: laneHeight, fontSize: u(12), fontWeight: 500, color: t.fg(),
              }}>
                <Icon name={iconFor(s)} size={u(14)} style={{ color: t.fg(0.6), flexShrink: 0 }} />
                <span style={{
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  flex: '0 1 auto',
                }}>
                  {friendlyName(s)}
                </span>
                <span style={{
                  fontSize: u(10), fontWeight: 400, color: t.fg(0.45), flex: '1 1 0', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {summary}
                </span>
              </div>
              <div style={{
                position: 'relative', height: laneHeight, borderRadius: u(5),
                background: t.fg(0.04), overflow: 'hidden',
              }}>
                {segs.map((seg) => {
                  const box = spanBox(seg, startMs, endMs, minFraction);
                  return (
                    <div key={seg.startMs} style={{
                      position: 'absolute', top: 0, bottom: 0,
                      left: `${(box.left * 100).toFixed(3)}%`,
                      width: `${(box.width * 100).toFixed(3)}%`,
                      minWidth: u(3),
                      borderRadius: u(4), background: tone.base, opacity: 0.85,
                    }} />
                  );
                })}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {/* The Now line sits at the right edge of the lanes: the window ends
          at the current minute. */}
      <div style={{
        position: 'absolute', top: u(14), bottom: 0, right: 0, width: u(2),
        background: t.fg(), boxShadow: `0 0 ${u(8)}px ${t.fg(0.9)}`, borderRadius: u(1),
        pointerEvents: 'none',
      }}>
        <span style={{
          position: 'absolute', top: -u(13), right: 0, fontSize: u(9), lineHeight: 1,
          color: t.fg(), whiteSpace: 'nowrap', fontWeight: 600,
        }}>
          {tr('timeline.now', 'Now')}
        </span>
      </div>
    </div>
  );
}

function Feed({ events, byId, timeZone, columns }: {
  events: TimelineEvent[];
  byId: ReadonlyMap<string, HAStateObject>;
  timeZone: string | undefined;
  columns: number;
}) {
  const u = useScale();
  const t = useTheme();
  const shown = events.slice(0, TIMELINE_FEED_CAP);
  const more = events.length - shown.length;
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: `${u(8)}px ${u(14)}px`, alignContent: 'start',
      }}>
        {shown.map((ev) => {
          const s = byId.get(ev.entityId);
          if (!s) return null;
          const deviceClass = typeof s.attributes.device_class === 'string' ? s.attributes.device_class : undefined;
          const name = friendlyName(s);
          const sentence = eventSentence(ev.entityId, ev.state, name, deviceClass);
          const parts = splitAroundName(sentence, name);
          const tone = t.accent[laneTone(ev.entityId, deviceClass)];
          // A thing switching off reads quieter than one switching on.
          const lit = isActiveTimelineState(ev.entityId, ev.state);
          const chipColor = lit ? tone.base : t.fg(0.5);
          const iconState = s.entity_id.startsWith('lock.') ? { ...s, state: ev.state } : s;
          return (
            <div key={`${ev.entityId}:${ev.at}`} style={{
              display: 'flex', alignItems: 'center', gap: u(10),
              padding: `${u(7)}px ${u(10)}px`, borderRadius: u(10),
              background: t.fg(0.04), border: `1px solid ${t.fg(0.06)}`, minWidth: 0,
            }}>
              <span style={{
                fontSize: u(11), color: t.fg(0.5), width: u(50), flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {formatClock(ev.at, timeZone)}
              </span>
              <span style={{
                width: u(26), height: u(26), borderRadius: '50%', flexShrink: 0,
                background: lit ? withAlpha(tone.base, 0.14) : t.fg(0.06),
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: chipColor,
              }}>
                <Icon name={iconFor(iconState)} size={u(14)} />
              </span>
              <span style={{
                fontSize: u(12), color: t.fg(), minWidth: 0, lineHeight: 1.3,
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {parts
                  ? <>{parts.before}<span style={{ fontWeight: 600 }}>{parts.name}</span>{parts.after}</>
                  : sentence}
              </span>
            </div>
          );
        })}
      </div>
      {more > 0 && (
        <div style={{
          textAlign: 'center', fontSize: u(11), color: t.fg(0.4),
          padding: `${u(10)}px 0 ${u(2)}px`,
        }}>
          {tr('timeline.moreEarlier', 'and {count} more earlier', { count: more })}
        </div>
      )}
    </div>
  );
}
