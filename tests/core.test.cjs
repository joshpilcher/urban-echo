const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");
const now = 1700000000000;
const origin = { lat: -26.65, lng: 153.07 };
const fix = { ...origin, accuracy: 8, timestamp: now };
const north = (metres) => ({
  lat: origin.lat + ((metres / 6371000) * 180) / Math.PI,
  lng: origin.lng,
});

test("distance is in metres and handles identical and antipodal coordinates", () => {
  assert.equal(Core.metres(origin, origin), 0);
  assert.ok(Math.abs(Core.metres(origin, north(100)) - 100) < 0.001);
  assert.ok(
    Number.isFinite(Core.metres({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })),
  );
});
test("discovery unlocks nearby content and relocks outside 100 metres", () => {
  assert.equal(Core.discovery(north(40), fix, now).state, "unlocked");
  assert.equal(Core.discovery(north(101), fix, now).state, "locked");
  assert.equal(Core.discovery(north(95), fix, now).state, "uncertain");
  assert.equal(Core.discovery(origin, null, now).state, "unavailable");
});
test("accuracy boundary and poor fixes do not reveal uncertain content", () => {
  assert.equal(
    Core.discovery(origin, { ...fix, accuracy: 100 }, now).state,
    "unlocked",
  );
  assert.equal(
    Core.discovery(origin, { ...fix, accuracy: 101 }, now).state,
    "uncertain",
  );
  assert.equal(Core.canCreate({ ...fix, accuracy: 100 }, now), true);
  assert.equal(Core.canCreate({ ...fix, accuracy: 101 }, now), false);
});
test("old, future, invalid and missing fixes cannot reveal or save memories", () => {
  for (const candidate of [
    null,
    { ...fix, timestamp: now - 30000 },
    { ...fix, timestamp: now + 1 },
    { ...fix, accuracy: -1 },
    { ...fix, accuracy: NaN },
    { ...fix, lat: 91 },
    { ...fix, lng: 181 },
  ]) {
    assert.equal(Core.canCreate(candidate, now), false);
    assert.equal(Core.discovery(origin, candidate, now).state, "unavailable");
  }
  assert.equal(Core.canCreate({ ...fix, timestamp: now - 29999 }, now), true);
});
test("stored v0.1 records remain valid; malformed records are rejected", () => {
  const echo = {
    ...origin,
    id: "old-id",
    title: "The first visit",
    story: "A memory.",
    createdAt: "2026-10-19T04:00:00Z",
  };
  assert.equal(Core.validEcho(echo), true);
  for (const record of [
    null,
    {},
    { ...echo, lat: 200 },
    { ...echo, id: "" },
    { ...echo, title: " " },
    { ...echo, story: "x".repeat(1201) },
    { ...echo, createdAt: "invalid" },
  ])
    assert.equal(Core.validEcho(record), false);
});
