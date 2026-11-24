/**
 * The simulation engine. Pure JavaScript (no Foundry), so it can run thousands of battles quickly.
 *
 * Rules modelled (Fabula Ultima core):
 * - Initiative: the heroes' leader rolls DEX + INS + their Initiative against the foes' highest Initiative.
 * - Rounds alternate one turn per side, starting with the side that has the initiative; the larger side
 *   takes its remaining turns at the end. Elites take 2 turns, champions one per soldier replaced.
 * - Checks: two attribute dice + accuracy against DEF or M.DEF. Double 1s fumble (miss); doubles of 6+
 *   are critical (hit). Damage is the High Roll + the item's damage, then affinities
 *   (vulnerable ×2, resistant ½, immune 0, absorb heals).
 * - Guard: resistance to all damage until the actor's next turn.
 * - Items: Remedy (3 IP, 50 HP), Elixir (3 IP, 50 MP).
 * - 0 HP: out of the fight (heroes surrender; foes are defeated).
 *
 * Choices are made by a utility AI: it estimates the expected value of every option (exact hit chances
 * and damage from the dice), prefers kills and dangerous targets, exploits known weaknesses, heals and
 * guards when it matters, and keeps Mind Points for when they count.
 */

export const DTYPES = ['physical', 'air', 'bolt', 'dark', 'earth', 'fire', 'ice', 'light', 'poison'];
const AFF_MULT = { '-1': 2, 0: 1, 1: 0.5, 2: 0, 3: -1 };
/** Guard gives resistance to everything; resistance and vulnerability cancel out */
const guarded = (mult) => (mult === 2 ? 1 : mult === 1 ? 0.5 : mult);

/* ---------- dice math (exact, cached) ---------- */

const cache = new Map();
/** Chance to hit and the expected High Roll on a hit, for dice a/b, accuracy bonus and a defense */
export function hitStats(a, b, acc, def) {
	const key = `${a}|${b}|${acc}|${def}`;
	let r = cache.get(key);
	if (r) return r;
	let hits = 0;
	let hrSum = 0;
	let crits = 0;
	for (let x = 1; x <= a; x++) {
		for (let y = 1; y <= b; y++) {
			const fumble = x === 1 && y === 1;
			const crit = x === y && x >= 6;
			const hit = !fumble && (crit || x + y + acc >= def);
			if (hit) {
				hits++;
				hrSum += Math.max(x, y);
				if (crit) crits++;
			}
		}
	}
	const n = a * b;
	r = { p: hits / n, hr: hits ? hrSum / hits : 0, crit: crits / n };
	cache.set(key, r);
	return r;
}

const roll = (rng, d) => 1 + Math.floor(rng() * d);

