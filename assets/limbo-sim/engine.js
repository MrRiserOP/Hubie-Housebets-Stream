"use strict";
var LimboSim = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // packages/game-adapters/src/limboBrowser.ts
  var limboBrowser_exports = {};
  __export(limboBrowser_exports, {
    DEFAULT_SETTINGS: () => DEFAULT_SETTINGS,
    LimboEngine: () => LimboEngine,
    cryptoRng: () => cryptoRng,
    validateSettings: () => validateSettings
  });

  // config/limbo-sim.json
  var limbo_sim_default = {
    _readme: "Simulated Limbo \u2014 ENTERTAINMENT ONLY. These weights are NOT Housebets' odds, RTP or payout rules. Edit here or in the Control Center (section 3). Weights are relative (they don't need to add up to 100).",
    label: "Limbo",
    roundDelaySec: 8,
    currency: "demo credits",
    startingCredits: 1e3,
    betAmount: 10,
    targetMode: "auto",
    fixedTarget: 2,
    resultCap: 1e4,
    outcomes: [
      { id: "small_win", label: "small win", weight: 38, win: true, targets: [1.2, 1.5, 1.8, 2] },
      { id: "medium_win", label: "medium win", weight: 22, win: true, targets: [2.5, 3, 4, 5] },
      { id: "large_win", label: "large win", weight: 9, win: true, targets: [7, 10, 15, 20] },
      { id: "huge_win", label: "rare huge win", weight: 2, win: true, targets: [25, 50, 100] },
      { id: "loss", label: "loss", weight: 29, win: false, targets: [1.5, 2, 3, 5, 10] }
    ]
  };

  // packages/game-adapters/src/limboEngine.ts
  var cryptoRng = () => {
    const a = new Uint32Array(2);
    globalThis.crypto.getRandomValues(a);
    return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53;
  };
  var floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
  var round2 = (x) => Math.round(x * 100) / 100;
  function validateSettings(s) {
    const errs = [];
    if (!Array.isArray(s.outcomes) || !s.outcomes.length) errs.push("at least one outcome tier is required");
    const total = (s.outcomes ?? []).reduce((a, o) => a + (o.weight > 0 ? o.weight : 0), 0);
    if (total <= 0) errs.push("weights must add up to more than 0");
    if (!(s.outcomes ?? []).some((o) => !o.win && o.weight > 0)) errs.push("keep some losses (a loss tier with weight > 0) for suspense");
    for (const o of s.outcomes ?? []) {
      if (!(o.weight >= 0)) errs.push(`${o.id}: weight must be \u2265 0`);
      if (!o.targets?.length) errs.push(`${o.id}: needs at least one target`);
      for (const t of o.targets ?? []) if (!(t >= 1.01 && t <= 1e3)) errs.push(`${o.id}: target ${t} must be between 1.01x and 1000x`);
    }
    if (!(s.fixedTarget >= 1.01 && s.fixedTarget <= 1e3)) errs.push("fixed target must be between 1.01x and 1000x");
    if (!(s.betAmount > 0)) errs.push("bet amount must be > 0");
    if (!(s.roundDelaySec >= 2 && s.roundDelaySec <= 120)) errs.push("round delay must be 2\u2013120 s");
    if (!(s.resultCap >= 100)) errs.push("result cap must be \u2265 100");
    return errs;
  }
  function pickTier(tiers, rng, onlyWin) {
    const pool = tiers.filter((t) => t.weight > 0 && (onlyWin === void 0 || t.win === onlyWin));
    const total = pool.reduce((a, t) => a + t.weight, 0);
    let x = rng() * total;
    for (const t of pool) {
      if ((x -= t.weight) < 0) return t;
    }
    return pool[pool.length - 1];
  }
  function drawResult(target, win, cap, rng) {
    if (win) {
      const u = 1 - rng();
      return Math.min(cap, Math.max(target, floor2(target / u)));
    }
    const v = rng();
    const r = 1 / (1 - v * (1 - 1 / target));
    return Math.min(floor2(r), round2(target - 0.01));
  }
  var LimboEngine = class {
    constructor(settings, rng = cryptoRng, state) {
      __publicField(this, "settings", settings);
      __publicField(this, "rng", rng);
      __publicField(this, "roundNumber");
      __publicField(this, "balance");
      __publicField(this, "history", []);
      this.roundNumber = state?.roundNumber ?? 0;
      this.balance = state?.balance ?? settings.startingCredits;
      this.history = (state?.history ?? []).slice(-50);
    }
    /** The win chance implied by the current weights (shown in the UI instead of real odds). */
    winShare() {
      const pos = this.settings.outcomes.filter((o) => o.weight > 0);
      const total = pos.reduce((a, o) => a + o.weight, 0);
      return total ? pos.filter((o) => o.win).reduce((a, o) => a + o.weight, 0) / total : 0;
    }
    /** Chance this game gives a win when Hubie picks this target (from the configured weights). */
    winChanceFor(target) {
      if (this.settings.targetMode === "fixed") return this.winShare();
      let win = 0, all = 0;
      for (const o of this.settings.outcomes) {
        if (!(o.weight > 0) || !o.targets.some((t) => Math.abs(t - target) < 5e-3)) continue;
        const share = o.weight / o.targets.length;
        all += share;
        if (o.win) win += share;
      }
      return all ? win / all : this.winShare();
    }
    next() {
      const s = this.settings;
      let tier;
      let target;
      if (s.targetMode === "fixed") {
        const win = this.rng() < this.winShare();
        tier = pickTier(s.outcomes, this.rng, win);
        target = round2(s.fixedTarget);
      } else {
        tier = pickTier(s.outcomes, this.rng);
        target = round2(tier.targets[Math.floor(this.rng() * tier.targets.length)]);
      }
      const result = drawResult(target, tier.win, s.resultCap, this.rng);
      const outcome = result >= target ? "win" : "loss";
      const bet = Math.min(s.betAmount, Math.max(0, this.balance)) || s.betAmount;
      const payoutMultiplier = outcome === "win" ? target : 0;
      const payout = round2(bet * payoutMultiplier);
      const profit = round2(payout - bet);
      this.balance = round2(this.balance + profit);
      if (this.balance < bet) this.balance = s.startingCredits;
      this.roundNumber++;
      const r = {
        type: "limbo_round_complete",
        roundId: `limbo-${Date.now().toString(36)}-${this.roundNumber}`,
        roundNumber: this.roundNumber,
        tier: tier.id,
        targetMultiplier: target,
        resultMultiplier: result,
        outcome,
        payoutMultiplier,
        bet,
        payout,
        profit,
        balanceAfter: this.balance,
        simulated: true,
        at: Date.now()
      };
      this.history = [...this.history.slice(-49), r];
      return r;
    }
  };

  // packages/game-adapters/src/limboBrowser.ts
  var DEFAULT_SETTINGS = limbo_sim_default;
  return __toCommonJS(limboBrowser_exports);
})();
