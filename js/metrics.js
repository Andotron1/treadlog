// Pure run-recording logic (no DOM / no Bluetooth) so it can be unit tested.

export const MIN_RUN_SECONDS = 60;
export const MIN_RUN_METRES = 100;
const MOVING_KMH = 0.5;
const IDLE_END_SECONDS = 20;
const SAMPLE_EVERY_SECONDS = 2;

/** ACSM metabolic equation → kcal per minute. Used only if the treadmill reports no energy. */
export function kcalPerMinute(kmh, inclinePct, weightKg) {
  const mpm = (kmh * 1000) / 60;
  const grade = (inclinePct || 0) / 100;
  const vo2 = kmh >= 8
    ? 0.2 * mpm + 0.9 * mpm * grade + 3.5
    : 0.1 * mpm + 1.8 * mpm * grade + 3.5;
  return (vo2 * weightKg) / 1000 * 5;
}

export class Recorder {
  constructor({ weightKg = 75 } = {}) {
    this.weightKg = weightKg;
    this.reset();
  }

  reset() {
    this.run = null;
    this.speed = 0;
    this.incline = 0;
    this.hr = null;
    this.lastT = null;
    this.startStreak = 0;
    this.streakStartT = null;
    this.idleSec = 0;
    this.lastMovingT = null;
    this.lastSampleSec = -SAMPLE_EVERY_SECONDS;
  }

  get active() { return !!this.run; }

  /** Feed a parsed treadmill packet. t = ms timestamp. Returns {event, run?}. */
  feed(d, t) {
    if (d.speed !== undefined) this.speed = d.speed;
    if (d.incline !== undefined) this.incline = d.incline;
    if (d.hr !== undefined) this.hr = d.hr;
    const moving = this.speed > MOVING_KMH;

    if (!this.run) {
      if (moving) {
        if (this.startStreak === 0) this.streakStartT = t;
        this.startStreak += 1;
        if (this.startStreak >= 2) {
          this.begin(this.streakStartT, d);
          this.lastT = this.streakStartT;
          this.advance(d, t);
          return { event: 'started' };
        }
      } else {
        this.startStreak = 0;
      }
      this.lastT = t;
      return { event: null };
    }

    this.advance(d, t);
    if (this.idleSec >= IDLE_END_SECONDS) return this.finish(this.lastMovingT, 'idle');
    return { event: null };
  }

  begin(t, d) {
    this.run = {
      id: t,
      start: t,
      end: t,
      inProgress: true,
      movingSec: 0,
      distIntegrated: 0,
      distReportedStart: d.distance ?? null,
      distReportedLast: d.distance ?? null,
      energyStart: d.energy ?? null,
      energyLast: d.energy ?? null,
      kcalEst: 0,
      maxKmh: 0,
      maxIncline: 0,
      inclineSecSum: 0,
      hrSecSum: 0,
      hrSec: 0,
      maxHr: 0,
      samples: [],
    };
    this.idleSec = 0;
    this.lastMovingT = t;
    this.lastSampleSec = -SAMPLE_EVERY_SECONDS;
  }

  advance(d, t) {
    const r = this.run;
    const dt = Math.min(Math.max((t - this.lastT) / 1000, 0), 5);
    this.lastT = t;
    if (d.distance !== undefined) { if (r.distReportedStart === null) r.distReportedStart = d.distance; r.distReportedLast = d.distance; }
    if (d.energy !== undefined) { if (r.energyStart === null) r.energyStart = d.energy; r.energyLast = d.energy; }
    r.end = t;
    if (this.speed > MOVING_KMH) {
      this.idleSec = 0;
      this.lastMovingT = t;
      r.movingSec += dt;
      r.distIntegrated += (this.speed / 3.6) * dt;
      r.kcalEst += (kcalPerMinute(this.speed, this.incline, this.weightKg) * dt) / 60;
      r.maxKmh = Math.max(r.maxKmh, this.speed);
      r.maxIncline = Math.max(r.maxIncline, this.incline);
      r.inclineSecSum += this.incline * dt;
      if (this.hr) { r.hrSecSum += this.hr * dt; r.hrSec += dt; r.maxHr = Math.max(r.maxHr, this.hr); }
    } else {
      this.idleSec += dt;
    }
    const sec = Math.round((t - r.start) / 1000);
    if (sec - this.lastSampleSec >= SAMPLE_EVERY_SECONDS) {
      this.lastSampleSec = sec;
      r.samples.push([sec, Math.round(this.speed * 10) / 10, Math.round(this.incline * 10) / 10, this.hr || 0]);
    }
  }

