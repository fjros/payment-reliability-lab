import type { ScenarioId } from '../../src/scenarios/answers.ts';
import { append, h, svg } from './dom.ts';
import {
  balancesAt,
  FILTERS,
  formatMinor,
  laneOf,
  LANES,
  loadIndex,
  loadLive,
  loadReplay,
  momentAt,
  visibleEvents,
  type FilterId,
  type Loaded,
  type Moment,
  type ReplayIndexEntry,
  type TraceEvent,
} from './model.ts';

declare const __PUBLIC_REPLAY__: boolean;
const liveEnabled = !__PUBLIC_REPLAY__;

interface State {
  index: ReplayIndexEntry[];
  tab: string; // replay file name, or 'live'
  loaded: Loaded | null;
  error: string | null;
  position: number;
  filters: Set<FilterId>;
  selected: string | null;
  playing: boolean;
  live: { account: string; transfer: string; question: ScenarioId | 'none' };
}

const state: State = {
  index: [],
  tab: '',
  loaded: null,
  error: null,
  position: 0,
  filters: new Set(FILTERS.map((f) => f.id)),
  selected: null,
  playing: false,
  live: { account: '', transfer: '', question: 'none' },
};
const root = document.getElementById('app')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let timer: number | undefined;
let lastRevealed = 0;

const STATUS_TEXT = { pass: 'PASS', fail: 'FAIL', unknown: 'UNKNOWN' } as const;
const STATUS_ICON = { pass: '✓', fail: '✕', unknown: '?' } as const;
const human = (type: string): string => type.replaceAll('_', ' ');
const maxSeq = (): number => state.loaded?.doc.trace.at(-1)?.seq ?? 0;

// ---- State transitions ----------------------------------------------------------------------

function setPosition(next: number): void {
  const clamped = Math.max(0, Math.min(maxSeq(), next));
  lastRevealed = clamped > state.position ? clamped : 0;
  state.position = clamped;
  if (clamped >= maxSeq()) stop();
  render();
}

function stop(): void {
  state.playing = false;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function togglePlay(): void {
  if (state.playing) {
    stop();
  } else {
    if (state.position >= maxSeq()) state.position = 0;
    state.playing = true;
    timer = window.setInterval(() => setPosition(state.position + 1), 900);
  }
  render();
}

async function openTab(tab: string): Promise<void> {
  stop();
  state.tab = tab;
  state.selected = null;
  state.error = null;
  if (tab === 'live' && liveEnabled) {
    state.loaded = null;
    history.replaceState(null, '', '#live');
    render();
    return;
  }
  try {
    state.loaded = await loadReplay(tab);
    // Replays open on the full picture; the controls step back through it. Nothing autoplays.
    state.position = state.loaded.doc.trace.at(-1)?.seq ?? 0;
    history.replaceState(null, '', `#${state.loaded.doc.scenario.id}`);
  } catch (error) {
    state.loaded = null;
    state.error = `Could not load replay "${tab}": ${(error as Error).message}`;
  }
  render();
}

async function observeLive(): Promise<void> {
  const previous = state.loaded?.source.kind === 'live' ? state.loaded : null;
  try {
    state.loaded = await loadLive(state.live.account.trim(), state.live.transfer.trim(), state.live.question);
    state.position = maxSeq();
    state.error = null;
  } catch (error) {
    const message = `API disconnected or request refused: ${(error as Error).message}`;
    if (previous && previous.source.kind === 'live') {
      // Keep the last observation on screen, but say loudly that it is stale.
      state.loaded = { doc: previous.doc, source: { ...previous.source, stale: true, error: message } };
    } else {
      state.loaded = null;
      state.error = message;
    }
  }
  render();
}

// ---- Rendering ------------------------------------------------------------------------------

function render(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
  root.replaceChildren(header(), tabs(), body());
  if (active) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(active)}"]`)?.focus();
  window.requestAnimationFrame(drawConnectors);
}

