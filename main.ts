// SLEUTH: model-free Werewolf agent for make.fun werewolf-agent-01.
// Node 22, standard library only. No model calls, no keys, no clock, no randomness.
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INFLIGHT = 10;
const MAX_CHARS = 500;
const ACCUSE = /(werewolf|wolf|suspicious|suspect|vote (him|her|them|seat|out)|exile|lynch|guilty)/i;
const DEFEND = /(trust|innocent|not a wolf|clear|believe him|believe her|defend)/i;
const CLAIM_SEER = /i'?m (the )?seer|i am the seer|i inspected/i;
const CLAIM_DOCTOR = /i'?m (the )?doctor/i;
const DEF_DONE = /(I voted to exile seat \d+ \([^)]*\), a werewolf, on day|I have voted from the record every day)/;

// ---------- small helpers ----------
const num = (x: any): number | null => {
  if (x == null) return null;
  if (typeof x === "object") return num(x.seat ?? x.id ?? x.target);
  if (typeof x === "string" && x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const hsh = (seed: string, game: any, day: number, seat: number, purpose: string) =>
  fnv1a(`${seed}:${game}:${day}:${seat}:${purpose}`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const len = (s: string) => Array.from(oneLine(s)).length;
const fold = (s: string, limit: number = MAX_CHARS) =>
  Array.from(oneLine(s)).slice(0, Math.max(1, limit)).join("");
const isWolfRole = (r: any) => /wolf/i.test(String(r ?? ""));
function best(opts: number[], score: (s: number) => number, tb: (s: number) => number): number | null {
  if (!opts.length) return null;
  return [...opts].sort((a, b) => score(b) - score(a) || tb(a) - tb(b) || a - b)[0];
}
function resWolf(e: any): boolean {
  for (const k of ["isWerewolf", "werewolf", "isWolf", "is_wolf", "wolf"]) if (typeof e[k] === "boolean") return e[k];
  const r = String(e.result ?? e.role ?? "");
  return /wolf/i.test(r) && !/not/i.test(r);
}

// ---------- speech templates ----------
// Every argument named x, y, z, v, w, a, p(artner), d is a ready-made "seat N (Name)" label.
// Reasons (rA..rN) are predicates, so a sentence names its subject exactly once.
export const T = {
  seerClaim: (x: string, y: string | null) =>
    `I am the seer. Last night I inspected ${x}: a werewolf.${y ? ` I also cleared ${y}.` : ""} Vote ${x} today. If I am wrong, exile me tomorrow.`,
  trust: (y: string) => `I trust ${y}'s vote.`,
  fakeSeer: (v: string) => `I am the seer. I inspected ${v}: a werewolf. Vote ${v} today.`,
  rA: (v: string) => `voted to exile ${v}, a villager`,
  rB: (w: string) => `defended ${w}, a werewolf`,
  rC: (w: string, v: string) => `voted with ${w}, a werewolf, against ${v}`,
  rD: () => `passed or said nothing while villagers died`,
  rE: (v: string) => `pushed ${v} and got it wrong`,
  rN: () => `stood out in the record so far`,
  accuse1: [
    (x: string, p: string) => `I suspect ${x}: they ${p}.`,
    (x: string, p: string) => `My top suspect is ${x}, who ${p}.`,
    (x: string, p: string) => `Look at ${x}, who ${p}.`,
  ],
  accuse2: [
    (x: string, p: string, e: string) => `Again: vote ${x}, who ${p}. ${e}`,
    (x: string, p: string, e: string) => `I am still on ${x}, who ${p}. Vote them today. ${e}`,
    (x: string, p: string, e: string) => `Vote ${x} today. They ${p}. ${e}`,
  ],
  agree: (a: string) => `${a} also pointed at them.`,
  death: (d: string) => `${d} died last night.`,
  none: () => `The record backs this up.`,
  defendWolf: (w: string, day: number) => `I voted to exile ${w}, a werewolf, on day ${day}.`,
  defendGeneric: () => `I have voted from the record every day.`,
  counter: (a: string, p: string) => `${a} is accusing me, but they ${p}.`,
  partner: (q: string, day: number) => `${q} voted the same way I did on day ${day}.`,
};

// ---------- view parsing (rebuilt from scratch on every decision) ----------
function parse(view: any) {
  const names = new Map<number, string>();
  const alive = new Set<number>();
  const revealed = new Map<number, string>();
  for (const p of view.players ?? []) {
    const s = num(p.seat);
    if (s == null) continue;
    names.set(s, String(p.name ?? `P${s}`));
    if (p.alive === false) {
      if (p.role) revealed.set(s, String(p.role).toLowerCase());
    } else alive.add(s);
  }
  const votes: any[] = [], speeches: any[] = [], passes: any[] = [], deaths: any[] = [], exiles: any[] = [];
  const revealAt = new Map<number, number>();
  const spoke = new Map<string, number>();
  let day = 0;
  const parseSpeech = (text: string, speaker: number) => {
    const mentions: { target: number; kind: string }[] = [];
    const named: number[] = [];
    for (const sent of text.split(/[.!?;]+/)) {
      const seats = new Set<number>();
      for (const m of sent.matchAll(/seat\s+(\d+)/gi)) seats.add(Number(m[1]));
      const low = sent.toLowerCase();
      for (const [s, n] of names) {
        const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (esc && new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(low)) seats.add(s);
      }
      seats.delete(speaker);
      const kind = DEFEND.test(sent) ? "defend" : ACCUSE.test(sent) ? "accuse" : "";
      if (kind) for (const s of seats) if (names.has(s)) mentions.push({ target: s, kind });
    }
    for (const m of text.matchAll(/seat\s+(\d+)(?:\s*\([^)]*\))?\s*[:,-]?\s*(?:is\s+)?(?:a\s+)?werewolf/gi)) {
      const s = Number(m[1]);
      if (s !== speaker) named.push(s);
    }
    return { mentions, named };
  };
  (view.log ?? []).forEach((e: any, i: number) => {
    const t = String(e.kind ?? e.type ?? e.event ?? "").toLowerCase();
    const who = num(e.seat ?? e.speaker ?? e.player ?? e.voter);
    if (t.includes("exile")) {
      const s = num(e.seat ?? e.exiled ?? e.target ?? e.died);
      if (s != null) {
        exiles.push({ seat: s, day: num(e.day) ?? day, i });
        if (e.role) revealed.set(s, String(e.role).toLowerCase());
        if (!revealAt.has(s)) revealAt.set(s, i);
      }
    } else if (t.includes("vote")) {
      if (who != null) votes.push({ seat: who, target: num(e.target ?? e.vote ?? e.for), day: num(e.day) ?? day, i });
    } else if (t.includes("pass")) {
      if (who != null) passes.push({ seat: who, day: num(e.day) ?? day, i });
    } else if (/dawn|death|night|kill|victim|morning/.test(t) || "died" in e) {
      day = num(e.day) ?? day + 1;
      const list = Array.isArray(e.died) ? e.died : [e.died ?? e.victim ?? e.dead];
      for (const x of list) {
        const v = num(x);
        if (v == null) continue;
        deaths.push({ seat: v, day, i, kind: "night" });
        if (e.role) revealed.set(v, String(e.role).toLowerCase());
        if (!revealAt.has(v)) revealAt.set(v, i);
      }
    } else if (/speech|statement|speak|say|debate|chat/.test(t) || (e.text && who != null)) {
      if (who == null) return;
      const d = num(e.day) ?? day;
      const k = `${d}:${who}`;
      const round = num(e.round) ?? (spoke.get(k) ?? 0) + 1;
      spoke.set(k, (spoke.get(k) ?? 0) + 1);
      const text = String(e.text ?? e.statement ?? e.message ?? "");
      const { mentions, named } = parseSpeech(text, who);
      speeches.push({
        seat: who, day: d, round, text, i, mentions, named,
        claimSeer: CLAIM_SEER.test(text), claimDoc: CLAIM_DOCTOR.test(text),
      });
    }
  });
  return { names, alive, revealed, revealAt, votes, speeches, passes, deaths, exiles, day: num(view.day) ?? day };
}

function scores(info: any, me: number, role: string, view: any) {
  const { revealed, revealAt, votes, speeches, passes, deaths, alive } = info;
  const pub = new Map<number, number>();
  for (const s of alive) if (s !== me) pub.set(s, 0);
  const add = (s: number | null, d: number) => {
    if (s != null && pub.has(s)) pub.set(s, (pub.get(s) as number) + d);
  };
  const rl = (s: number) => revealed.get(s);
  const isW = (s: number) => isWolfRole(rl(s));
  const isV = (s: number) => rl(s) === "villager";
  const isSD = (s: number) => /seer|doctor/.test(rl(s) ?? "");
  const hunters = new Set<number>();
  for (const v of votes) {
    const t = v.target;
    if (t == null) continue;
    if (isW(t)) { add(v.seat, -4); hunters.add(v.seat); }
    else if (isV(t)) add(v.seat, 2);
    else if (isSD(t)) add(v.seat, 3);
    if (votes.some((w: any) => w !== v && w.day === v.day && w.target === t && isW(w.seat))) add(v.seat, 1);
  }
  for (const sp of speeches) {
    for (const m of sp.mentions) {
      const t = m.target;
      if (m.kind === "accuse") {
        if (isW(t) && sp.i < (revealAt.get(t) ?? -1)) { add(sp.seat, -3); hunters.add(sp.seat); }
        else if (isV(t)) add(sp.seat, 1);
        if (isW(sp.seat)) add(t, -2);
        if (deaths.some((d: any) => d.seat === sp.seat && d.kind === "night" && d.i > sp.i)) add(t, 1.5);
      } else {
        if (isW(t)) add(sp.seat, 4);
        else if (isV(t)) add(sp.seat, -1);
        if (isW(sp.seat)) add(t, 2);
      }
    }
    if (sp.claimSeer) {
      for (const t of sp.named) {
        if (isW(t)) add(sp.seat, -6);
        else if (revealed.has(t)) add(sp.seat, 6);
      }
    }
  }
  for (const p of passes) add(p.seat, 0.5);
  const claimers = new Set<number>(speeches.filter((s: any) => s.claimSeer).map((s: any) => s.seat));
  const fin = new Map(pub);
  const add2 = (s: number | null, d: number) => {
    if (s != null && fin.has(s)) fin.set(s, (fin.get(s) as number) + d);
  };
  if (role === "seer") {
    for (const c of claimers) if (c !== me) add2(c, 6);
    for (const e of view.seerResults ?? []) {
      const s = num(e.seat ?? e.target);
      if (s != null && fin.has(s)) fin.set(s, resWolf(e) ? 100 : -100);
    }
  }
  const partner = num(view.you?.partner);
  if (role === "werewolf" && partner != null && fin.has(partner)) fin.set(partner, -100);
  return { pub, fin, hunters, claimers };
}

// ---------- decisions ----------
function decide(view: any, dec: any, seed: string): any {
  const type = String(dec.decision ?? dec.kind ?? dec.type ?? "").toLowerCase();
  const game = dec.game ?? view.game ?? 0;
  const opts = (dec.options ?? view.options ?? []).map((o: any) => num(o)).filter((n: any) => n != null) as number[];
  const me = num(view.you?.seat) as number;
  const role = String(view.you?.role ?? "").toLowerCase();
  const partner = num(view.you?.partner);
  const maxChars = Math.min(MAX_CHARS, num(dec.max_chars) ?? MAX_CHARS);
  const info = parse(view);
  const sc = scores(info, me, role, view);
  const ctx = { dec, view, opts, me, role, partner, info, sc, seed, game, maxChars };
  let out: any;
  if (/kill/.test(type)) out = { target: kill(ctx) };
  else if (/protect/.test(type)) out = { target: protect(ctx) };
  else if (/inspect/.test(type)) out = { target: inspect(ctx) };
  else if (/vote/.test(type)) out = { target: vote(ctx) };
  else if (/speak|speech|statement|debate|say/.test(type)) {
    const text = speak(ctx);
    out = text ? { text } : { pass: true };
  } else out = { pass: true };
  // final guard: never send a target the env did not offer
  if ("target" in out) {
    const t = out.target;
    out = { target: t != null && opts.includes(t) ? t : null };
  }
  return out;
}
export { decide };

function kill(c: any): number | null {
  const { opts, view, partner, info, sc, me, seed, game } = c;
  const mine = (view.wolfVotes ?? [])
    .filter((v: any) => num(v.seat ?? v.wolf) === partner && num(v.target) != null)
    .map((v: any) => num(v.target) as number);
  if (mine.length && opts.includes(mine[mine.length - 1])) return mine[mine.length - 1];
  const night = info.day + 1;
  const acc = (t: number) => new Set(info.speeches.filter((s: any) => s.mentions.some((m: any) => m.kind === "accuse" && m.target === t)).map((s: any) => s.seat));
  const heat = (t: number) =>
    info.speeches.filter((s: any) => s.seat === t && s.mentions.some((m: any) => m.kind === "accuse" && info.revealed.has(m.target) && isWolfRole(info.revealed.get(m.target)))).length +
    info.votes.filter((v: any) => v.seat === t && isWolfRole(info.revealed.get(v.target))).length;
  const pool = opts.filter((s: number) => s !== partner);
  const maxHeat = Math.max(0, ...pool.map(heat));
  const pri = (t: number) => {
    let p = 0;
    if (sc.claimers.has(t)) p += 10;
    if (sc.hunters.has(t)) p += 6;
    if (info.speeches.some((s: any) => s.seat === t && s.mentions.some((m: any) => m.kind === "accuse" && (m.target === me || m.target === partner)))) p += 4;
    if (maxHeat > 0 && heat(t) === maxHeat) p += 3;
    if (acc(t).size >= 2) p -= 5;
    return p;
  };
  return best(pool.length ? pool : opts, pri, (s) => hsh(seed, game, night, s, "kill"));
}

function protect(c: any): number | null {
  const { opts, info, sc, seed, game } = c;
  const night = info.day + 1;
  const credible = (s: number) => (sc.pub.get(s) ?? 0) < 3;
  const flagged = new Set<number>();
  for (const sp of info.speeches) if (sp.claimSeer && credible(sp.seat)) for (const t of sp.named) flagged.add(t);
  const pool = opts.filter((s: number) => !flagged.has(s));
  const pri = (t: number) => {
    let p = 0;
    if (sc.claimers.has(t)) p += 10;
    if (sc.hunters.has(t)) p += 6;
    if (info.speeches.some((s: any) => s.seat === t && s.mentions.some((m: any) => m.kind === "accuse" && isWolfRole(info.revealed.get(m.target))))) p += 4;
    if ((sc.pub.get(t) ?? 0) < 0) p += 3;
    return p;
  };
  return best(pool.length ? pool : opts, pri, (s) => hsh(seed, game, night, s, "protect"));
}

function inspect(c: any): number | null {
  const { opts, view, info, sc, seed, game } = c;
  const night = info.day + 1;
  const done = new Set<number>((view.seerResults ?? []).map((e: any) => num(e.seat ?? e.target)).filter((n: any) => n != null));
  const fresh = opts.filter((s: number) => !done.has(s));
  const pool = fresh.length ? fresh : opts;
  const claimers = pool.filter((s: number) => sc.claimers.has(s));
  const tb = (s: number) => hsh(seed, game, night, s, "inspect");
  if (claimers.length) return best(claimers, () => 0, tb);
  return best(pool, (s) => sc.fin.get(s) ?? 0, tb);
}

function vote(c: any): number | null {
  const { opts, role, info, partner, sc, seed, game } = c;
  const tally = new Map<number, number>();
  for (const v of info.votes) if (v.day === info.day && v.target != null) tally.set(v.target, (tally.get(v.target) ?? 0) + 1);
  const tb = (s: number) => hsh(seed, game, info.day, s, "vote");
  if (role === "werewolf") {
    const pool = opts.filter((s: number) => s !== partner);
    if (!pool.length) return null;
    const hot = pool.filter((s: number) => (tally.get(s) ?? 0) > 0);
    if (hot.length) return best(hot, (s) => tally.get(s) as number, tb);
    return best(pool, (s) => sc.pub.get(s) ?? 0, tb);
  }
  const score = (s: number) => sc.fin.get(s) ?? 0;
  const live = opts.filter((s: number) => score(s) > -100);
  if (!live.length) return null;
  const top = best(live, score, tb) as number;
  if (score(top) >= 100) return top;
  const wolvesLeft = 2 - [...info.revealed.values()].filter((r: any) => isWolfRole(r)).length;
  const livingN = info.alive.size;
  const endgame = livingN <= 5 || wolvesLeft >= livingN - wolvesLeft - 1;
  if (endgame) return top;
  const maxAll = Math.max(0, ...[...tally.values()]);
  if ((tally.get(top) ?? 0) > 0 && (tally.get(top) as number) === maxAll) return top;
  const near = live.filter((s: number) => score(s) >= score(top) - 3 && (tally.get(s) ?? 0) >= 2);
  if (near.length) return best(near, (s) => tally.get(s) as number, tb);
  return top;
}

function speak(c: any): string {
  const { dec, view, me, role, partner, info, sc, seed, game, maxChars } = c;
  const day = info.day;
  const L = (s: number) => `seat ${s} (${info.names.get(s) ?? "?"})`;
  const isW = (s: number) => isWolfRole(info.revealed.get(s));
  const isV = (s: number) => info.revealed.get(s) === "villager";
  const mine = info.speeches.filter((s: any) => s.seat === me && s.day === day);
  const round = Math.min(2, num(dec.round) ?? mine.length + 1);
  const h = hsh(seed, game, day, me, `speak${round}`);
  const pick = (a: any[]) => a[h % a.length];

  // seer with a known wolf: ONE fixed claim, identical in both rounds. It is built only from
  // the seer results, the living seats, the seed and the game number (nothing round-dependent).
  const results = (view.seerResults ?? []).filter((e: any) => info.alive.has(num(e.seat ?? e.target) as number));
  if (role === "seer") {
    const wolves = results.filter(resWolf).map((e: any) => num(e.seat ?? e.target) as number).sort((a: number, b: number) => a - b);
    if (wolves.length) {
      const cleared = results.filter((e: any) => !resWolf(e)).map((e: any) => num(e.seat ?? e.target) as number)
        .sort((a: number, b: number) => hsh(seed, game, 0, a, "cleared") - hsh(seed, game, 0, b, "cleared") || a - b);
      return fold(T.seerClaim(L(wolves[0]), cleared.length ? L(cleared[0]) : null), maxChars);
    }
  }

  // predicate explaining why seat t is suspicious (no subject; the template names the seat)
  const reason = (t: number): string => {
    for (const v of info.votes) if (v.seat === t && v.target != null && isV(v.target)) return T.rA(L(v.target));
    for (const s of info.speeches) for (const m of s.mentions) if (s.seat === t && m.kind === "defend" && isW(m.target)) return T.rB(L(m.target));
    for (const v of info.votes) {
      if (v.seat !== t || v.target == null || !isV(v.target)) continue;
      const w = info.votes.find((x: any) => x.seat !== t && x.day === v.day && x.target === v.target && isW(x.seat));
      if (w) return T.rC(L(w.seat), L(v.target));
    }
    const nightDeaths = info.deaths.filter((d: any) => d.kind === "night").length;
    if (info.passes.some((p: any) => p.seat === t) || (nightDeaths > 0 && !info.speeches.some((s: any) => s.seat === t))) return T.rD();
    for (const s of info.speeches) for (const m of s.mentions) if (s.seat === t && m.kind === "accuse" && isV(m.target)) return T.rE(L(m.target));
    return T.rN();
  };
  const accusersOf = (t: number) => [...new Set<number>(info.speeches
    .filter((s: any) => s.day === day && s.seat !== me && s.mentions.some((m: any) => m.kind === "accuse" && m.target === t))
    .map((s: any) => s.seat))].sort((a, b) => a - b);

  // choose the target
  let target: number | null = null;
  const parts: string[] = [];
  const others = [...info.alive].filter((s: number) => s !== me);
  if (role === "werewolf") {
    const pool = others.filter((s: number) => s !== partner);
    const tb = (s: number) => hsh(seed, game, day, s, "speak");
    const pushed = best(pool.filter((s: number) => accusersOf(s).length >= 2), (s) => accusersOf(s).length, tb);
    target = pushed ?? best(pool, (s) => sc.pub.get(s) ?? 0, tb);
    const heat = partner != null ? accusersOf(partner).length : 0;
    if (target != null && heat >= 3 && round === 2 && day >= 2) return fold(T.fakeSeer(L(target)), maxChars);
    if (target != null && partner != null && heat >= 1) {
      const d = info.votes.find((v: any) => v.seat === me && v.target != null && info.votes.some((w: any) => w.seat === partner && w.day === v.day && w.target === v.target));
      if (d) parts.push(T.partner(L(partner), d.day));
    }
  } else {
    const live = others.filter((s: number) => (sc.fin.get(s) ?? 0) > -100);
    target = best(live, (s) => sc.fin.get(s) ?? 0, (s) => hsh(seed, game, day, s, "speak"));
    if (role === "seer") {
      const y = results.filter((e: any) => !resWolf(e)).map((e: any) => num(e.seat ?? e.target) as number).sort((a: number, b: number) => a - b)[0];
      if (y != null) parts.push(T.trust(L(y)));
    }
  }
  if (target == null) return "";

  // defend once if accused today, then counter-accuse
  const accusers = accusersOf(me);
  let lead = "";
  if (accusers.length && !mine.some((s: any) => DEF_DONE.test(s.text))) {
    const w = info.votes.find((v: any) => v.seat === me && v.target != null && isW(v.target));
    lead = w ? T.defendWolf(L(w.target), w.day) : T.defendGeneric();
    const a = accusers.find((s: number) => s !== partner && (sc.pub.get(s) ?? 0) > 0);
    if (a != null) lead += " " + T.counter(L(a), reason(a));
  }
  const p = reason(target);
  let body: string;
  if (round === 1) body = pick(T.accuse1)(L(target), p);
  else {
    const ag = accusersOf(target)[0];
    const lastNight = info.deaths.filter((d: any) => d.kind === "night" && d.day === day).map((d: any) => d.seat)[0];
    const extra = ag != null ? T.agree(L(ag)) : lastNight != null ? T.death(L(lastNight)) : T.none();
    body = pick(T.accuse2)(L(target), p, extra);
  }
  // the accusation (which names the target) must always survive: drop optional pieces before truncating
  const options = [[lead, body, ...parts], [lead, body], [body, ...parts], [body]].map((a) => a.filter(Boolean).join(" "));
  const fit = options.find((o) => len(o) <= maxChars);
  return fold(fit ?? body, maxChars);
}

// ---------- env loop ----------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function post(base: string, p: string, body: any) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j: any = null;
  try { j = await r.json(); } catch { j = null; }
  return { ok: r.ok, status: r.status, json: j };
}
async function answer(base: string, p: any, seed: string, stats: any) {
  const head = { game: p.game, decision: p.decision };
  let body: any;
  try {
    const out = decide(p.view ?? p, p, seed);
    body = out.text != null ? { ...head, text: out.text } : out.target != null ? { ...head, target: out.target } : { ...head, pass: true };
  } catch {
    body = { ...head, pass: true };
  }
  stats.decisions++;
  let ok = false;
  try { ok = (await post(base, "/act", body)).ok; } catch { ok = false; }
  if (!ok && !body.pass) {
    stats.fallbacks++;
    try { await post(base, "/act", { ...head, pass: true }); } catch { /* nothing more to do */ }
  }
}
export async function run() {
  const base = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("MAKEFUN_ENV_URL is needed");
  const seed = process.env.MAKEFUN_TRIAL_SEED ?? "0";
  const started = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const stats = { decisions: 0, fallbacks: 0 };
  for (;;) {
    const o = await post(base, "/observe", {});
    if (!o.ok) throw new Error(`observe failed: HTTP ${o.status}`);
    const obs = o.json ?? {};
    if (obs.done === true || obs.status === "done") break;
    const pending: any[] = obs.pending ?? obs.decisions ?? obs.requests ?? [];
    let fresh = 0;
    for (const p of pending) {
      if (inflight.size >= MAX_INFLIGHT) break;
      const key = `${p.game}:${p.decision}:${(p.view ?? p).log?.length ?? 0}`;
      if (started.has(key)) continue;
      started.add(key);
      fresh++;
      const job: Promise<void> = answer(base, p, seed, stats).finally(() => { inflight.delete(job); });
      inflight.add(job);
    }
    if (!fresh) await (inflight.size ? Promise.race([...inflight, sleep(25)]) : sleep(25));
  }
  await Promise.all([...inflight]);
  console.log(`done: ${stats.decisions} decisions, ${stats.fallbacks} fallbacks`);
}
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().then(
    () => process.exit(0),
    (e) => { console.error(String(e?.message ?? e)); process.exit(1); },
  );
}
