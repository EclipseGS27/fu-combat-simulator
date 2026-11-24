import { DTYPES } from './engine.mjs';

/**
 * Turn a Project FU actor into what the engine needs: HP, MP, IP, defenses, attribute dice, affinities,
 * turns per round, and its actions (weapons or NPC attacks, damage spells, healing spells).
 * Skills, status effects and special rules are not simulated; the summary says so.
 */
const num = (v, d = 0) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
};
const ATTR = ['dex', 'ins', 'mig', 'wlp'];

/** "10", "10 x T", "5 + 5" → a number (first integer found) */
function parseAmount(v, fallback = 0) {
	if (typeof v === 'number') return v;
	const m = String(v ?? '').match(/-?\d+/);
	return m ? num(m[0], fallback) : fallback;
}

function attrsOf(item, fallback = ['dex', 'ins']) {
	const a = item?.system?.rollInfo?.attributes ?? item?.system?.attributes ?? {};
	const p = a.primary?.value ?? a.primary;
	const s = a.secondary?.value ?? a.secondary;
	return [ATTR.includes(p) ? p : fallback[0], ATTR.includes(s) ? s : fallback[1]];
}

function weaponAction(item) {
	const s = item.system ?? {};
	if (s.hasDamage === false) return null;
	return {
		kind: 'attack',
		name: item.name,
		attrs: attrsOf(item, ['dex', 'mig']),
		acc: num(s.accuracy?.value),
		damage: num(s.damage?.value),
		type: DTYPES.includes(s.damageType?.value) ? s.damageType.value : 'physical',
		defense: s.defense === 'mdef' ? 'mdef' : 'def',
		hr: s.rollInfo?.useWeapon?.hrZero?.value ? false : undefined,
		targets: 1,
	};
}

function spellAction(item) {
	const s = item.system ?? {};
	const cost = parseAmount(s.cost?.amount ?? s.mpCost?.value, 0);
	const perTarget = !!s.cost?.perTarget || /x\s*t/i.test(String(s.cost?.amount ?? ''));
	const rule = s.targeting?.rule;
	const max = rule === 'multiple' ? Math.max(1, num(s.targeting?.max) || 3) : 1;
	const resource = s.resource ?? {};
	if (resource.enabled && resource.type === 'hp') {
		if (rule === 'self') return { kind: 'heal', name: item.name, heal: parseAmount(resource.amount, 30), mp: cost, targets: 1, selfOnly: true };
		return { kind: 'heal', name: item.name, heal: parseAmount(resource.amount, 30), mp: cost, targets: max, perTarget };
	}
	const dmg = s.rollInfo?.damage;
	// Project FU 4.x wraps these in { value }; 5.x stores them plainly
	const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
	if (!plain(dmg?.hasDamage)) return null;
	const dtype = plain(dmg.type);
	return {
		kind: 'attack',
		name: item.name,
		attrs: attrsOf(item, ['ins', 'wlp']),
		acc: num(s.rollInfo?.accuracy?.value),
		damage: num(dmg.value),
		type: DTYPES.includes(dtype) ? dtype : 'physical',
		defense: s.defense === 'def' ? 'def' : 'mdef',
		roll: s.hasRoll?.value !== false,
		hr: dmg.hrZero ? false : undefined,
		mp: cost,
		targets: max,
		perTarget,
	};
}

export function turnsOf(actor) {
	const rank = actor.system?.rank?.value;
	if (rank === 'elite') return 2;
	if (rank === 'champion') return Math.max(1, num(actor.system?.rank?.replacedSoldiers, 1));
	return 1;
}

export function specFrom(actor, { current = false } = {}) {
	const sys = actor.system ?? {};
	const r = sys.resources ?? {};
	const attrs = {};
	for (const k of ATTR) attrs[k] = num(sys.attributes?.[k]?.current, 8);
	const aff = {};
	for (const t of DTYPES) aff[t] = num(sys.affinities?.[t]?.current);
	const actions = [];
	const items = actor.items?.contents ?? [];
	if (actor.type === 'character') {
		const eq = sys.equipped ?? {};
		const weapons = [eq.mainHand, eq.offHand].map((id) => actor.items.get(id)).filter((i) => i && ['weapon', 'customWeapon'].includes(i.type));
		for (const w of new Set(weapons)) {
			const a = weaponAction(w);
			if (a) actions.push(a);
		}
		// nothing equipped: the character's own Unarmed Strike item (Project FU adds one), else the rules' default
		if (!actions.length) {
			const unarmed = items.find((i) => i.type === 'weapon' && (i.system?.fuid === 'unarmed-strike' || /unarmed/i.test(i.name)));
			const a = unarmed ? weaponAction(unarmed) : null;
			actions.push(a ?? { kind: 'attack', name: 'Unarmed strike', attrs: ['dex', 'mig'], acc: 0, damage: 0, type: 'physical', defense: 'def', targets: 1 });
		}
	} else {
		for (const b of items.filter((i) => i.type === 'basic')) {
			const a = weaponAction(b);
			if (a) actions.push(a);
		}
		for (const w of items.filter((i) => i.type === 'weapon')) {
			const a = weaponAction(w);
			if (a) actions.push(a);
		}
		if (!actions.length) actions.push({ kind: 'attack', name: 'Attack', attrs: ['dex', 'mig'], acc: 0, damage: 5, type: 'physical', defense: 'def', targets: 1 });
	}
	for (const s of items.filter((i) => i.type === 'spell')) {
		const a = spellAction(s);
		if (a) actions.push(a);
	}
	const hpMax = Math.max(1, num(r.hp?.max, 30));
	const mpMax = num(r.mp?.max);
	const ipMax = actor.type === 'character' ? num(r.ip?.max, 6) : 0;
	return {
		uuid: actor.uuid,
		name: actor.name,
		img: actor.img,
		level: num(sys.level?.value, 1),
		rank: sys.rank?.value ?? '',
		hpMax,
		mpMax,
		ipMax,
		hpStart: current ? num(r.hp?.value, hpMax) : hpMax,
		mpStart: current ? num(r.mp?.value, mpMax) : mpMax,
		ipStart: current ? num(r.ip?.value, ipMax) : ipMax,
		def: num(sys.derived?.def?.value, 8),
		mdef: num(sys.derived?.mdef?.value, 8),
		init: num(sys.derived?.init?.value, 0),
		attrs,
		aff,
		turns: turnsOf(actor),
		actions,
	};
}