function header(): HTMLElement {
  return h(
    'header',
    { class: 'top' },
    h(
      'div',
      {},
      h('h1', {}, 'Payment Reliability Lab'),
      h(
        'p',
        { class: 'sub' },
        'Trace viewer for synthetic transfers. It explains the system; the evidence is the tests and the recorded traces.',
      ),
    ),
    h(
      'div',
      { class: 'public-links' },
      h('span', { class: 'badge synthetic' }, 'All data synthetic · DEMO_USD is not money'),
      __PUBLIC_REPLAY__ && h('p', {}, 'Interactive replay of recorded test runs · No backend or account required'),
      __PUBLIC_REPLAY__ &&
        h(
          'nav',
          { 'aria-label': 'Project resources' },
          h('a', { href: 'https://github.com/fjros/payment-reliability-lab', target: '_blank', rel: 'noreferrer' }, 'Source code ↗'),
          h(
            'a',
            {
              href: 'https://github.com/fjros/payment-reliability-lab#guarantees-and-what-they-rest-on',
              target: '_blank',
              rel: 'noreferrer',
            },
            'Engineering decisions ↗',
          ),
        ),
    ),
  );
}

function tabs(): HTMLElement {
  const entries = [
    ...state.index.map((e) => ({ key: e.file, label: `${e.id} · ${e.title}` })),
    ...(liveEnabled ? [{ key: 'live', label: 'Live API' }] : []),
  ];
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Scenarios' });
  entries.forEach((entry, i) => {
    const selected = entry.key === state.tab;
    list.appendChild(
      h(
        'button',
        {
          role: 'tab',
          id: `tab-${i}`,
          'aria-selected': String(selected),
          'aria-controls': 'panel',
          tabindex: selected ? 0 : -1,
          'data-focus-key': `tab:${entry.key}`,
          class: selected ? 'tab selected' : 'tab',
          onclick: () => void openTab(entry.key),
          onkeydown: (event: Event) => {
            const key = (event as KeyboardEvent).key;
            const move =
              key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'Home' ? -i : key === 'End' ? entries.length - 1 - i : 0;
            if (move === 0) return;
            event.preventDefault();
            const target = entries[(i + move + entries.length) % entries.length]!;
            void openTab(target.key).then(() =>
              root.querySelector<HTMLElement>(`[data-focus-key="tab:${CSS.escape(target.key)}"]`)?.focus(),
            );
          },
        },
        entry.label,
      ),
    );
  });
  return list;
}

function body(): HTMLElement {
  const panel = h('main', { id: 'panel', role: 'tabpanel', 'aria-label': state.tab === 'live' ? 'Live API' : 'Scenario replay' });
  if (state.tab === 'live') panel.appendChild(liveForm());
  if (state.error) panel.appendChild(h('p', { class: 'banner error', role: 'alert' }, state.error));
  if (!state.loaded) {
    if (!state.error && state.tab !== 'live') panel.appendChild(h('p', { class: 'muted' }, 'Loading replay…'));
    return panel;
  }
  const { doc, source } = state.loaded;
  const moment = momentAt(doc, state.position);
  append(panel, [
    sourceBanner(),
    question(moment),
    controls(),
    h(
      'div',
      { class: 'grid' },
      h('section', { class: 'main-col', 'aria-label': 'Timeline' }, filters(), timeline(), steps()),
      h('aside', { class: 'side-col' }, balances(), invariants(moment), detail(moment), arrivalOrder(moment), exceptions(moment), oracle()),
    ),
    h(
      'footer',
      { class: 'muted small' },
      source.kind === 'replay' ? doc.provenance.note : 'Live observation of a local demo API. Not an export.',
    ),
  ]);
  return panel;
}

function sourceBanner(): HTMLElement {
  const { doc, source } = state.loaded!;
  if (source.kind === 'replay') {
    return h(
      'p',
      { class: 'banner replay', 'data-testid': 'source' },
      h('strong', {}, 'EXPORTED REPLAY'),
      ` · recorded ${doc.generatedAt} by "${doc.provenance.generator}" · seed ${doc.seed} · revision ${doc.implementationRevision} · no backend, agent or MCP call is involved in showing this.`,
    );
  }
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'banner live', 'data-testid': 'source' },
      h('strong', {}, 'LIVE OBSERVATION'),
      ` · fetched ${source.fetchedAt} from the local read API.`,
    ),
    source.stale &&
      h(
        'p',
        { class: 'banner error', role: 'alert', 'data-testid': 'stale' },
        h('strong', {}, 'STALE SNAPSHOT — '),
        `${source.error ?? ''} Showing what was observed at ${source.fetchedAt}; it may no longer be true.`,
      ),
  );
}