/** Small fast seeded RNG (mulberry32) so a run can be repeated */
export function makeRng(seed = Date.now()) {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

/* ---------- combatant state ---------- */

function makeUnit(spec, side, idx) {
	return {
		...spec,
		key: `${side}${idx}`,
		side,
		hp: spec.hpStart ?? spec.hpMax,
		mp: spec.mpStart ?? spec.mpMax,
		ip: spec.ipStart ?? spec.ipMax ?? 0,
		guard: false,
		out: false,
		stats: { dealt: 0, taken: 0, healed: 0, mpSpent: 0, ipSpent: 0, kos: 0, turns: 0, crits: 0, misses: 0, attacks: 0, guards: 0, items: 0, spells: 0 },
	};
}

const alive = (list) => list.filter((u) => !u.out);
const dieOf = (u, attr) => u.attrs?.[attr] ?? 8;

/** What a side knows about the other side's affinities */
function affKnown(knowledge, target, type) {
	if (knowledge.all) return target.aff?.[type] ?? 0;
	return knowledge.seen.get(`${target.key}|${type}`) ?? 0;
}

/* ---------- evaluating options ---------- */

function expectedOn(actor, action, target, ctx) {
	const def = action.defense === 'mdef' ? target.mdef : target.def;
	const st = action.roll === false ? { p: 1, hr: 0, crit: 0 } : hitStats(dieOf(actor, action.attrs[0]), dieOf(actor, action.attrs[1]), action.acc ?? 0, def);
	const aff = affKnown(ctx.know[actor.side], target, action.type);
	let mult = AFF_MULT[aff] ?? 1;
	if (target.guard) mult = guarded(mult);
	const raw = (action.hr === false ? 0 : st.hr) + (action.damage ?? 0);
	const dmg = mult < 0 ? -raw : Math.floor(raw * mult);
	return { p: st.p, dmg, expected: st.p * Math.min(Math.max(dmg, 0), target.hp), kill: dmg >= target.hp ? st.p : 0 };
}

/** How dangerous a unit is: a rough expected damage per round, used to choose who to hit first */
function threat(u) {
	const best = Math.max(10, ...u.actions.filter((a) => a.kind !== 'heal').map((a) => (a.damage ?? 0) + 5 * (a.targets ?? 1)));
	return best * (u.turns ?? 1);
}

function options(actor, ctx) {
	const foes = alive(actor.side === 'H' ? ctx.foes : ctx.heroes);
	const allies = alive(actor.side === 'H' ? ctx.heroes : ctx.foes);
	const out = [];
	const smart = ctx.opts.smart !== false;
	for (const action of actor.actions) {
		const cost = action.mp ?? 0;
		if (cost > actor.mp) continue;
		if (action.kind === 'heal') {
			const hurt = (action.selfOnly ? [actor] : allies).filter((a) => a.hp < a.hpMax).sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax);
			if (!hurt.length) continue;
			const tg = hurt.slice(0, Math.max(1, action.targets ?? 1));
			const totalCost = action.perTarget ? cost * tg.length : cost;
			if (totalCost > actor.mp) continue;
			let value = 0;
			for (const a of tg) {
				const missing = a.hpMax - a.hp;
				const urgency = a.hp / a.hpMax < 0.35 ? 2.2 : a.hp / a.hpMax < 0.6 ? 1.2 : 0.4;
				value += Math.min(missing, action.heal) * urgency;
			}
			out.push({ action, targets: tg, value: value - totalCost * ctx.mpValue(actor), cost: totalCost });
			continue;
		}
		// damage: pick the best targets
		const scored = foes
			.map((t) => {
				const e = expectedOn(actor, action, t, ctx);
				const focus = smart ? 1 + (1 - t.hp / t.hpMax) * 0.5 + threat(t) / 200 : 1;
				return { t, e, score: e.expected * focus + (smart ? e.kill * threat(t) * 1.5 : 0) };
			})
			.sort((a, b) => b.score - a.score);
		if (!scored.length) continue;
		const n = action.targets ?? 1;
		const chosen = smart ? scored.slice(0, n) : [scored[Math.floor(ctx.rng() * scored.length)]].slice(0, n);
		const totalCost = action.perTarget ? cost * chosen.length : cost;
		if (totalCost > actor.mp) continue;
		const value = chosen.reduce((s, c) => s + c.score, 0) - totalCost * ctx.mpValue(actor);
		out.push({ action, targets: chosen.map((c) => c.t), value, cost: totalCost });
	}
	// items (heroes): Remedy and Elixir
	if (actor.side === 'H' && ctx.opts.items !== false && actor.ip >= 3) {
		const worst = allies.filter((a) => a.hp < a.hpMax).sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0];
		if (worst && worst.hp / worst.hpMax < 0.4) out.push({ action: { kind: 'remedy', name: 'Remedy' }, targets: [worst], value: Math.min(50, worst.hpMax - worst.hp) * 1.6 });
		const caster = allies.filter((a) => a.mpMax && a.mp / a.mpMax < 0.25 && a.actions.some((x) => x.mp)).sort((a, b) => a.mp - b.mp)[0];
		if (caster) out.push({ action: { kind: 'elixir', name: 'Elixir' }, targets: [caster], value: Math.min(50, caster.mpMax - caster.mp) * 0.5 });
	}
	// guard
	if (ctx.opts.guard !== false) {
		const danger = alive(actor.side === 'H' ? ctx.foes : ctx.heroes).reduce((s, f) => s + threat(f), 0) / Math.max(1, allies.length);
		const low = actor.hp / actor.hpMax;
		out.push({ action: { kind: 'guard', name: 'Guard' }, targets: [actor], value: low < 0.3 ? danger * 0.45 : danger * 0.08 });
	}
	return out;
}

/* ---------- resolving ---------- */