  distanceM() {
    const r = this.run;
    if (!r) return 0;
    if (r.distReportedStart !== null && r.distReportedLast !== null && r.distReportedLast >= r.distReportedStart) {
      const rep = r.distReportedLast - r.distReportedStart;
      // trust treadmill odometer unless it clearly never moved
      if (rep > 0 || r.distIntegrated < 20) return rep;
    }
    return r.distIntegrated;
  }

  kcal() {
    const r = this.run;
    if (!r) return 0;
    if (r.energyStart !== null && r.energyLast !== null && r.energyLast > r.energyStart) return r.energyLast - r.energyStart;
    return r.kcalEst;
  }

  /** Live stats for display. */
  live() {
    const r = this.run;
    if (!r) return null;
    const dist = this.distanceM();
    return {
      movingSec: r.movingSec,
      distanceM: dist,
      avgKmh: r.movingSec > 0 ? (dist / r.movingSec) * 3.6 : 0,
      kcal: this.kcal(),
      avgIncline: r.movingSec > 0 ? r.inclineSecSum / r.movingSec : 0,
    };
  }

  /** Serialisable summary of the current run (for autosave and finish). */
  snapshot() {
    const r = this.run;
    if (!r) return null;
    const dist = this.distanceM();
    return {
      id: r.id,
      start: r.start,
      end: r.end,
      inProgress: r.inProgress,
      movingSec: Math.round(r.movingSec),
      distanceM: Math.round(dist),
      avgKmh: r.movingSec > 0 ? Math.round((dist / r.movingSec) * 360) / 100 : 0,
      maxKmh: r.maxKmh,
      avgIncline: r.movingSec > 0 ? Math.round((r.inclineSecSum / r.movingSec) * 10) / 10 : 0,
      maxIncline: r.maxIncline,
      kcal: Math.round(this.kcal()),
      avgHr: r.hrSec > 0 ? Math.round(r.hrSecSum / r.hrSec) : null,
      maxHr: r.maxHr || null,
      samples: r.samples,
    };
  }

  /** End the run. Returns {event:'finished', run} or {event:'discarded'}. */
  finish(endT, reason = 'manual') {
    if (!this.run) return { event: null };
    if (endT) this.run.end = Math.max(this.run.start, endT);
    this.run.inProgress = false;
    const snap = this.snapshot();
    snap.endReason = reason;
    const tooShort = snap.movingSec < MIN_RUN_SECONDS || snap.distanceM < MIN_RUN_METRES;
    this.reset();
    return tooShort ? { event: 'discarded', run: snap } : { event: 'finished', run: snap };
  }
}

// ---------- formatting & aggregation helpers ----------
export const KM_PER_MILE = 1.609344;

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDistance(m, units) {
  return units === 'mi' ? (m / 1000 / KM_PER_MILE).toFixed(2) : (m / 1000).toFixed(2);
}

export function fmtSpeed(kmh, units) {
  return (units === 'mi' ? kmh / KM_PER_MILE : kmh).toFixed(1);
}

/** Pace as m:ss per km (or mile). */
export function fmtPace(kmh, units) {
  if (!kmh || kmh < 0.5) return '–:––';
  const minPer = (units === 'mi' ? KM_PER_MILE : 1) * 60 / kmh;
  let m = Math.floor(minPer), s = Math.round((minPer - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function startOfWeek(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

/** Distance per week for the last n weeks (oldest first). */
export function weeklyTotals(runs, n = 8, now = Date.now()) {
  const thisWeek = startOfWeek(now);
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    weeks.push({ start: d.getTime(), distanceM: 0, runs: 0, movingSec: 0 });
  }
  for (const r of runs) {
    const wk = startOfWeek(r.start);
    const slot = weeks.find((w) => w.start === wk);
    if (slot) { slot.distanceM += r.distanceM; slot.runs += 1; slot.movingSec += r.movingSec; }
  }
  return weeks;
}

export function personalBests(runs) {
  const pb = { longestM: null, longestSec: null, fastestAvg: null };
  for (const r of runs) {
    if (!pb.longestM || r.distanceM > pb.longestM.distanceM) pb.longestM = r;
    if (!pb.longestSec || r.movingSec > pb.longestSec.movingSec) pb.longestSec = r;
    if (r.distanceM >= 1000 && (!pb.fastestAvg || r.avgKmh > pb.fastestAvg.avgKmh)) pb.fastestAvg = r;
  }
  return pb;
}