function question(moment: Moment | null): HTMLElement {
  const { doc } = state.loaded!;
  const answer = moment?.answer ?? null;
  const box = h(
    'section',
    { class: `question verdict-${answer?.verdict ?? 'none'}`, 'aria-live': 'polite' },
    h('p', { class: 'eyebrow' }, `${doc.scenario.id} · ${doc.scenario.title}`),
    h('h2', {}, doc.scenario.question),
    h('p', { class: 'muted' }, doc.scenario.summary),
  );
  if (!moment) {
    box.appendChild(
      h(
        'p',
        { class: 'answer', 'data-testid': 'answer' },
        'No application snapshot has been captured yet at this point of the replay. Step forward.',
      ),
    );
  } else if (!answer || answer.verdict === 'unsupported') {
    box.appendChild(
      h('p', { class: 'answer', 'data-testid': 'answer' }, 'No answer is shown: the recorded evidence does not support one.'),
    );
  } else {
    const label = answer.verdict === 'not_yet_known' ? 'UNKNOWN — not a failure' : answer.verdict === 'yes' ? 'ANSWER: YES' : 'ANSWER: NO';
    append(box, [
      h('p', { class: 'answer', 'data-testid': 'answer' }, h('span', { class: `pill ${answer.verdict}` }, label), ' ', answer.text),
      h(
        'p',
        { class: 'small muted' },
        `As of snapshot "${moment.label}" (after event #${moment.afterSeq}). Supported by: `,
        ...evidenceChips(answer.evidenceIds),
      ),
    ]);
  }
  return box;
}

function evidenceChips(ids: string[]): Array<HTMLElement | string> {
  const unique = [...new Set(ids)].slice(0, 12);
  if (unique.length === 0) return ['(no evidence IDs)'];
  const byId = new Map(state.loaded!.doc.trace.map((e) => [e.eventId, e]));
  return unique.map((id) => {
    const event = byId.get(id);
    return event
      ? h(
          'button',
          { class: 'chip link', 'data-focus-key': `chip:${id}`, onclick: () => select(event.eventId), title: `Show event #${event.seq}` },
          `#${event.seq} ${id}`,
        )
      : h('code', { class: 'chip' }, id);
  });
}

function controls(): HTMLElement {
  const total = maxSeq();
  return h(
    'section',
    { class: 'controls', 'aria-label': 'Replay controls' },
    h('button', { 'data-focus-key': 'c:start', onclick: () => setPosition(0), 'aria-label': 'Go to start' }, '⏮'),
    h(
      'button',
      {
        'data-focus-key': 'c:back',
        onclick: () => setPosition(state.position - 1),
        'aria-label': 'Step back',
        disabled: state.position <= 0,
      },
      '◀ Step',
    ),
    h(
      'button',
      { 'data-focus-key': 'c:play', class: 'primary', onclick: togglePlay, 'aria-pressed': String(state.playing) },
      state.playing ? '⏸ Pause' : '▶ Play',
    ),
    h(
      'button',
      {
        'data-focus-key': 'c:fwd',
        onclick: () => setPosition(state.position + 1),
        'aria-label': 'Step forward',
        disabled: state.position >= total,
      },
      'Step ▶',
    ),
    h('button', { 'data-focus-key': 'c:end', onclick: () => setPosition(total), 'aria-label': 'Go to end' }, '⏭'),
    h(
      'label',
      { class: 'scrub' },
      h('span', { class: 'sr' }, 'Replay position'),
      h('input', {
        type: 'range',
        min: 0,
        max: total,
        value: state.position,
        'data-focus-key': 'c:range',
        'aria-valuetext': `event ${state.position} of ${total}`,
        oninput: (event: Event) => setPosition(Number((event.target as HTMLInputElement).value)),
      }),
    ),
    h('output', { 'data-testid': 'position' }, `event ${state.position} of ${total}`),
  );
}

