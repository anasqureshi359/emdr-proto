// Sound: the alternating tone of a bilateral set, and a quiet ambient bed for each scene.
// Everything is made here with Web Audio; no sound files are loaded.
// Nothing in this file waits on a reply from the browser.

export function createAudio({ onProblem }) {
  let ctx = null;
  let master = null;
  let stimGain = null;
  let ambGain = null;
  let ambient = null;
  let live = [];
  const report = (text) => { try { onProblem(text); } catch (e) { /* ignore */ } };

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      stimGain = ctx.createGain();
      stimGain.gain.value = 0;
      stimGain.connect(master);
      ambGain = ctx.createGain();
      ambGain.gain.value = 0;
      ambGain.connect(master);
      return true;
    } catch (e) {
      report('audio unavailable: ' + String((e && e.message) || e));
      ctx = null;
      return false;
    }
  }

  /** Call from a button press: browsers only start audio after a user action. */
  function unlock() {
    if (!ensure()) return;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }

  /** Delay between scheduling a sound and hearing it, in ms (56 ms on the Quest 3). */
  function latencyMs() {
    if (!ctx) return 0;
    const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    return (out + base) * 1000;
  }

  /**
   * Schedule one soft chime to be heard `inMs` from now on one side (-1 left, +1 right).
   * It is scheduled early by the output delay. Returns how late it will be heard, in ms
   * (0 when there was enough notice).
   */
  function chime(inMs, side) {
    if (!ctx || ctx.state !== 'running') return null;
    const lead = inMs - latencyMs();
    const late = lead < 0 ? -lead : 0;
    const t = ctx.currentTime + Math.max(0, lead) / 1000;
    try {
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      const o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = 294; // a low, soft tone
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = 588;
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      o1.connect(env);
      o2.connect(g2);
      g2.connect(env);
      if (pan) { pan.pan.value = side > 0 ? 0.85 : -0.85; env.connect(pan); pan.connect(stimGain); } else env.connect(stimGain);
      o1.start(t); o2.start(t);
      o1.stop(t + 0.75); o2.stop(t + 0.75);
      const entry = { nodes: [o1, o2], end: t + 0.8 };
      live.push(entry);
      live = live.filter((e) => e.end > ctx.currentTime);
    } catch (e) {
      report('tone failed: ' + String((e && e.message) || e));
      return null;
    }
    return late;
  }

  function stimOn() {
    if (!ctx) return;
    const t = ctx.currentTime;
    stimGain.gain.cancelScheduledValues(t);
    stimGain.gain.setValueAtTime(1, t);
  }

  /** Silence the tone at once, including chimes already scheduled. */
  function stimOff() {
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      stimGain.gain.cancelScheduledValues(t);
      stimGain.gain.setValueAtTime(stimGain.gain.value, t);
      stimGain.gain.linearRampToValueAtTime(0, t + 0.015);
      for (const e of live) for (const n of e.nodes) { try { n.stop(t + 0.02); } catch (err) { /* already stopped */ } }
      live = [];
    } catch (e) { /* ignore */ }
  }

  function noiseBuffer(seconds) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02; // brown-ish: soft, no hiss
        d[i] = last * 3.2;
      }
      // cross-fade the ends so the loop has no click
      const f = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * k + d[n - f + i] * (1 - k); }
    }
    return buf;
  }

  /** Start the ambient bed for a scene ('lake' or 'room'), or stop it with null. */
  function setAmbient(scene) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (ambient) {
      // scene audio stops quickly; a grounding exit must not leave it playing
      try {
        ambGain.gain.cancelScheduledValues(t);
        ambGain.gain.setValueAtTime(ambGain.gain.value, t);
        ambGain.gain.linearRampToValueAtTime(0, t + 0.06);
        for (const n of ambient.nodes) { try { n.stop(t + 0.1); } catch (err) { /* ignore */ } }
      } catch (e) { /* ignore */ }
      ambient = null;
    }
    if (!scene || ctx.state !== 'running') return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(4);
      src.loop = true;
      const nodes = [src];
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      const body = ctx.createGain();
      src.connect(lp);
      lp.connect(body);
      body.connect(ambGain);
      if (scene === 'lake') {
        lp.frequency.value = 520;
        body.gain.value = 0.5;
        // water lapping: a slow swell in loudness
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.17;
        const depth = ctx.createGain();
        depth.gain.value = 0.28;
        lfo.connect(depth);
        depth.connect(body.gain);
        lfo.start(t);
        nodes.push(lfo);
        // light wind: a second, thinner band
        const src2 = ctx.createBufferSource();
        src2.buffer = src.buffer;
        src2.loop = true;
        src2.playbackRate.value = 1.7;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 900;
        bp.Q.value = 0.6;
        const wind = ctx.createGain();
        wind.gain.value = 0.1;
        src2.connect(bp); bp.connect(wind); wind.connect(ambGain);
        src2.start(t);
        nodes.push(src2);
      } else {
        lp.frequency.value = 170; // near-silence: a soft room tone
        body.gain.value = 0.22;
      }
      src.start(t);
      ambGain.gain.cancelScheduledValues(t);
      ambGain.gain.setValueAtTime(0, t + 0.11);
      ambGain.gain.linearRampToValueAtTime(scene === 'lake' ? 0.16 : 0.1, t + 1.6);
      ambient = { scene, nodes };
    } catch (e) {
      report('ambient sound failed: ' + String((e && e.message) || e));
    }
  }

  /** Mute everything while the user cannot see the session; unmute on return. */
  function setHidden(hidden) {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(hidden ? 0 : 1, t + 0.03);
  }

  function allOff() {
    stimOff();
    setAmbient(null);
  }

  return {
    unlock, chime, stimOn, stimOff, setAmbient, setHidden, allOff, latencyMs,
    get running() { return !!ctx && ctx.state === 'running'; },
    get ambient() { return ambient ? ambient.scene : null; },
  };
}
