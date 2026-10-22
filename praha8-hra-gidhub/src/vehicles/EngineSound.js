/**
 * Synthesized engine sound (Web Audio, no audio files).
 * Three oscillators follow the engine RPM, plus filtered noise for wind and tire screech,
 * plus a two-tone horn. One instance = one audible vehicle.
 */

const noiseCache = new WeakMap();

function getNoiseBuffer(actx) {
  let buf = noiseCache.get(actx);
  if (!buf) {
    buf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(actx, buf);
  }
  return buf;
}

export class EngineSound {
  /**
   * @param {AudioContext} actx
   * @param {AudioNode} destination
   * @param {{pitch?:number, wave?:OscillatorType, brightness?:number}} cfg
   */
  constructor(actx, destination, cfg = {}) {
    this.actx = actx;
    this.cfg = { pitch: 3, wave: 'sawtooth', brightness: 1, ...cfg };
    const a = actx;

    this.out = a.createGain();
    this.out.gain.value = 0;
    this.panner = a.createStereoPanner ? a.createStereoPanner() : null;
    if (this.panner) {
      this.out.connect(this.panner);
      this.panner.connect(destination);
    } else {
      this.out.connect(destination);
    }

    // engine tone
    this.filter = a.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1.5;
    this.engGain = a.createGain();
    this.engGain.gain.value = 0;
    this.filter.connect(this.engGain);
    this.engGain.connect(this.out);

    this.o1 = a.createOscillator(); this.o1.type = this.cfg.wave;
    this.o2 = a.createOscillator(); this.o2.type = 'square';
    this.o3 = a.createOscillator(); this.o3.type = 'triangle';
    const g2 = a.createGain(); g2.gain.value = 0.3;
    const g3 = a.createGain(); g3.gain.value = 0.5;
    this.o1.connect(this.filter);
    this.o2.connect(g2); g2.connect(this.filter);
    this.o3.connect(g3); g3.connect(this.filter);

    // noise: wind + screech
    this.noise = a.createBufferSource();
    this.noise.buffer = getNoiseBuffer(a);
    this.noise.loop = true;
    const windF = a.createBiquadFilter(); windF.type = 'bandpass'; windF.frequency.value = 700; windF.Q.value = 0.6;
    this.windGain = a.createGain(); this.windGain.gain.value = 0;
    const screechF = a.createBiquadFilter(); screechF.type = 'bandpass'; screechF.frequency.value = 2400; screechF.Q.value = 6;
    this.screechGain = a.createGain(); this.screechGain.gain.value = 0;
    this.noise.connect(windF); windF.connect(this.windGain); this.windGain.connect(this.out);
    this.noise.connect(screechF); screechF.connect(this.screechGain); this.screechGain.connect(this.out);

    // horn
    this.h1 = a.createOscillator(); this.h1.type = 'square'; this.h1.frequency.value = 415;
    this.h2 = a.createOscillator(); this.h2.type = 'square'; this.h2.frequency.value = 523;
    this.hornGain = a.createGain(); this.hornGain.gain.value = 0;
    const hornF = a.createBiquadFilter(); hornF.type = 'lowpass'; hornF.frequency.value = 1800;
    this.h1.connect(hornF); this.h2.connect(hornF); hornF.connect(this.hornGain); this.hornGain.connect(this.out);

    for (const n of [this.o1, this.o2, this.o3, this.noise, this.h1, this.h2]) n.start();
    this._disposed = false;
  }

  setHorn(on) {
    if (this._disposed) return;
    this.hornGain.gain.setTargetAtTime(on ? 0.12 : 0, this.actx.currentTime, 0.02);
  }

  /**
   * @param {{rpm:number, redline:number, throttle:number, speed:number, slip:number,
   *          volume:number, pan:number, muffle:number}} p
   */
  update(p) {
    if (this._disposed) return;
    const t = this.actx.currentTime;
    const br = this.cfg.brightness;
    const f = Math.max(20, (p.rpm / 60) * this.cfg.pitch);
    this.o1.frequency.setTargetAtTime(f, t, 0.04);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.04);
    this.o3.frequency.setTargetAtTime(f * 2, t, 0.04);

    const load = Math.min(1, Math.max(0, p.throttle));
    const cutoff = (250 + (p.rpm / p.redline) * 1400 * br + load * 1600 * br) * p.muffle;
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.14 + 0.22 * load, t, 0.05);

    const sp = Math.abs(p.speed);
    this.windGain.gain.setTargetAtTime(Math.min(1, sp / 60) * 0.18, t, 0.1);
    const screech = sp > 3 ? Math.min(1, p.slip) * 0.14 : 0;
    this.screechGain.gain.setTargetAtTime(screech, t, 0.05);

    this.out.gain.setTargetAtTime(p.volume, t, 0.08);
    if (this.panner) this.panner.pan.setTargetAtTime(p.pan, t, 0.1);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const n of [this.o1, this.o2, this.o3, this.noise, this.h1, this.h2]) {
      try { n.stop(); } catch (e) { /* already stopped */ }
    }
    this.out.disconnect();
    if (this.panner) this.panner.disconnect();
  }
}
