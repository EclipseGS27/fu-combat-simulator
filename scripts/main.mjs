import { SimulatorApp } from './app.mjs';
import { simulate, battle } from './engine.mjs';
import { specFrom } from './extract.mjs';

const MODULE_ID = 'fu-combat-simulator';
let app = null;
const open = () => {
	if (!game.user.isGM) return ui.notifications.warn('The combat simulator is for the GM.');
	app ??= new SimulatorApp();
	app.render({ force: true });
	return app;
};

Hooks.once('init', () => {
	game.settings.register(MODULE_ID, 'options', { scope: 'client', config: false, type: Object, default: {} });
	game.modules.get(MODULE_ID).api = { open, simulate, battle, specFrom };
});

Hooks.on('getSceneControlButtons', (controls) => {
	if (!game.user.isGM) return;
	try {
		const tokens = controls.tokens ?? controls.token;
		if (tokens?.tools && !Array.isArray(tokens.tools)) tokens.tools.fucsSim = { name: 'fucsSim', title: 'Combat simulator', icon: 'fa-solid fa-chess-knight', button: true, order: 64, visible: true, onChange: () => open() };
	} catch (err) {
		console.warn(`${MODULE_ID} | scene control`, err);
	}
});

/* "Simulate" in the combat tracker */
Hooks.on('renderCombatTracker', (tracker, html) => {
	if (!game.user.isGM || !game.combat) return;
	const el = html instanceof HTMLElement ? html : html[0];
	if (!el || el.querySelector('.fucs-btn')) return;
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 'fucs-btn';
	b.innerHTML = '<i class="fa-solid fa-chess-knight"></i> Simulate';
	b.dataset.tooltip = 'Simulate this combat';
	b.addEventListener('click', () => open()?.loadCombat(game.combat));
	(el.querySelector('.combat-controls') ?? el.querySelector('footer') ?? el).append(b);
});
