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
  itemStone: [
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_stone_01.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_stone_02.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_stone_03.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_stone_04.ogg", import.meta.url)),
  ],
  itemWood: [
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_wood_01.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_wood_02.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_wood_03.ogg", import.meta.url)),
  ],
  itemMisc: [
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_01.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_02.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_03.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_04.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_05.ogg", import.meta.url)),
    asset(new URL("../assets/audio/future/mining/cc0-rpg-sfx/item_misc_06.ogg", import.meta.url)),
  ],
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
  ghost: "world",
  chatSend: "interface",
  chatReceive: "interface",
  command: "interface",
  error: "interface",
  itemStone: "interface",
  itemWood: "interface",
  itemMisc: "interface",
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

  /** A boulder shoved or settling somewhere nearby. */
  playBoulderSettleAt(distance: number) {
    const gain = AudioCues.falloff(distance);
    if (gain <= 0.02) return;
    this.play("boulderSettle", { volume: 0.16 * gain, minGapMs: 120, rate: [0.86, 1.02] });
  }

  playBoulderSettle() {
    this.play("boulderSettle", { volume: 0.16, minGapMs: 120, rate: [0.86, 1.02] });
  }

  /** Stone rattles, wood knocks, and other collected items land with a soft thump. */
  playPickup(item: string) {
    const cue = item === "stone" ? "itemStone" : item === "wood" ? "itemWood" : "itemMisc";
    this.play(cue, { volume: 0.16, minGapMs: 90, rate: [0.96, 1.08] });
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
