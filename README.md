# Fabula Ultima Combat Simulator

Test an encounter before you run it. Pick the heroes and the foes, and the simulator plays hundreds or thousands of battles with the Fabula Ultima rules, then tells you how often the heroes win, how long it takes, who goes down, which foe does the damage, and what one of those battles looked like. For the Project FU system (Foundry v13, Project FU 4.14+); GM only.

## Install
In Foundry: Add-on Modules → Install Module → paste this Manifest URL:
`https://github.com/EclipseGS27/fu-combat-simulator/releases/latest/download/module.json`

Open it with the chess knight button in the token controls, or **Simulate** in the combat tracker (it loads that combat's heroes and foes).

## Setting up
- **Heroes**: drop characters, or add the active party.
- **Foes**: drop NPCs from the sidebar or a compendium, and use + / − for several of the same.
- **From combat** takes both sides from the current combat.
- **Options**: number of battles, initiative (rolled, heroes first, foes first), round limit, smart tactics, who knows whose affinities, Remedies and Elixirs, Guard, and starting from current HP / MP / IP instead of full.

## What it simulates
Everything comes from the actors in Project FU:
- **Characters**: HP, MP and IP, DEF and M.DEF, Initiative, attribute dice, affinities, equipped weapons, damage spells and healing spells.
- **NPCs**: the same, with their attacks, spells, and turns per round from their rank (elites 2, champions one per soldier replaced).

Rules used:
- **Initiative**: a Group Check on DEX + INS against the foes' highest Initiative.
- **Turn order**: turns alternate between the sides, and the larger side finishes the round.
- **Accuracy**: two attribute dice plus accuracy against DEF or M.DEF. Double 1s are a fumble; doubles of 6 or more are a critical.
- **Damage**: High Roll + damage, then affinities (vulnerable, resistant, immune, absorb). Guard gives resistance, which cancels a vulnerability.
- **Items**: Remedy and Elixir, 3 IP each.
- **0 HP**: heroes surrender and foes are defeated.

**Smart tactics**: every choice is scored from the exact odds of the dice.
- It focuses on dangerous and wounded targets, takes the kill when it can, and exploits weaknesses.
- It heals the ally in the worst shape, guards when low, drinks potions when it matters, and saves Mind Points until they count.
- Heroes can learn affinities by hitting instead of knowing them from the start.
- With smart tactics off, choices are looser and targets random.

Not simulated: class skills, NPC skills, status effects, opportunities, Zero Powers and other special rules. They usually help whoever has them, so treat the result as a guide and expect skilled heroes to do somewhat better.

## Results
- **Summary**: difficulty (Trivial, Easy, Fair, Hard, Deadly), win rate, average rounds, HP left, hero KO rate and initiative won.
- **Notes** call out what drives the fight: a foe that deals most of the damage, a hero who keeps falling, casters running dry, fights that drag or end too fast.
- **Charts** of rounds per battle and heroes standing at the end.
- **Per hero**: KO rate, HP and MP left, damage dealt and taken, healing, hit rate, spells, items and guards per battle.
- **Per foe**: how often it is defeated, its damage and share, the heroes it knocks out, and damage taken.
- **A sample battle**, turn by turn.

API: `game.modules.get('fu-combat-simulator').api` → `open()`, `specFrom(actor)`, `simulate(heroes, foes, options)`, `battle(heroes, foes, options)`.

Fonts: Antonio and PT Sans, SIL Open Font License (see fonts/).