function act(actor, ctx) {
	actor.guard = false;
	actor.stats.turns++;
	const opts = options(actor, ctx);
	if (!opts.length) return;
	opts.sort((a, b) => b.value - a.value);
	let pick = opts[0];
	if (ctx.opts.smart === false && opts.length > 1 && ctx.rng() < 0.35) pick = opts[Math.floor(ctx.rng() * opts.length)];
	const { action, targets } = pick;
	const log = ctx.log;
	switch (action.kind) {
		case 'guard':
			actor.guard = true;
			actor.stats.guards++;
			log?.push(`${actor.name} guards.`);
			return;
		case 'remedy':
		case 'elixir': {
			actor.ip -= 3;
			actor.stats.ipSpent += 3;
			actor.stats.items++;
			const t = targets[0];
			if (action.kind === 'remedy') {
				const h = Math.min(50, t.hpMax - t.hp);
				t.hp += h;
				actor.stats.healed += h;
				log?.push(`${actor.name} uses a Remedy on ${t.name}: +${h} HP.`);
			} else {
				const m = Math.min(50, t.mpMax - t.mp);
				t.mp += m;
				log?.push(`${actor.name} uses an Elixir on ${t.name}: +${m} MP.`);
			}
			return;
		}
	}
	actor.mp -= pick.cost ?? 0;
	actor.stats.mpSpent += pick.cost ?? 0;
	if (action.mp) actor.stats.spells++;
	if (action.kind === 'heal') {
		const parts = [];
		for (const t of targets) {
			const h = Math.min(action.heal, t.hpMax - t.hp);
			t.hp += h;
			actor.stats.healed += h;
			parts.push(`${t.name} +${h}`);
		}
		log?.push(`${actor.name} casts ${action.name}: ${parts.join(', ')} HP.`);
		return;
	}
	// one roll against every target
	const d1 = roll(ctx.rng, dieOf(actor, action.attrs[0]));
	const d2 = roll(ctx.rng, dieOf(actor, action.attrs[1]));
	const fumble = d1 === 1 && d2 === 1;
	const crit = d1 === d2 && d1 >= 6;
	const hr = Math.max(d1, d2);
	const total = d1 + d2 + (action.acc ?? 0);
	actor.stats.attacks++;
	if (crit) actor.stats.crits++;
	const parts = [];
	for (const t of targets) {
		if (t.out) continue;
		const def = action.defense === 'mdef' ? t.mdef : t.def;
		const hit = action.roll === false || (!fumble && (crit || total >= def));
		if (!hit) {
			actor.stats.misses++;
			parts.push(`misses ${t.name}`);
			continue;
		}
		const aff = t.aff?.[action.type] ?? 0;
		ctx.know[actor.side].seen.set(`${t.key}|${action.type}`, aff);
		let mult = AFF_MULT[aff] ?? 1;
		if (t.guard) mult = guarded(mult);
		const raw = (action.hr === false ? 0 : hr) + (action.damage ?? 0);
		if (mult < 0) {
			const h = Math.min(raw, t.hpMax - t.hp);
			t.hp += h;
			parts.push(`${t.name} absorbs ${h}`);
			continue;
		}
		const dmg = Math.min(t.hp, Math.floor(raw * mult));
		t.hp -= dmg;
		actor.stats.dealt += dmg;
		t.stats.taken += dmg;
		parts.push(`${t.name} −${dmg}${mult === 2 ? ' (weak!)' : mult === 0.5 ? ' (resists)' : mult === 0 ? ' (immune)' : ''}`);
		if (t.hp <= 0) {
			t.out = true;
			actor.stats.kos++;
			parts.push(`${t.name} ${t.side === 'H' ? 'surrenders' : 'is defeated'}`);
		}
	}
	log?.push(`${actor.name} ${action.mp ? 'casts' : 'uses'} ${action.name}${crit ? ' (critical!)' : fumble ? ' (fumble)' : ''} [${total}]: ${parts.join('; ') || 'no target'}.`);
}

/* ---------- one battle ---------- */