function filters(): HTMLElement {
  return h(
    'fieldset',
    { class: 'filters' },
    h('legend', {}, 'Show'),
    ...FILTERS.map((f) =>
      h(
        'label',
        {},
        h('input', {
          type: 'checkbox',
          checked: state.filters.has(f.id),
          'data-focus-key': `f:${f.id}`,
          onchange: () => {
            if (state.filters.has(f.id)) state.filters.delete(f.id);
            else state.filters.add(f.id);
            render();
          },
        }),
        ` ${f.label}`,
      ),
    ),
  );
}

function select(eventId: string): void {
  state.selected = eventId;
  const event = state.loaded?.doc.trace.find((e) => e.eventId === eventId);
  if (event && event.seq > state.position) state.position = event.seq;
  render();
  document.getElementById('detail')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

const BROKEN = new Set(['response_lost', 'fault_injected']);
const MUTED = new Set(['duplicate_ignored', 'stale_event_ignored', 'request_replayed']);

function eventCard(event: TraceEvent, row: number): HTMLElement {
  const lane = laneOf(event);
  const laneIndex = LANES.findIndex((l) => l.id === lane) + 1;
  const cause = event.causationId ? state.loaded!.doc.trace.find((e) => e.eventId === event.causationId) : null;
  const classes = ['card', `lane-${lane}`, `type-${event.type}`];
  if (MUTED.has(event.type)) classes.push('muted-card');
  if (BROKEN.has(event.type)) classes.push('broken');
  if (event.type === 'outcome_unknown') classes.push('uncertain');
  if (state.selected === event.eventId) classes.push('selected');
  if (event.seq === lastRevealed && !reducedMotion.matches) classes.push('enter');
  const summary = summarize(event);
  return h(
    'button',
    {
      class: classes.join(' '),
      style: `grid-column:${laneIndex};grid-row:${row}`,
      id: `card-${event.eventId}`,
      'data-seq': event.seq,
      'data-lane': lane,
      'data-focus-key': `card:${event.eventId}`,
      'aria-pressed': String(state.selected === event.eventId),
      'aria-label': `Event ${event.seq}, ${human(event.type)}, ${LANES[laneIndex - 1]!.title}. ${summary}`,
      onclick: () => select(event.eventId),
    },
    h(
      'span',
      { class: 'card-head' },
      h('span', { class: 'seq' }, `#${event.seq}`),
      h('span', { class: 'lane-chip' }, LANES[laneIndex - 1]!.title),
      h('span', { class: 'type' }, human(event.type)),
    ),
    h('span', { class: 'card-body' }, summary),
    BROKEN.has(event.type) &&
      h(
        'span',
        { class: 'broken-link', 'aria-hidden': 'true' },
        h('span', { class: 'wire' }),
        h('span', { class: 'cut' }, '✕'),
        h('span', { class: 'wire dashed' }),
        h('span', { class: 'cut-label' }, 'response never arrived'),
      ),
    cause && h('span', { class: 'cause small' }, `caused by #${cause.seq}`),
    event.untrusted && h('span', { class: 'small untrusted-flag' }, 'contains untrusted text'),
  );
}

function summarize(e: TraceEvent): string {
  const f = e.facts as Record<string, string | number | boolean | null | undefined>;
  switch (e.type) {
    case 'request_accepted':
      return `Accepted ${f.amountMinor} ${f.asset} → ${f.destination} (key ${f.idempotencyKey}, request ${f.requestId})`;
    case 'request_replayed':
      return `Same key, same payload: replayed original acceptance (request ${f.requestId}). No new effect.`;
    case 'idempotency_conflict_rejected':
      return `Same key, different payload: refused with 409 (request ${f.requestId}). No effect.`;
    case 'fault_injected':
      return `Injected fault: ${f.fault}. Client saw: ${f.clientObserved}.`;
    case 'funds_reserved':
    case 'funds_settled':
    case 'funds_released':
      return `${f.phase} ${f.amountMinor} ${f.asset} · batch ${f.batchId}`;
    case 'state_changed':
      return `${f.from} → ${f.to}`;
    case 'job_claimed':
      return `Lease #${f.leaseToken} by ${f.workerId} (state was ${f.stateWhenClaimed})`;
    case 'submission_attempted':
      return `${f.resubmission ? 'RE-submit' : 'Submit'} attempt ${f.attemptNo} with reference ${f.providerReference}`;
    case 'lookup_attempted':
      return `Lookup attempt ${f.attemptNo} with reference ${f.providerReference}`;
    case 'response_lost':
      return `${f.call} got no response (${f.outcome}). ${f.meaning}`;
    case 'provider_call_failed':
      return `${f.call} failed: ${f.outcome}${f.httpStatus ? ` (HTTP ${f.httpStatus})` : ''}. ${f.meaning}`;
    case 'outcome_unknown':
      return `Outcome UNKNOWN (${f.reason}). Reservation ${f.reservation}.`;
    case 'webhook_accepted':
      return `Webhook ${f.providerEventId}: "${f.providerStatus}", provider sequence ${f.providerSequence}`;
    case 'duplicate_ignored':
      return f.level === 'delivery'
        ? `Redelivery of ${f.providerEventId}: acknowledged, no effect`
        : 'Same business outcome again: no effect';
    case 'stale_event_ignored':
      return `Older observation ignored; state stays ${f.state}`;
    case 'provider_observation_received':
      return `Provider says "${f.providerStatus}" via ${f.channel} (seq ${f.providerSequence ?? '–'}) → ${f.decision}`;
    case 'exception_recorded':
      return `Exception: ${f.reason}. Automatic correction: ${f.automaticCorrection}.`;
    case 'stale_worker_result_discarded':
      return `Stale worker ${f.workerId} (lease #${f.staleLeaseToken}) result discarded`;
    case 'job_scheduled':
      return `Job ${f.jobId} committed with the acceptance`;
    default:
      return human(e.type);
  }
}

function timeline(): HTMLElement {
  const events = visibleEvents(state.loaded!.doc, state.position, state.filters);
  const wrap = h('div', { class: 'timeline', id: 'timeline', tabindex: -1 });
  wrap.appendChild(
    h(
      'div',
      { class: 'lane-heads', 'aria-hidden': 'true' },
      ...LANES.map((l) =>
        h('div', { class: `lane-head lane-${l.id}` }, h('strong', {}, l.title), h('span', { class: 'small muted' }, l.hint)),
      ),
    ),
  );
  const lanes = h('div', { class: 'lanes', 'data-testid': 'lanes' });
  lanes.appendChild(svg('svg', { class: 'connectors', 'aria-hidden': 'true' }));
  events.forEach((event, i) => lanes.appendChild(eventCard(event, i + 1)));
  if (events.length === 0)
    lanes.appendChild(
      h('p', { class: 'muted empty' }, state.position === 0 ? 'Start of replay. Press Play or Step.' : 'No events match the filters.'),
    );
  wrap.appendChild(lanes);
  wrap.appendChild(
    h(
      'p',
      { class: 'small muted' },
      'Rows follow the per-transfer sequence recorded by the application. Timestamps order events on one clock only; they do not establish causality between lanes — follow "caused by" links instead.',
    ),
  );
  return wrap;
}

/** Curved links from cause to effect; desktop layout only. Purely decorative (aria-hidden). */
function drawConnectors(): void {
  const lanes = root.querySelector<HTMLElement>('.lanes');
  const overlay = lanes?.querySelector<SVGElement>('svg.connectors');
  if (!lanes || !overlay || !state.loaded) return;
  overlay.replaceChildren();
  if (window.getComputedStyle(lanes).getPropertyValue('--stacked').trim() === '1') return;
  const box = lanes.getBoundingClientRect();
  overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  overlay.setAttribute('width', String(box.width));
  overlay.setAttribute('height', String(box.height));
  for (const event of state.loaded.doc.trace) {
    if (!event.causationId) continue;
    const from = document.getElementById(`card-${event.causationId}`)?.getBoundingClientRect();
    const to = document.getElementById(`card-${event.eventId}`)?.getBoundingClientRect();
    if (!from || !to) continue;
    const x1 = from.left + from.width / 2 - box.left,
      y1 = from.bottom - box.top;
    const x2 = to.left + to.width / 2 - box.left,
      y2 = to.top - box.top;
    const mid = (y1 + y2) / 2;
    const highlighted = state.selected === event.eventId || state.selected === event.causationId;
    overlay.appendChild(
      svg('path', { d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, class: highlighted ? 'link hot' : 'link' }),
    );
  }
}

function steps(): HTMLElement | null {
  const { doc } = state.loaded!;
  if (doc.steps.length === 0) return null;
  const current = [...doc.steps].reverse().find((s) => s.afterSeq <= state.position)?.n ?? 0;
  return h(
    'section',
    { class: 'steps' },
    h('h3', {}, 'What the scenario harness did'),
    h(
      'ol',
      {},
      ...doc.steps.map((s) =>
        h(
          'li',
          { class: s.n === current ? 'current' : s.afterSeq > state.position ? 'future' : '' },
          h('span', { class: 'actor' }, s.actor),
          ' ',
          s.text,
          ' ',
          h(
            'button',
            { class: 'link small', 'data-focus-key': `step:${s.n}`, onclick: () => setPosition(s.afterSeq) },
            `go to #${s.afterSeq}`,
          ),
        ),
      ),
    ),
  );
}

function balances(): HTMLElement {
  const b = balancesAt(state.loaded!.doc, state.position);
  const row = (label: string, value: bigint, hint: string, cls: string): HTMLElement =>
    h(
      'div',
      { class: `bal ${cls}` },
      h('dt', {}, label),
      h('dd', { 'data-testid': `bal-${cls}` }, String(value)),
      h('span', { class: 'small muted' }, `${formatMinor(value)} · ${hint}`),
    );
  return h(
    'section',
    { class: 'panel' },
    h('h3', {}, 'Balances'),
    b
      ? h(
          'dl',
          { class: 'balances' },
          row('Available', b.available, 'spendable', 'available'),
          row('Reserved', b.reserved, 'held for in-flight transfers', 'reserved'),
          row('Settled / clearing', b.settled, 'moved to the provider', 'settled'),
        )
      : h('p', { class: 'muted' }, 'No balance snapshot.'),
    h(
      'p',
      { class: 'small muted' },
      `${b?.asset ?? 'DEMO_USD'} minor units (exact integers). Rebuilt at this replay position from journal effects in the trace.`,
    ),
  );
}

function invariants(moment: Moment | null): HTMLElement {
  const panel = h('section', { class: 'panel' }, h('h3', {}, 'Invariants'));
  if (!moment) {
    panel.appendChild(h('p', { class: 'muted' }, 'No snapshot captured yet at this position.'));
    return panel;
  }
  panel.appendChild(
    h('p', { class: 'small muted' }, `Checked by the application at snapshot "${moment.label}" (after event #${moment.afterSeq}).`),
  );
  if (moment.invariants.unresolvedExternalOutcome) {
    panel.appendChild(
      h(
        'p',
        { class: 'banner uncertain' },
        h('strong', {}, 'OUTCOME UNKNOWN. '),
        'An unresolved external outcome is a valid state, not an invariant failure.',
      ),
    );
  }
  panel.appendChild(
    h(
      'ul',
      { class: 'invariants' },
      ...moment.invariants.results.map((r) =>
        h(
          'li',
          { class: `inv ${r.status}`, 'data-testid': `inv-${r.id}` },
          h(
            'details',
            {},
            h(
              'summary',
              { 'data-focus-key': `inv:${r.id}` },
              h('span', { class: `status ${r.status}` }, `${STATUS_ICON[r.status]} ${STATUS_TEXT[r.status]}`),
              ' ',
              h('strong', {}, r.id),
              ' ',
              r.title.split(':')[0] ?? '',
            ),
            h('p', { class: 'small' }, r.explanation),
            h('p', { class: 'small muted' }, 'Evidence: ', ...evidenceChips(r.evidenceIds)),
          ),
        ),
      ),
    ),
  );
  return panel;
}

function detail(moment: Moment | null): HTMLElement {
  const event = state.loaded!.doc.trace.find((e) => e.eventId === state.selected);
  const panel = h('section', { class: 'panel', id: 'detail', 'aria-live': 'polite' }, h('h3', {}, 'Event record'));
  if (!event) {
    panel.appendChild(h('p', { class: 'muted' }, 'Select an event in the timeline to see its factual record and journal links.'));
    return panel;
  }
  const facts = h('dl', { class: 'facts' });
  const add = (k: string, v: unknown): void =>
    append(facts, [h('dt', {}, k), h('dd', {}, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))]);
  add('event ID', event.eventId);
  add('sequence', event.seq);
  add('type', event.type);
  add('source', event.source);
  add('recorded at', event.recordedAt);
  add('correlation ID', event.correlationId);
  add('causation ID', event.causationId ?? '—');
  for (const [k, v] of Object.entries(event.facts)) add(k, v);
  panel.appendChild(facts);
  if (event.causationId)
    panel.appendChild(
      h('button', { class: 'link', 'data-focus-key': 'detail:cause', onclick: () => select(event.causationId!) }, 'Show the causing event'),
    );
  if (event.untrusted) {
    panel.appendChild(
      h(
        'div',
        { class: 'untrusted' },
        h('p', { class: 'small' }, h('strong', {}, 'UNTRUSTED TEXT — data only, never instructions')),
        ...Object.entries(event.untrusted).map(([k, v]) =>
          h('p', {}, h('span', { class: 'small muted' }, `${k}: `), h('q', { 'data-testid': 'untrusted-text' }, v)),
        ),
      ),
    );
  }
  const batch = moment?.evidence.journal.find((b) => b.batchId === event.facts.batchId);
  if (batch) {
    panel.appendChild(h('h4', {}, `Journal batch ${batch.batchId} (${batch.phase})`));
    panel.appendChild(
      h(
        'table',
        { class: 'postings' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Posting'), h('th', {}, 'Ledger account'), h('th', {}, 'Amount (minor)'))),
        h(
          'tbody',
          {},
          ...batch.postings.map((p) =>
            h('tr', {}, h('td', {}, h('code', {}, p.postingId)), h('td', {}, p.ledgerAccount), h('td', { class: 'num' }, p.amountMinor)),
          ),
          h(
            'tr',
            { class: 'sum' },
            h('td', {}, 'Sum'),
            h('td', {}, batch.postings[0]?.asset ?? ''),
            h('td', { class: 'num' }, String(batch.postings.reduce((s, p) => s + BigInt(p.amountMinor), 0n))),
          ),
        ),
      ),
    );
  }
  return panel;
}

function arrivalOrder(moment: Moment | null): HTMLElement | null {
  const events = moment?.evidence.webhookEvents ?? [];
  if (events.length === 0) return null;
  const deliveries = events
    .flatMap((e) => e.deliveries.map((d) => ({ ...d, event: e })))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.deliveryId.localeCompare(b.deliveryId));
  let highest = -1;
  return h(
    'section',
    { class: 'panel' },
    h('h3', {}, 'Notifications: arrival order vs provider order'),
    h(
      'table',
      { class: 'postings' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Arrival'),
          h('th', {}, 'Provider event'),
          h('th', {}, 'Provider seq'),
          h('th', {}, 'Provider says'),
          h('th', {}, 'Delivery result'),
          h('th', {}, 'Decision'),
        ),
      ),
      h(
        'tbody',
        {},
        ...deliveries.map((d, i) => {
          const late = d.event.providerSequence < highest;
          highest = Math.max(highest, d.event.providerSequence);
          return h(
            'tr',
            { class: late ? 'late' : '' },
            h('td', {}, `${i + 1}`),
            h('td', {}, h('code', {}, d.event.eventId)),
            h('td', { class: 'num' }, `${d.event.providerSequence}${late ? ' (older, arrived late)' : ''}`),
            h('td', {}, d.event.providerStatus),
            h('td', {}, d.result),
            h('td', {}, d.event.decision ?? 'not processed yet'),
          );
        }),
      ),
    ),
    h(
      'p',
      { class: 'small muted' },
      "Arrival is when this application received a delivery. Provider sequence is the provider's own ordering of what happened. They are independent.",
    ),
  );
}

