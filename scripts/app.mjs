import { simulate } from './engine.mjs';
import { specFrom } from './extract.mjs';

const { ApplicationV2 } = foundry.applications.api;
const MODULE_ID = 'fu-combat-simulator';
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const pct = (v) => `${Math.round(v * 100)}%`;
const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString();

function partyCharacters() {
	try {
		const v = game.settings.get('projectfu', 'optionActiveParty');
		const p = v instanceof Actor ? v : game.actors.get(v);
		// Project FU keeps the party as a Set of uuids
		const list = [...(p?.system?.characters ?? [])].map((u) => fromUuidSync(u)).filter(Boolean);
		if (list.length) return list;
	} catch {
		/* no party */
	}
	return game.actors.filter((a) => a.type === 'character' && a.hasPlayerOwner);
}

/** GM tool: pick the heroes and the foes, run hundreds of battles, read the odds before the real fight */
export class SimulatorApp extends ApplicationV2 {
	static DEFAULT_OPTIONS = {
		id: 'fucs-sim',
		classes: ['fucs'],
		window: { title: 'Combat simulator', icon: 'fa-solid fa-chess-knight', resizable: true },
		position: { width: 980, height: 760 },
		actions: {
			run: SimulatorApp.#run,
			addParty: SimulatorApp.#addParty,
			fromCombat: SimulatorApp.#fromCombat,
			remove: SimulatorApp.#remove,
			count: SimulatorApp.#count,
			clear: SimulatorApp.#clear,
			toggleLog: SimulatorApp.#toggleLog,
		},
	};

	heroes = []; // { uuid, name, img }
	foes = []; // { uuid, name, img, count }
	result = null;
	running = 0;
	showLog = false;
	opts = game.settings.get(MODULE_ID, 'options') ?? {};

	async _renderHTML() {
		const o = { runs: 500, initiative: 'roll', smart: true, foesKnow: true, heroesKnow: false, items: true, guard: true, current: false, maxRounds: 30, ...this.opts };
		const row = (x, side) => `<li><img src="${esc(x.img)}" alt=""><span class="nm">${esc(x.name)}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span>
			${side === 'foes' ? `<button type="button" data-action="count" data-i="${x.i}" data-n="-1">−</button><b>${x.count}</b><button type="button" data-action="count" data-i="${x.i}" data-n="1">+</button>` : ''}
			<button type="button" data-action="remove" data-side="${side}" data-i="${x.i}" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></button></li>`;
		const div = document.createElement('div');
		div.className = 'fucs-body';
		div.innerHTML = `<div class="setup">
				<section class="side heroes" data-drop="heroes"><h3>Heroes <button type="button" data-action="addParty">Party</button></h3>
					<ul>${this.heroes.map((h, i) => row({ ...h, i }, 'heroes')).join('') || '<li class="empty">Drop characters here, or add the party.</li>'}</ul></section>
				<section class="side foes" data-drop="foes"><h3>Foes <button type="button" data-action="fromCombat" data-tooltip="Take heroes and foes from the current combat">From combat</button></h3>
					<ul>${this.foes.map((f, i) => row({ ...f, i, note: this.#foeNote(f) }, 'foes')).join('') || '<li class="empty">Drop NPCs here, from the sidebar or a compendium.</li>'}</ul></section>
				<section class="opts"><h3>Options</h3>
					<label>Battles <input type="number" name="runs" min="10" max="10000" step="10" value="${o.runs}"></label>
					<label>Initiative <select name="initiative"><option value="roll" ${o.initiative === 'roll' ? 'selected' : ''}>Roll (Group Check)</option><option value="heroes" ${o.initiative === 'heroes' ? 'selected' : ''}>Heroes first</option><option value="foes" ${o.initiative === 'foes' ? 'selected' : ''}>Foes first</option></select></label>
					<label>Round limit <input type="number" name="maxRounds" min="3" max="100" value="${o.maxRounds}"></label>
					<label class="chk"><input type="checkbox" name="smart" ${o.smart ? 'checked' : ''}> Smart tactics (focus fire, finish off, protect the weak)</label>
					<label class="chk"><input type="checkbox" name="foesKnow" ${o.foesKnow ? 'checked' : ''}> Foes know the heroes' affinities</label>
					<label class="chk"><input type="checkbox" name="heroesKnow" ${o.heroesKnow ? 'checked' : ''}> Heroes know the foes' affinities (otherwise they learn by hitting)</label>
					<label class="chk"><input type="checkbox" name="items" ${o.items ? 'checked' : ''}> Heroes use Remedies and Elixirs (IP)</label>
					<label class="chk"><input type="checkbox" name="guard" ${o.guard ? 'checked' : ''}> Guard when it helps</label>
					<label class="chk"><input type="checkbox" name="current" ${o.current ? 'checked' : ''}> Start from current HP / MP / IP (not full)</label>
					<button type="button" class="cta" data-action="run" ${this.heroes.length && this.foes.length && !this.running ? '' : 'disabled'}><i class="fa-solid fa-play"></i> ${this.running ? `Running… ${pct(this.running)}` : 'Simulate'}</button>
					<button type="button" data-action="clear">Clear</button>
				</section>
			</div>
			<div class="results">${this.result ? this.#results(this.result) : '<p class="empty">Results appear here. The simulator plays each battle with the Fabula Ultima rules for checks, damage, affinities, Guard, items, initiative and turn order (elites take 2 turns, champions one per soldier replaced). Skills, status effects and special rules are not simulated, so treat the numbers as a guide.</p>'}</div>`;
		return div;
	}