export function battle(heroSpecs, foeSpecs, opts = {}, rng = Math.random, log = null) {
	const heroes = heroSpecs.map((s, i) => makeUnit(s, 'H', i));
	const foes = foeSpecs.map((s, i) => makeUnit(s, 'F', i));
	const ctx = {
		heroes,
		foes,
		opts,
		rng,
		log,
		know: { H: { all: !!opts.heroesKnow, seen: new Map() }, F: { all: opts.foesKnow !== false, seen: new Map() } },
		// MP is worth more when there is little of it left
		mpValue: (u) => (u.mpMax ? 0.6 + 1.6 * (1 - u.mp / u.mpMax) * (opts.saveMp === false ? 0.3 : 1) : 1),
	};
	// initiative
	let heroesFirst;
	if (opts.initiative === 'heroes') heroesFirst = true;
	else if (opts.initiative === 'foes') heroesFirst = false;
	else {
		const leader = [...heroes].sort((a, b) => (b.init ?? 0) + dieOf(b, 'dex') + dieOf(b, 'ins') - ((a.init ?? 0) + dieOf(a, 'dex') + dieOf(a, 'ins')))[0];
		const dl = Math.max(...foes.map((f) => f.init ?? 0), 0);
		const supports = heroes.filter((h) => h !== leader).filter((h) => roll(rng, dieOf(h, 'dex')) + roll(rng, dieOf(h, 'ins')) + (h.init ?? 0) >= 10).length;
		heroesFirst = leader ? roll(rng, dieOf(leader, 'dex')) + roll(rng, dieOf(leader, 'ins')) + (leader.init ?? 0) + supports >= dl : false;
	}
	log?.push(heroesFirst ? 'The heroes seize the initiative.' : 'The foes have the initiative.');
	const maxRounds = opts.maxRounds ?? 30;
	let round = 0;
	while (round < maxRounds && alive(heroes).length && alive(foes).length) {
		round++;
		log?.push(`— Round ${round} —`);
		const qh = alive(heroes).flatMap((u) => Array(u.turns ?? 1).fill(u));
		const qf = alive(foes).flatMap((u) => Array(u.turns ?? 1).fill(u));
		// spread multi-turn creatures out so they don't act back to back
		const spread = (q) => {
			const out = [];
			const groups = new Map();
			for (const u of q) groups.set(u, (groups.get(u) ?? 0) + 1);
			let left = q.length;
			while (left) for (const [u, n] of groups) if (n > 0) {
				out.push(u);
				groups.set(u, n - 1);
				left--;
			}
			return out;
		};
		const A = spread(heroesFirst ? qh : qf);
		const B = spread(heroesFirst ? qf : qh);
		let i = 0;
		let j = 0;
		let turnA = true;
		while ((i < A.length || j < B.length) && alive(heroes).length && alive(foes).length) {
			let u = null;
			if (turnA && i < A.length) u = A[i++];
			else if (!turnA && j < B.length) u = B[j++];
			else if (i < A.length) u = A[i++];
			else u = B[j++];
			turnA = !turnA;
			if (u.out) continue;
			act(u, ctx);
		}
	}
	const win = alive(foes).length === 0 && alive(heroes).length > 0;
	const timeout = alive(foes).length > 0 && alive(heroes).length > 0;
	log?.push(win ? 'Victory.' : timeout ? `Still going after ${maxRounds} rounds.` : 'The heroes are defeated.');
	return { win, timeout, rounds: round, heroesFirst, heroes, foes };
}

/* ---------- many battles ---------- */

export async function simulate(heroSpecs, foeSpecs, opts = {}, onProgress = null) {
	const runs = Math.max(1, opts.runs ?? 500);
	const rng = makeRng(opts.seed ?? Date.now());
	const agg = {
		runs,
		wins: 0,
		timeouts: 0,
		rounds: 0,
		initiative: 0,
		heroes: heroSpecs.map((s) => ({ name: s.name, img: s.img, ko: 0, hpLeft: 0, mpLeft: 0, dealt: 0, taken: 0, healed: 0, mpSpent: 0, ipSpent: 0, kos: 0, crits: 0, misses: 0, attacks: 0, guards: 0, items: 0, spells: 0 })),
		foes: foeSpecs.map((s) => ({ name: s.name, img: s.img, defeated: 0, dealt: 0, taken: 0, kos: 0, survived: 0 })),
		roundsHist: {},
		survivorsHist: {},
	};
	const sample = [];
	const t0 = performance.now();
	for (let r = 0; r < runs; r++) {
		const res = battle(heroSpecs, foeSpecs, opts, rng, r === 0 ? sample : null);
		if (res.win) agg.wins++;
		if (res.timeout) agg.timeouts++;
		if (res.heroesFirst) agg.initiative++;
		agg.rounds += res.rounds;
		agg.roundsHist[res.rounds] = (agg.roundsHist[res.rounds] ?? 0) + 1;
		const surv = res.heroes.filter((h) => !h.out).length;
		agg.survivorsHist[surv] = (agg.survivorsHist[surv] ?? 0) + 1;
		res.heroes.forEach((h, i) => {
			const a = agg.heroes[i];
			if (h.out) a.ko++;
			a.hpLeft += h.hp / h.hpMax;
			a.mpLeft += h.mpMax ? h.mp / h.mpMax : 1;
			for (const k of ['dealt', 'taken', 'healed', 'mpSpent', 'ipSpent', 'kos', 'crits', 'misses', 'attacks', 'guards', 'items', 'spells']) a[k] += h.stats[k];
		});
		res.foes.forEach((f, i) => {
			const a = agg.foes[i];
			if (f.out) a.defeated++;
			else a.survived++;
			a.dealt += f.stats.dealt;
			a.taken += f.stats.taken;
			a.kos += f.stats.kos;
		});
		if (onProgress && r % 50 === 49) {
			onProgress((r + 1) / runs);
			await new Promise((res2) => setTimeout(res2, 0));
		}
	}
	agg.ms = performance.now() - t0;
	agg.sample = sample;
	return summarize(agg);
}

