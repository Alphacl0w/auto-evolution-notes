const SLOT_COUNT = 32;
const SHUFFLE_RUNS = 200;

function isoDay(offset) {
  const date = new Date(Date.UTC(2026, 0, 1 + offset));
  return date.toISOString().slice(0, 10);
}

function makeEvents() {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const slot = `project-${String(index + 1).padStart(2, '0')}.deploy-command`;
    return [
      {
        slot,
        value: `npm run deploy:${index + 1}`,
        observedAt: isoDay(index),
        source: `session-${index + 1}-old`,
      },
      {
        slot,
        value: `npm run deploy:prod-${index + 1}`,
        observedAt: isoDay(index + 60),
        source: `session-${index + 1}-new`,
      },
    ];
  }).flat();
}

function shuffled(items, seed) {
  const copy = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function materialize(events) {
  const grouped = groupBy(events, (event) => event.slot);
  return [...grouped.values()].flatMap((slotEvents) => {
    const ordered = [...slotEvents].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return ordered.map((event, index) => ({
      ...event,
      validFrom: event.observedAt,
      validTo: ordered[index + 1]?.observedAt ?? null,
      supersedes: index > 0 ? ordered[index - 1].source : null,
    }));
  });
}

function activeAt(records, slot, at) {
  return records.find(
    (record) =>
      record.slot === slot &&
      record.validFrom <= at &&
      (record.validTo === null || at < record.validTo),
  );
}

const events = makeEvents();
const temporalRecords = materialize(events);
const expectedCurrent = new Map(
  events
    .filter((event) => event.source.endsWith('-new'))
    .map((event) => [event.slot, event.value]),
);

let naiveHits = 0;
let temporalHits = 0;
let historicalHits = 0;

for (let seed = 1; seed <= SHUFFLE_RUNS; seed += 1) {
  const filesystemOrder = shuffled(events, seed);

  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const slot = `project-${String(index + 1).padStart(2, '0')}.deploy-command`;
    const naive = filesystemOrder.find((record) => record.slot === slot);
    if (naive?.value === expectedCurrent.get(slot)) naiveHits += 1;

    const current = activeAt(temporalRecords, slot, '9999-12-31');
    if (current?.value === expectedCurrent.get(slot)) temporalHits += 1;

    const historical = activeAt(temporalRecords, slot, isoDay(index + 30));
    if (historical?.source === `session-${index + 1}-old`) historicalHits += 1;
  }
}

const totalQueries = SLOT_COUNT * SHUFFLE_RUNS;
const activeCountBySlot = groupBy(
  temporalRecords.filter((record) => record.validTo === null),
  (record) => record.slot,
);
const activeSlotViolations = [...activeCountBySlot.values()].filter((records) => records.length !== 1).length;
const sourceLosses = temporalRecords.filter((record) => !record.source).length;

console.table([
  {
    strategy: 'first lexical match after filesystem reorder',
    current_accuracy: `${((naiveHits / totalQueries) * 100).toFixed(2)}%`,
    historical_accuracy: 'not representable',
    candidates_per_query: 2,
  },
  {
    strategy: 'valid-time materialized view',
    current_accuracy: `${((temporalHits / totalQueries) * 100).toFixed(2)}%`,
    historical_accuracy: `${((historicalHits / totalQueries) * 100).toFixed(2)}%`,
    candidates_per_query: 1,
  },
]);

console.log({
  node: process.version,
  slots: SLOT_COUNT,
  shuffleRuns: SHUFFLE_RUNS,
  totalQueries,
  activeSlotViolations,
  sourceLosses,
});

if (temporalHits !== totalQueries || historicalHits !== totalQueries || activeSlotViolations || sourceLosses) {
  process.exitCode = 1;
}
