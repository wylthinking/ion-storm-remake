/**
 * 音效引擎（从 app.ts 拆出的第一个模块，S0 地基）。
 *
 * 没有任何 DOM / 应用状态依赖：开关状态只读写 localStorage 的 ionStormAudio，
 * 播放走一次性 AudioContext 振荡器。所以可以整块搬走，行为与原来逐字一致。
 */

export function createAudio() {
  let ctx: AudioContext | undefined;
  let lastTick = 0;
  return {
    enabled: localStorage.getItem("ionStormAudio") !== "0",
    play(name: "click" | "react" | "deal" | "tick" | "win" | "start") {
      if (!this.enabled) return;
      if (name === "tick" && Date.now() - lastTick < 900) return;
      if (name === "tick") lastTick = Date.now();
      ctx ??= new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const freq = { click: 360, react: 520, deal: 240, tick: 780, win: 660, start: 440 }[name];
      osc.frequency.value = freq;
      osc.type = name === "react" ? "sawtooth" : "sine";
      gain.gain.value = 0.001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(name === "tick" ? 0.035 : 0.06, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (name === "win" ? 0.42 : 0.16));
      osc.stop(ctx.currentTime + (name === "win" ? 0.45 : 0.18));
    },
  };
}

/** 全应用共用的音效单例（原来在 app.ts 里写成 `const audio = createAudio();`）。 */
export const audio = createAudio();
