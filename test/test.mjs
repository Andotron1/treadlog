import assert from 'node:assert/strict';
import { parseTreadmillData, buildSetSpeed, buildSetIncline } from '../js/ftms.js';
import { Recorder, fmtPace, fmtDuration, weeklyTotals, kcalPerMinute } from '../js/metrics.js';

const dv = (bytes) => new DataView(new Uint8Array(bytes).buffer);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('parse: speed only (flags 0)', () => {
  assert.deepEqual(parseTreadmillData(dv([0x00, 0x00, 0xb8, 0x0b])), { speed: 30 }); // 0x0BB8 = 3000 → 30.00
});
t('parse: speed 8.5 km/h + distance + incline + energy + hr + elapsed', () => {
  // flags: distance(0x4)+incline(0x8)+energy(0x80)+hr(0x100)+elapsed(0x400) = 0x58C
  const b = [0x8c, 0x05, 0x52, 0x03, /*speed 850*/ 0xe8, 0x03, 0x00, /*dist 1000m*/ 0x32, 0x00, 0x00, 0x00, /*incline 5.0 ramp 0*/
    0x50, 0x00, 0xff, 0xff, 0x01, /*energy total 80,*/ 0x00, 0xff, 0xff, 0x00, /*hr*/ 0x8e, /*elapsed*/ 0x78, 0x00];
  // build properly instead of hand-ordering: recompute
  const buf = new Uint8Array(2 + 2 + 3 + 4 + 5 + 1 + 2);
  const v = new DataView(buf.buffer);
  let o = 0;
  v.setUint16(o, 0x058c, true); o += 2;
  v.setUint16(o, 850, true); o += 2;
  buf[o] = 0xe8; buf[o + 1] = 0x03; buf[o + 2] = 0x00; o += 3; // 1000 m
  v.setInt16(o, 50, true); o += 2; v.setInt16(o, 0, true); o += 2;
  v.setUint16(o, 80, true); o += 2; v.setUint16(o, 0xffff, true); o += 2; buf[o] = 0xff; o += 1;
  buf[o] = 142; o += 1;
  v.setUint16(o, 120, true);
  const r = parseTreadmillData(v);
  assert.equal(r.speed, 8.5); assert.equal(r.distance, 1000); assert.equal(r.incline, 5);
  assert.equal(r.energy, 80); assert.equal(r.energyPerHour, undefined); assert.equal(r.hr, 142); assert.equal(r.elapsed, 120);
});
t('parse: "more data" bit set => no speed field', () => {
  assert.deepEqual(parseTreadmillData(dv([0x01, 0x00])), {});
});
t('commands encode little endian', () => {
  assert.deepEqual([...buildSetSpeed(8.5)], [0x02, 0x52, 0x03]);
  assert.deepEqual([...buildSetIncline(-1.5)], [0x03, 0xf1, 0xff]);
  assert.deepEqual([...buildSetIncline(2.5)], [0x03, 0x19, 0x00]);
});

t('recorder: full run with reported distance', () => {
  const r = new Recorder({ weightKg: 80 });
  let now = 1_000_000;
  let dist = 5000; // odometer starts non-zero
  const events = [];
  for (let s = 0; s <= 600; s++) {
    dist += (9 / 3.6); // 9 km/h
    const res = r.feed({ speed: 9, incline: 1, distance: Math.round(dist), hr: 150 }, now + s * 1000);
    if (res.event) events.push(res.event);
  }
  // belt stops, 25 s of zeros
  let end;
  for (let s = 601; s <= 630; s++) {
    const res = r.feed({ speed: 0, incline: 1, distance: Math.round(dist) }, now + s * 1000);
    if (res.event === 'finished') end = res.run;
    if (res.event) events.push(res.event);
  }
  assert.deepEqual(events, ['started', 'finished']);
  assert.ok(end, 'run produced');
  assert.ok(Math.abs(end.distanceM - 1500) < 10, `dist ${end.distanceM}`);
  assert.ok(Math.abs(end.movingSec - 600) < 3, `moving ${end.movingSec}`);
  assert.ok(Math.abs(end.avgKmh - 9) < 0.2, `avg ${end.avgKmh}`);
  assert.equal(end.maxKmh, 9); assert.equal(end.avgHr, 150); assert.equal(end.inProgress, false);
  assert.ok(end.kcal > 80 && end.kcal < 200, `kcal ${end.kcal}`);
  assert.ok(end.samples.length > 250);
  assert.ok(!r.active);
});
t('recorder: integrates speed when no odometer', () => {
  const r = new Recorder();
  let res;
  for (let s = 0; s <= 300; s++) r.feed({ speed: 6 }, s * 1000);
  res = r.finish(300_000);
  assert.equal(res.event, 'finished');
  assert.ok(Math.abs(res.run.distanceM - 500) < 5, `dist ${res.run.distanceM}`);
});
t('recorder: short run discarded', () => {
  const r = new Recorder();
  for (let s = 0; s <= 20; s++) r.feed({ speed: 4 }, s * 1000);
  assert.equal(r.finish(20_000).event, 'discarded');
});
t('recorder: single blip does not start a run', () => {
  const r = new Recorder();
  assert.equal(r.feed({ speed: 3 }, 0).event, null);
  assert.equal(r.feed({ speed: 0 }, 1000).event, null);
  assert.ok(!r.active);
});
t('recorder: data gap is capped (no phantom distance)', () => {
  const r = new Recorder();
  r.feed({ speed: 10 }, 0); r.feed({ speed: 10 }, 1000);
  r.feed({ speed: 10 }, 601_000); // 10 min gap (tablet asleep)
  assert.ok(r.live().distanceM < 40, `dist ${r.live().distanceM}`);
});

t('formatting', () => {
  assert.equal(fmtPace(10, 'km'), '6:00');
  assert.equal(fmtPace(0, 'km'), '–:––');
  assert.equal(fmtDuration(3725), '1:02:05');
  assert.equal(fmtDuration(65), '1:05');
  assert.ok(kcalPerMinute(10, 0, 75) > 10 && kcalPerMinute(10, 0, 75) < 14);
});
t('weekly totals bucket by Monday', () => {
  const wed = new Date('2026-11-11T10:00:00').getTime();
  const lastWeek = new Date('2026-11-04T10:00:00').getTime();
  const w = weeklyTotals([{ start: wed, distanceM: 5000, movingSec: 1800 }, { start: lastWeek, distanceM: 3000, movingSec: 900 }], 4, new Date('2026-11-12T20:00:00').getTime());
  assert.equal(w.length, 4); assert.equal(w[3].distanceM, 5000); assert.equal(w[2].distanceM, 3000);
});
console.log(`\n${n} tests passed`);
