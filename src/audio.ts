import { soundLevel, type SoundCategory } from "./sound-settings.js";

type CueOptions = {
  volume?: number;
  minGapMs?: number;
  rate?: [number, number];
};

const asset = (url: URL) => url.href;

const cues = {
  footstepsWalk: [
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneL1.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneR1.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneL2.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneR2.ogg", import.meta.url)),
  ],
  footstepsRun: [
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneL3.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/fantozzi-footsteps/Fantozzi-footsteps/ogg/Fantozzi-StoneR3.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/gbox-footsteps/01-footstep.ogg", import.meta.url)),
    asset(new URL("../assets/audio/footsteps/gbox-footsteps/02-footstep.ogg", import.meta.url)),
  ],
  boulderSettle: [
    asset(new URL("../assets/audio/boulders/breaking-falling-hit/bfh1_rock_hit_01.ogg", import.meta.url)),
    asset(new URL("../assets/audio/boulders/breaking-falling-hit/bfh1_rock_falling_01.ogg", import.meta.url)),
    asset(new URL("../assets/audio/boulders/breaking-falling-hit/bfh1_rock_falling_02.ogg", import.meta.url)),
  ],
  hog: [
    asset(new URL("../assets/audio/hogs/freesound-cc0-previews/hedgehog-smell-and-run_ffdown_570301_hq.mp3", import.meta.url)),
    asset(new URL("../assets/audio/hogs/freesound-cc0-previews/angry-hedgehog-sniffing-1_fthgurdy_528183_hq.mp3", import.meta.url)),
    asset(new URL("../assets/audio/hogs/freesound-cc0-previews/hedgehog-eating_tatratank_541421_hq.mp3", import.meta.url)),
  ],
  chatSend: [
    asset(new URL("../assets/audio/ui/kenney-ui-audio/Audio/click1.ogg", import.meta.url)),
    asset(new URL("../assets/audio/ui/kenney-ui-audio/Audio/click2.ogg", import.meta.url)),
  ],
  chatReceive: [asset(new URL("../assets/audio/ui/kenney-ui-audio/Audio/rollover2.ogg", import.meta.url))],
  command: [
    asset(new URL("../assets/audio/ui/kenney-ui-audio/Audio/switch1.ogg", import.meta.url)),
    asset(new URL("../assets/audio/ui/kenney-ui-audio/Audio/switch2.ogg", import.meta.url)),
  ],
  error: [asset(new URL("../assets/audio/ui/assorted-menu-level-up/Menu Error.mp3", import.meta.url))],
  ghost: [
    asset(new URL("../assets/audio/ghost/opengameart-ghost/ghost.wav", import.meta.url)),
    asset(new URL("../assets/audio/ghost/opengameart-ghost/qubodup-GhostMoans/mp3/qubodup-GhostMoan05.mp3", import.meta.url)),
  ],
};

/** Which Settings slider governs each cue — every cue belongs to exactly one. */
const CUE_CATEGORY: Record<keyof typeof cues, SoundCategory> = {
  footstepsWalk: "footsteps",
  footstepsRun: "footsteps",
  boulderSettle: "world",
  hog: "world",
  ghost: "world",
  chatSend: "interface",
  chatReceive: "interface",
  command: "interface",
  error: "interface",
};

class AudioCues {
  private lastPlayed = new Map<string, number>();
  private bases = new Map<string, HTMLAudioElement>();

  playFootstep(running: boolean) {
    this.play(running ? "footstepsRun" : "footstepsWalk", {
      volume: running ? 0.022 : 0.017,
      minGapMs: running ? 95 : 140,
      rate: running ? [1.04, 1.14] : [0.94, 1.04],
    });
  }

  /** How far world sounds carry, in tiles: beyond this they simply don't play. */
  static readonly EARSHOT = 14;

  /** Linear distance falloff for a world sound; <= 0 means out of earshot. */
  private static falloff(distance: number): number {
    return Math.max(0, 1 - distance / AudioCues.EARSHOT);
  }

  /** Another trogg's footstep nearby — the same stone strides, faded by distance. */
  playFootstepAt(running: boolean, distance: number) {
    const gain = AudioCues.falloff(distance);
    if (gain <= 0.02) return;
    this.play(running ? "footstepsRun" : "footstepsWalk", {
      volume: (running ? 0.017 : 0.013) * gain,
      minGapMs: 110,
      rate: running ? [1.04, 1.14] : [0.94, 1.04],
    });
  }

  /** A Hog stepping nearby: the little ones patter (small and quick), the 2×2
   *  giants thud (slow and deep) — the same strides, a different gait by pitch. */
  playHogStepAt(distance: number, size = 1) {
    const gain = AudioCues.falloff(distance);
    if (gain <= 0.02) return;
    if (size > 1) this.play("footstepsWalk", { volume: 0.025 * gain, minGapMs: 260, rate: [0.55, 0.68] });
    else this.play("footstepsWalk", { volume: 0.008 * gain, minGapMs: 150, rate: [1.7, 1.95] });
  }

  /** A boulder shoved or settling somewhere nearby. */
  playBoulderSettleAt(distance: number) {
    const gain = AudioCues.falloff(distance);
    if (gain <= 0.02) return;
    this.play("boulderSettle", { volume: 0.16 * gain, minGapMs: 120, rate: [0.86, 1.02] });
  }

  playBoulderSettle() {
    this.play("boulderSettle", { volume: 0.16, minGapMs: 120, rate: [0.86, 1.02] });
  }

  /** A Hog snuffling somewhere nearby — silent beyond earshot like every world sound. */
  playHogAt(distance: number) {
    const gain = AudioCues.falloff(distance);
    if (gain <= 0.02) return;
    this.play("hog", { volume: 0.08 * gain, minGapMs: 2200, rate: [0.92, 1.08] });
  }

  playChatSend() {
    this.play("chatSend", { volume: 0.14, minGapMs: 80, rate: [0.96, 1.04] });
  }

  playChatReceive() {
    this.play("chatReceive", { volume: 0.08, minGapMs: 120, rate: [0.98, 1.08] });
  }

  playCommand() {
    this.play("command", { volume: 0.12, minGapMs: 90, rate: [0.96, 1.06] });
  }

  playError() {
    this.play("error", { volume: 0.12, minGapMs: 120, rate: [0.98, 1.02] });
  }

  playGhost() {
    this.play("ghost", { volume: 0.12, minGapMs: 300, rate: [1.08, 1.22] });
  }

  private play(name: keyof typeof cues, options: CueOptions = {}) {
    const level = soundLevel(CUE_CATEGORY[name]);
    if (level <= 0) return;
    const urls = cues[name];
    const now = performance.now();
    const minGapMs = options.minGapMs ?? 0;
    if (now - (this.lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
    this.lastPlayed.set(name, now);

    const url = urls[Math.floor(Math.random() * urls.length)]!;
    const base = this.base(url);
    const sound = base.cloneNode(true) as HTMLAudioElement;
    sound.volume = Math.min(1, (options.volume ?? 0.2) * level);
    sound.playbackRate = randomBetween(options.rate ?? [1, 1]);
    void sound.play().catch(() => {
      // Browsers can reject before the first user gesture; the next cue will retry.
    });
  }

  private base(url: string) {
    let audio = this.bases.get(url);
    if (!audio) {
      audio = new Audio(url);
      audio.preload = "auto";
      this.bases.set(url, audio);
    }
    return audio;
  }
}

function randomBetween([min, max]: [number, number]) {
  return min + Math.random() * (max - min);
}


export const audio = new AudioCues();