function exceptions(moment: Moment | null): HTMLElement | null {
  if (!moment || moment.exceptions.length === 0) return null;
  return h(
    'section',
    { class: 'panel' },
    h('h3', {}, 'Open exceptions'),
    h(
      'ul',
      { class: 'exceptions' },
      ...moment.exceptions.map((x) =>
        h(
          'li',
          { class: x.kind },
          h(
            'strong',
            {},
            x.kind === 'unknown_outcome'
              ? 'UNKNOWN OUTCOME (unresolved, not a failure)'
              : x.kind === 'conflicting_observation'
                ? 'CONFLICTING OBSERVATION'
                : 'INVARIANT FAILURE',
          ),
          ` · ${x.reason}`,
          h('p', { class: 'small' }, x.detail),
          h('p', { class: 'small muted' }, 'Evidence: ', ...evidenceChips(x.evidenceIds)),
        ),
      ),
    ),
  );
}

function oracle(): HTMLElement | null {
  const o = state.loaded!.doc.oracle;
  if (!o) return null;
  return h(
    'details',
    { class: 'panel oracle' },
    h('summary', { 'data-focus-key': 'oracle' }, 'Privileged simulator oracle (hidden from the application and the agent)'),
    h('p', { class: 'small' }, o.notice),
    h('p', {}, `Provider's real status: ${o.providerStatus ?? 'no such operation'} · external effects applied: ${o.providerEffectCount}`),
  );
}

