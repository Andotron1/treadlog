// Bluetooth FTMS (Fitness Machine Service, 0x1826) client for treadmills.
// Spec: Bluetooth SIG FTMS 1.0. Works in Chrome on Android via Web Bluetooth.

export const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export const U = {
  ftms: uuid16(0x1826),
  treadmillData: uuid16(0x2acd),
  controlPoint: uuid16(0x2ad9),
  status: uuid16(0x2ada),
  feature: uuid16(0x2acc),
  speedRange: uuid16(0x2ad4),
  inclineRange: uuid16(0x2ad5),
};

// Services we ask the browser to expose. Web Bluetooth only lets a page see
// services listed here, so we include common fitness/vendor ones for diagnostics.
export const OPTIONAL_SERVICES = [
  0x1826, 0x1800, 0x1801, 0x180a, 0x180d, 0x180f, 0xfff0, 0xffe0, 0xfee0, 0xfe00, 0xffd0, 0xfba0,
].map(uuid16);

export const OP = {
  requestControl: 0x00,
  reset: 0x01,
  setSpeed: 0x02,
  setIncline: 0x03,
  start: 0x07,
  stopPause: 0x08,
};

export const RESULT = { success: 0x01, notSupported: 0x02, invalid: 0x03, failed: 0x04, notPermitted: 0x05 };

/** Parse a Treadmill Data (0x2ACD) notification. Returns only fields present. */
export function parseTreadmillData(dv) {
  let o = 0;
  const flags = dv.getUint16(o, true);
  o += 2;
  const out = {};
  const u8 = () => { const v = dv.getUint8(o); o += 1; return v; };
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };

  if (!(flags & 0x0001)) out.speed = u16() / 100; // km/h (bit0 = "more data", inverted)
  if (flags & 0x0002) out.avgSpeed = u16() / 100;
  if (flags & 0x0004) { out.distance = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
  if (flags & 0x0008) { out.incline = i16() / 10; out.rampAngle = i16() / 10; }
  if (flags & 0x0010) { out.elevGain = u16() / 10; o += 2; }
  if (flags & 0x0020) out.pace = u8() / 10;
  if (flags & 0x0040) o += 1;
  if (flags & 0x0080) {
    const total = u16(); const perHour = u16(); const perMin = u8();
    if (total !== 0xffff) out.energy = total;
    if (perHour !== 0xffff) out.energyPerHour = perHour;
    if (perMin !== 0xff) out.energyPerMin = perMin;
  }
  if (flags & 0x0100) { const hr = u8(); if (hr > 0) out.hr = hr; }
  if (flags & 0x0200) o += 1;
  if (flags & 0x0400) out.elapsed = u16();
  if (flags & 0x0800) out.remaining = u16();
  // bit 12 force/power: ignored
  return out;
}

export function buildSetSpeed(kmh) {
  const v = Math.round(kmh * 100);
  return new Uint8Array([OP.setSpeed, v & 0xff, (v >> 8) & 0xff]);
}
export function buildSetIncline(pct) {
  const v = Math.round(pct * 10) & 0xffff;
  return new Uint8Array([OP.setIncline, v & 0xff, (v >> 8) & 0xff]);
}
export const CMD_REQUEST_CONTROL = new Uint8Array([OP.requestControl]);
export const CMD_START = new Uint8Array([OP.start]);
export const CMD_STOP = new Uint8Array([OP.stopPause, 0x01]);
export const CMD_PAUSE = new Uint8Array([OP.stopPause, 0x02]);

const hex = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