	#foeNote(f) {
		const a = fromUuidSync(f.uuid);
		const s = a?.system;
		if (!s) return '';
		return `Lv ${s.level?.value ?? '?'} ${s.rank?.value ?? ''}${s.villain?.value ? ` · ${s.villain.value} villain` : ''}`;
	}

	#results(r) {
		const bar = (v, cls = '') => `<span class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, v * 100))}%"></i></span>`;
		const hist = (h, label) => {
			const keys = Object.keys(h).map(Number).sort((a, b) => a - b);
			const max = Math.max(...Object.values(h));
			return `<div class="hist"><small>${label}</small><div class="cols">${keys.map((k) => `<span data-tooltip="${k}: ${pct(h[k] / r.runs)}"><i style="height:${(h[k] / max) * 100}%"></i><b>${k}</b></span>`).join('')}</div></div>`;
		};
		return `<div class="top rate-${r.rating.id}">
				<div class="big"><small>Difficulty</small><b>${esc(r.rating.label)}</b></div>
				<div class="big"><small>Heroes win</small><b>${pct(r.winRate)}</b></div>
				<div class="big"><small>Rounds</small><b>${f1(r.rounds)}</b></div>
				<div class="big"><small>HP left (avg)</small><b>${pct(r.hpLeft)}</b></div>
				<div class="big"><small>Hero KO rate</small><b>${pct(r.koRate)}</b></div>
				<div class="big"><small>Initiative won</small><b>${pct(r.initiative)}</b></div>
			</div>
			${r.notes.length ? `<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
			<div class="hists">${hist(r.roundsHist, 'Rounds per battle')}${hist(r.survivorsHist, 'Heroes standing at the end')}</div>
			<table><thead><tr><th>Hero</th><th>KO</th><th>HP left</th><th>MP left</th><th>Damage</th><th>Taken</th><th>Healed</th><th>Hit rate</th><th>Spells</th><th>Items</th><th>Guards</th></tr></thead><tbody>
			${r.heroes.map((h) => `<tr><th><img src="${esc(h.img)}" alt="">${esc(h.name)}</th><td>${pct(h.ko)}${bar(h.ko, 'bad')}</td><td>${pct(h.hpLeft)}${bar(h.hpLeft)}</td><td>${pct(h.mpLeft)}</td><td>${f1(h.dealt)}</td><td>${f1(h.taken)}</td><td>${f1(h.healed)}</td><td>${pct(h.hitRate)}</td><td>${f1(h.spells)}</td><td>${f1(h.items)}</td><td>${f1(h.guards)}</td></tr>`).join('')}
			</tbody></table>
			<table><thead><tr><th>Foe</th><th>Defeated</th><th>Damage</th><th>Share</th><th>Heroes KO'd</th><th>Damage taken</th></tr></thead><tbody>
			${r.foes.map((f) => `<tr><th><img src="${esc(f.img)}" alt="">${esc(f.name)}</th><td>${pct(f.defeated)}</td><td>${f1(f.dealt)}</td><td>${pct(f.share)}${bar(f.share, 'bad')}</td><td>${f1(f.kos)}</td><td>${f1(f.taken)}</td></tr>`).join('')}
			</tbody></table>
			<div class="foot"><small>${r.runs} battles in ${Math.round(r.ms)} ms</small><span class="sp"></span><button type="button" data-action="toggleLog">${this.showLog ? 'Hide' : 'Show'} a sample battle</button></div>
			${this.showLog ? `<ol class="log">${r.sample.map((l) => `<li class="${l.startsWith('—') ? 'rd' : ''}">${esc(l)}</li>`).join('')}</ol>` : ''}`;
	}

	_replaceHTML(result, content) {
		const scroll = content.querySelector('.results')?.scrollTop ?? 0;
		content.replaceChildren(result);
		const r = content.querySelector('.results');
		if (r) r.scrollTop = scroll;
	}

	_onRender() {
		const el = this.element;
		el.querySelectorAll('.opts input, .opts select').forEach((i) => i.addEventListener('change', () => this.#readOpts()));
		el.querySelectorAll('[data-drop]').forEach((z) => {
			z.addEventListener('dragover', (e) => {
				e.preventDefault();
				z.classList.add('over');
			});
			z.addEventListener('dragleave', () => z.classList.remove('over'));
			z.addEventListener('drop', async (e) => {
				e.preventDefault();
				z.classList.remove('over');
				const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
				const d = TE.getDragEventData(e);
				if (d?.type !== 'Actor' || !d.uuid) return ui.notifications.warn('Drop an actor.');
				const a = await fromUuid(d.uuid);
				if (!a) return;
				this.#add(z.dataset.drop === 'heroes' || (a.type === 'character' && z.dataset.drop !== 'foes') ? 'heroes' : 'foes', a);
				this.render();
			});
		});
	}

	#readOpts() {
		const el = this.element;
		const o = {};
		el.querySelectorAll('.opts input, .opts select').forEach((i) => {
			o[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value;
		});
		this.opts = o;
		game.settings.set(MODULE_ID, 'options', o);
	}

	#add(side, actor) {
		if (side === 'heroes') {
			if (!this.heroes.some((h) => h.uuid === actor.uuid)) this.heroes.push({ uuid: actor.uuid, name: actor.name, img: actor.img });
		} else {
			const f = this.foes.find((x) => x.uuid === actor.uuid);
			if (f) f.count++;
			else this.foes.push({ uuid: actor.uuid, name: actor.name, img: actor.img, count: 1 });
		}
	}

	static #addParty() {
		for (const a of partyCharacters()) this.#add('heroes', a);
		this.render();
	}

	/** Replace both sides with the combatants of a combat (characters and friendly tokens are heroes) */
	loadCombat(c = game.combat) {
		if (!c) return ui.notifications.info('No combat.');
		this.heroes = [];
		this.foes = [];
		this.result = null;
		for (const cb of c.combatants) {
			const a = cb.actor;
			if (!a || a.getFlag?.('fu-class-mechanics', 'vehicleOf')) continue;
			const friendly = a.type === 'character' || (cb.token?.disposition ?? 0) === 1;
			this.#add(friendly ? 'heroes' : 'foes', a);
		}
		this.render();
	}

	static #fromCombat() {
		this.loadCombat();
	}

	static #remove(e, t) {
		const list = t.dataset.side === 'heroes' ? this.heroes : this.foes;
		list.splice(Number(t.dataset.i), 1);
		this.render();
	}

	static #count(e, t) {
		const f = this.foes[Number(t.dataset.i)];
		f.count = Math.max(1, f.count + Number(t.dataset.n));
		this.render();
	}

	static #clear() {
		this.heroes = [];
		this.foes = [];
		this.result = null;
		this.render();
	}

	static #toggleLog() {
		this.showLog = !this.showLog;
		this.render();
	}

	static async #run() {
		this.#readOpts();
		const o = { runs: 500, maxRounds: 30, ...this.opts };
		const heroes = [];
		for (const h of this.heroes) {
			const a = await fromUuid(h.uuid);
			if (a) heroes.push(specFrom(a, { current: o.current }));
		}
		const foes = [];
		for (const f of this.foes) {
			const a = await fromUuid(f.uuid);
			if (!a) continue;
			const spec = specFrom(a, { current: o.current });
			for (let i = 0; i < f.count; i++) foes.push({ ...spec, name: f.count > 1 ? `${spec.name} ${String.fromCharCode(65 + i)}` : spec.name });
		}
		if (!heroes.length || !foes.length) return ui.notifications.warn('Add heroes and foes first.');
		this.running = 0.01;
		this.render();
		try {
			this.result = await simulate(heroes, foes, { ...o, runs: Math.min(10000, Math.max(10, o.runs)) }, (p) => {
				this.running = p;
				const btn = this.element?.querySelector('[data-action=run]');
				if (btn) btn.textContent = `Running… ${pct(p)}`;
			});
		} catch (err) {
			console.error(`${MODULE_ID} |`, err);
			ui.notifications.error(`Simulation failed: ${err.message}`);
		}
		this.running = 0;
		this.render();
	}
}
