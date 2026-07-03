/**
 * The game theme, composed in code (nothing else in this project ships modelled
 * assets either): a slow generative ambient — two detuned pads breathing under
 * sparse pentatonic plucks with a feedback-delay tail. WebAudio starts suspended
 * until the first user gesture; `start` retries quietly until then.
 */
class GameTheme {
  private ctx?: AudioContext;
  private armed = false;
  private started = false;

  start(): void {
    if (this.armed) return;
    this.armed = true;
    const boot = () => {
      if (this.started) return;
      try {
        this.ctx ??= new AudioContext();
      } catch {
        return; // no WebAudio — the world just plays silent
      }
      // resume() resolves asynchronously — a synchronous state check right after
      // still reads "suspended" even inside a real user gesture and never starts
      void this.ctx.resume().then(() => {
        if (this.started || this.ctx!.state !== "running") return;
        this.started = true;
        this.compose(this.ctx!);
        window.removeEventListener("pointerdown", boot);
        window.removeEventListener("keydown", boot);
      }).catch(() => {});
    };
    window.addEventListener("pointerdown", boot);
    window.addEventListener("keydown", boot);
    boot();
  }

  private compose(ctx: AudioContext): void {
    const master = ctx.createGain();
    // fade in over a few seconds: crossing from the landing page into the game
    // restarts the generative stream, and the slow swell makes that seamless
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.085, ctx.currentTime + 3.5);
    master.connect(ctx.destination);

    // a soft echo bed for the plucks
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.42;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.36;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(master);

    // two detuned pads breathing a slow root drone
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 320;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.16;
    padFilter.connect(padGain).connect(master);
    for (const detune of [-5, 4]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 110; // A2
      osc.detune.value = detune;
      osc.connect(padFilter);
      osc.start();
    }
    const breathe = ctx.createOscillator();
    breathe.frequency.value = 0.05;
    const breatheDepth = ctx.createGain();
    breatheDepth.gain.value = 0.06;
    breathe.connect(breatheDepth).connect(padGain.gain);
    breathe.start();

    // sparse pentatonic plucks (A minor pentatonic around A3–A4)
    const scale = [220, 261.63, 293.66, 329.63, 392, 440];
    const pluck = () => {
      if (ctx.state !== "running") {
        window.setTimeout(pluck, 2000);
        return;
      }
      const note = scale[Math.floor(Math.random() * scale.length)]!;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = note * (Math.random() < 0.2 ? 0.5 : 1);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, ctx.currentTime);
      env.gain.linearRampToValueAtTime(0.5 + Math.random() * 0.25, ctx.currentTime + 0.015);
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.6);
      osc.connect(env);
      env.connect(master);
      env.connect(delay);
      osc.start();
      osc.stop(ctx.currentTime + 1.8);
      window.setTimeout(pluck, 1200 + Math.random() * 2600);
    };
    window.setTimeout(pluck, 1500);
  }
}

export const theme = new GameTheme();