export class Treadmill extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.ch = {};
    this.wantConnected = false;
    this.state = 'disconnected'; // disconnected | connecting | connected | unsupported
    this.queue = Promise.resolve();
    this.pending = null;
    this.range = { minSpeed: 1, maxSpeed: 16, speedStep: 0.1, minIncline: 0, maxIncline: 0, inclineStep: 0.5 };
    this.canIncline = false;
    this.name = '';
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(msg) { this.emit('log', `${new Date().toLocaleTimeString()}  ${msg}`); }
  setState(s) { this.state = s; this.emit('state', s); }

  static supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  async connect() {
    if (!Treadmill.supported()) throw new Error('Web Bluetooth is not available. Use Chrome on Android over HTTPS.');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES });
    this.device = device;
    this.name = device.name || 'Treadmill';
    device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
    this.wantConnected = true;
    await this.setup();
  }

  async setup() {
    this.setState('connecting');
    this.log(`Connecting to ${this.name}…`);
    this.server = await this.device.gatt.connect();
    const services = await this.server.getPrimaryServices();
    this.log(`Services: ${services.map((s) => s.uuid.slice(4, 8)).join(', ') || 'none exposed'}`);
    for (const s of services) {
      try {
        const chars = await s.getCharacteristics();
        for (const c of chars) {
          const p = Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join('/');
          this.log(`  ${s.uuid.slice(4, 8)} › ${c.uuid.slice(4, 8)}  ${p}`);
        }
      } catch (e) { this.log(`  ${s.uuid.slice(4, 8)}: cannot list characteristics (${e.message})`); }
    }
    const svc = services.find((s) => s.uuid === U.ftms);
    if (!svc) {
      this.setState('unsupported');
      this.log('No FTMS service (0x1826) on this device. Copy this log from Settings › Diagnostics and share it.');
      return;
    }
    const get = async (u) => { try { return await svc.getCharacteristic(u); } catch { return null; } };
    this.ch.data = await get(U.treadmillData);
    this.ch.cp = await get(U.controlPoint);
    this.ch.status = await get(U.status);
    const speedRange = await get(U.speedRange);
    const inclineRange = await get(U.inclineRange);

    if (speedRange) {
      try {
        const v = await speedRange.readValue();
        this.range.minSpeed = v.getUint16(0, true) / 100;
        this.range.maxSpeed = v.getUint16(2, true) / 100;
        this.range.speedStep = Math.max(v.getUint16(4, true) / 100, 0.1);
      } catch (e) { this.log(`Speed range read failed: ${e.message}`); }
    }
    this.canIncline = false;
    if (inclineRange) {
      try {
        const v = await inclineRange.readValue();
        this.range.minIncline = v.getInt16(0, true) / 10;
        this.range.maxIncline = v.getInt16(2, true) / 10;
        this.range.inclineStep = Math.max(v.getUint16(4, true) / 10, 0.5);
        this.canIncline = this.range.maxIncline > this.range.minIncline;
      } catch (e) { this.log(`Incline range read failed: ${e.message}`); }
    }
    this.log(`Speed ${this.range.minSpeed}–${this.range.maxSpeed} km/h, incline ${this.canIncline ? `${this.range.minIncline}–${this.range.maxIncline}%` : 'not controllable'}`);

    if (this.ch.data) {
      this.ch.data.addEventListener('characteristicvaluechanged', (e) => {
        try {
          const dv = e.target.value;
          this.emit('raw', hex(dv));
          this.emit('data', parseTreadmillData(dv));
        } catch (err) { this.log(`Parse error: ${err.message}`); }
      });
      await this.ch.data.startNotifications();
    }
    if (this.ch.status) {
      this.ch.status.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this.log(`Status: ${hex(dv)}`);
        this.emit('status', { op: dv.getUint8(0), param: dv.byteLength > 1 ? dv.getUint8(1) : null });
      });
      try { await this.ch.status.startNotifications(); } catch { /* optional */ }
    }
    if (this.ch.cp) {
      this.ch.cp.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this.log(`CP response: ${hex(dv)}`);
        if (dv.getUint8(0) === 0x80 && this.pending && this.pending.op === dv.getUint8(1)) {
          this.pending.resolve(dv.getUint8(2));
        }
      });
      try { await this.ch.cp.startNotifications(); } catch (e) { this.log(`Control point indications failed: ${e.message}`); }
      await this.command(CMD_REQUEST_CONTROL, { retry: false });
    } else {
      this.log('Warning: no control point; read-only mode.');
    }
    this.setState('connected');
  }

  onDisconnect() {
    this.log('Disconnected.');
    this.setState('disconnected');
    if (this.wantConnected) this.reconnect();
  }

  async reconnect() {
    const delays = [1000, 2000, 4000, 8000, 15000];
    for (const d of delays) {
      if (!this.wantConnected) return;
      await new Promise((r) => setTimeout(r, d));
      try {
        await this.setup();
        this.log('Reconnected.');
        return;
      } catch (e) { this.log(`Reconnect failed: ${e.message}`); }
    }
    this.wantConnected = false;
    this.emit('gaveup');
  }

  disconnect() {
    this.wantConnected = false;
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
    this.setState('disconnected');
  }

  /** Serialised write to the control point; resolves with FTMS result code (or null on timeout). */
  command(bytes, { retry = true } = {}) {
    const run = async () => {
      if (!this.ch.cp) return null;
      const op = bytes[0];
      const waiter = new Promise((resolve) => {
        const t = setTimeout(() => { if (this.pending?.op === op) this.pending = null; resolve(null); }, 3000);
        this.pending = { op, resolve: (r) => { clearTimeout(t); this.pending = null; resolve(r); } };
      });
      await this.ch.cp.writeValueWithResponse(bytes);
      const result = await waiter;
      if (result === RESULT.notPermitted && retry && op !== OP.requestControl) {
        await this.command(CMD_REQUEST_CONTROL, { retry: false });
        return this.command(bytes, { retry: false });
      }
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async start() { await this.command(CMD_REQUEST_CONTROL, { retry: false }); return this.command(CMD_START); }
  pause() { return this.command(CMD_PAUSE); }
  stop() { return this.command(CMD_STOP); }
  setSpeed(kmh) {
    const clamped = Math.min(this.range.maxSpeed, Math.max(this.range.minSpeed, kmh));
    return this.command(buildSetSpeed(clamped));
  }
  setIncline(pct) {
    const clamped = Math.min(this.range.maxIncline, Math.max(this.range.minIncline, pct));
    return this.command(buildSetIncline(clamped));
  }
}