function liveForm(): HTMLElement {
  const field = (label: string, key: 'account' | 'transfer', placeholder: string): HTMLElement =>
    h(
      'label',
      {},
      label,
      h('input', {
        type: 'text',
        value: state.live[key],
        placeholder,
        maxlength: 80,
        autocomplete: 'off',
        spellcheck: 'false',
        'data-focus-key': `live:${key}`,
        oninput: (event: Event) => {
          state.live[key] = (event.target as HTMLInputElement).value;
        },
      }),
    );
  return h(
    'form',
    {
      class: 'live-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void observeLive();
      },
    },
    h(
      'p',
      { class: 'muted' },
      'Reads a transfer from the local API (npm run dev) through the dev-server proxy. Read-only: this page has no way to create, retry or change a transfer.',
    ),
    field('Demo account', 'account', 'S3-1-A'),
    field('Transfer ID', 'transfer', 'tr_…'),
    h(
      'label',
      {},
      'Question',
      h(
        'select',
        {
          'data-focus-key': 'live:question',
          onchange: (event: Event) => {
            state.live.question = (event.target as HTMLSelectElement).value as ScenarioId | 'none';
          },
        },
        ...(['none', 'S1', 'S2', 'S3', 'S7', 'S8'] as const).map((q) => h('option', { value: q, selected: state.live.question === q }, q)),
      ),
    ),
    h(
      'button',
      { type: 'submit', class: 'primary', 'data-focus-key': 'live:go' },
      state.loaded?.source.kind === 'live' ? 'Observe again' : 'Observe',
    ),
  );
}

// ---- Boot -----------------------------------------------------------------------------------

window.addEventListener('resize', () => window.requestAnimationFrame(drawConnectors));
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (!state.loaded || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.key === ']') setPosition(state.position + 1);
  if (event.key === '[') setPosition(state.position - 1);
});

try {
  state.index = await loadIndex();
} catch (error) {
  state.error = `Could not load replays/index.json: ${(error as Error).message}`;
}
const wanted = location.hash.replace('#', '');
const first = state.index.find((e) => e.id === wanted) ?? state.index[0];
if (liveEnabled && (wanted === 'live' || !first)) await openTab('live');
else if (first) await openTab(first.file);
else render();