function summarize(agg) {
	const n = agg.runs;
	const avg = (v) => v / n;
	const winRate = agg.wins / n;
	const hpLeft = agg.heroes.reduce((s, h) => s + h.hpLeft, 0) / Math.max(1, agg.heroes.length) / n;
	const koRate = agg.heroes.reduce((s, h) => s + h.ko, 0) / Math.max(1, agg.heroes.length) / n;
	let rating;
	if (winRate >= 0.98 && hpLeft >= 0.7) rating = { id: 'trivial', label: 'Trivial' };
	else if (winRate >= 0.95 && hpLeft >= 0.45) rating = { id: 'easy', label: 'Easy' };
	else if (winRate >= 0.85) rating = { id: 'fair', label: 'Fair' };
	else if (winRate >= 0.6) rating = { id: 'hard', label: 'Hard' };
	else rating = { id: 'deadly', label: 'Deadly' };
	const foeDmg = agg.foes.reduce((s, f) => s + f.dealt, 0) || 1;
	const notes = [];
	const top = [...agg.foes].sort((a, b) => b.dealt - a.dealt)[0];
	if (top && agg.foes.length > 1 && top.dealt / foeDmg > 0.45) notes.push(`${top.name} deals ${Math.round((top.dealt / foeDmg) * 100)}% of the enemies' damage: the fight hinges on it.`);
	const fragile = [...agg.heroes].sort((a, b) => b.ko - a.ko)[0];
	if (fragile && fragile.ko / n > 0.3) notes.push(`${fragile.name} goes down in ${Math.round((fragile.ko / n) * 100)}% of battles.`);
	const dry = agg.heroes.filter((h) => h.mpLeft / n < 0.15 && h.spells > 0);
	if (dry.length) notes.push(`${dry.map((h) => h.name).join(', ')} run${dry.length === 1 ? 's' : ''} out of MP: expect long fights to drag.`);
	if (avg(agg.rounds) > 8) notes.push('Long battle (more than 8 rounds on average): consider fewer HP or a clock to end it.');
	if (avg(agg.rounds) < 2.5 && winRate > 0.9) notes.push('Over very quickly: the foes may need more HP, Guard, or another creature.');
	if (agg.timeouts / n > 0.05) notes.push(`${Math.round((agg.timeouts / n) * 100)}% of battles hit the round limit.`);
	if (agg.initiative / n < 0.35) notes.push('The foes usually win the initiative.');
	return {
		runs: n,
		ms: agg.ms,
		winRate,
		timeoutRate: agg.timeouts / n,
		rounds: avg(agg.rounds),
		initiative: agg.initiative / n,
		hpLeft,
		koRate,
		rating,
		notes,
		roundsHist: agg.roundsHist,
		survivorsHist: agg.survivorsHist,
		heroes: agg.heroes.map((h) => ({ ...h, ko: h.ko / n, hpLeft: h.hpLeft / n, mpLeft: h.mpLeft / n, dealt: avg(h.dealt), taken: avg(h.taken), healed: avg(h.healed), mpSpent: avg(h.mpSpent), ipSpent: avg(h.ipSpent), kos: avg(h.kos), hitRate: h.attacks ? 1 - h.misses / Math.max(1, h.attacks) : 0, guards: avg(h.guards), items: avg(h.items), spells: avg(h.spells) })),
		foes: agg.foes.map((f) => ({ ...f, defeated: f.defeated / n, dealt: avg(f.dealt), taken: avg(f.taken), kos: avg(f.kos), share: f.dealt / foeDmg })),
		sample: agg.sample,
	};
}
