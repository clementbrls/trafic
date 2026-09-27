import { h } from './dom';
import { icons } from './icons';
import { t, getLang, type StrKey } from '../i18n';
import { MAPS, getMap, generateWorld, type MapId } from '../game/maps';
import { PALETTE } from '../game/constants';
import { storage, type ThemePref } from '../storage';
import type { RoadType, Tool } from '../game/builder';
import type { Game, Upgrade, UpgradeKind } from '../game/game';
import type { Lang } from '../i18n';

export interface HudState {
  tool: Tool;
  roadType: RoadType;
  paused: boolean;
  speed: number;
  zoomedIn: boolean;
  heat: boolean;
}

export interface UiHandlers {
  play(map: MapId): void;
  togglePause(): void;
  toggleSpeed(): void;
  toggleHeat(): void;
  tool(tool: Tool): void;
  roadType(t: RoadType): void;
  resume(): void;
  restart(): void;
  menu(): void;
  choose(i: number): void;
  recenter(): void;
  settingsChanged(): void;
  replayTutorial(): void;
  click(): void;
}

const TOOL_ORDER: Tool[] = ['road', 'erase', 'roundabout', 'light', 'motorway', 'rules'];
const TOOL_ICON: Record<Tool, string> = {
  road: icons.road,
  erase: icons.erase,
  roundabout: icons.roundabout,
  light: icons.light,
  motorway: icons.motorway,
  rules: icons.rules,
};
const TYPE_ORDER: RoadType[] = ['street', 'avenue', 'oneway'];
const TYPE_ICON: Record<RoadType, string> = { street: icons.street, avenue: icons.avenue, oneway: icons.oneway };

const UPGRADE_ICON: Record<UpgradeKind, string> = {
  roads: icons.road,
  bridge: icons.bridge,
  roundabout: icons.roundabout,
  lights: icons.light,
  motorway: icons.motorway,
};

export interface OverData {
  score: number;
  week: number;
  record: boolean;
  best: number;
  map: MapId;
  roads: number;
  maxCars: number;
  avgTrip: number;
  /** trips per week, the current (unfinished) week last */
  history: number[];
}

/** one decimal, localised (4,7 in French) */
function num(v: number): string {
  return v.toLocaleString(getLang() === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}

function stat(value: string, label: string): HTMLElement {
  return h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));
}

/** tiny bar chart of trips per week (last bar highlighted) */
function weekChart(values: number[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const n = Math.max(1, values.length);
  const W = 240;
  const H = 46;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'week-chart');
  const max = Math.max(1, ...values);
  const gap = 3;
  const bw = Math.min(22, (W - gap * (n - 1)) / n);
  const x0 = (W - (bw * n + gap * (n - 1))) / 2;
  values.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (H - 4));
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', String(x0 + i * (bw + gap)));
    r.setAttribute('y', String(H - bh));
    r.setAttribute('width', String(bw));
    r.setAttribute('height', String(bh));
    r.setAttribute('rx', String(Math.min(4, bw / 3)));
    r.setAttribute('class', i === values.length - 1 ? 'bar last' : 'bar');
    svg.append(r);
  });
  return svg;
}

export class Ui {
  readonly root: HTMLElement;
  private handlers: UiHandlers;
  private hud!: HTMLElement;
  private scoreNum!: HTMLElement;
  private scoreBox!: HTMLElement;
  private weekRing!: SVGCircleElement;
  private weekDay!: HTMLElement;
  private weekLbl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private speedBtn!: HTMLButtonElement;
  private heatBtn!: HTMLButtonElement;
  private recenterBtn!: HTMLButtonElement;
  private weekBox!: HTMLElement;
  private toolbar!: HTMLElement;
  private typeBar!: HTMLElement;
  private typeBtns = new Map<RoadType, HTMLButtonElement>();
  private lastPaused: boolean | null = null;
  private toolBtns = new Map<Tool | 'bridge', HTMLButtonElement>();
  private toolCounts = new Map<Tool | 'bridge', HTMLElement>();
  private toasts!: HTMLElement;
  private toolHintEl!: HTMLElement;
  private hintEl: HTMLElement | null = null;
  private screen: HTMLElement | null = null;
  private lastScore = -1;
  private toolHintTimer = 0;
  private seen = new Set<string>();
  private selectedMap: MapId;
  screenName = '';

  constructor(root: HTMLElement, handlers: UiHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.selectedMap = storage.settings.lastMap;
    this.buildHud();
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  private buildHud(): void {
    const H = this.handlers;
    this.scoreNum = h('span', { class: 'num' }, '0');
    this.scoreBox = h('div', { class: 'score panel', title: '' },
      h('div', { class: 'car-dot' }),
      h('div', null, this.scoreNum, h('div', { class: 'lbl' }, t('trips'))),
    );
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    const bg = document.createElementNS(ns, 'circle');
    bg.setAttribute('cx', '18');
    bg.setAttribute('cy', '18');
    bg.setAttribute('r', '14');
    bg.setAttribute('class', 'ring-bg');
    this.weekRing = document.createElementNS(ns, 'circle');
    this.weekRing.setAttribute('cx', '18');
    this.weekRing.setAttribute('cy', '18');
    this.weekRing.setAttribute('r', '14');
    this.weekRing.setAttribute('class', 'ring');
    this.weekRing.setAttribute('stroke-dasharray', String(2 * Math.PI * 14));
    svg.append(bg, this.weekRing);
    this.weekDay = h('span', { class: 'day' }, '');
    this.weekLbl = h('span', { class: 'wk' }, '');
    const week = h('div', { class: 'week panel' });
    week.append(svg, h('div', { class: 'txt' }, this.weekDay, this.weekLbl));
    this.weekBox = week;

    this.pauseBtn = h('button', { class: 'round-btn panel', 'aria-label': t('pause'), title: t('pause'), onclick: () => { H.click(); H.togglePause(); } }, icons.pause);
    this.speedBtn = h('button', { class: 'round-btn panel', 'aria-label': t('speed'), title: t('speed'), onclick: () => { H.click(); H.toggleSpeed(); } }, icons.fast);
    this.heatBtn = h('button', { class: 'round-btn panel', 'aria-label': t('heat'), title: t('heat'), onclick: () => { H.click(); H.toggleHeat(); } }, icons.heat);
    this.recenterBtn = h('button', { class: 'round-btn panel recenter', 'aria-label': t('recenter'), title: t('recenter'), onclick: () => { H.click(); H.recenter(); } }, icons.target);
    this.recenterBtn.style.display = 'none';

    const top = h('div', { class: 'hud-top' },
      h('div', { class: 'hud-left' }, this.scoreBox, week),
      h('div', { class: 'hud-right' }, this.heatBtn, this.speedBtn, this.pauseBtn),
    );

    // road class picker (shown above the toolbar while drawing roads)
    this.typeBar = h('div', { class: 'types panel gone' });
    for (const rt of TYPE_ORDER) {
      const b = h('button', {
        class: 'type',
        'aria-label': t(`type_${rt}` as StrKey),
        title: t(`typeHint_${rt}` as StrKey),
        onclick: () => { H.click(); H.roadType(rt); },
      }, TYPE_ICON[rt], h('span', null, t(`type_${rt}` as StrKey)));
      this.typeBtns.set(rt, b);
      this.typeBar.append(b);
    }

    this.toolbar = h('div', { class: 'toolbar panel' });
    for (const tool of TOOL_ORDER) {
      const count = h('span', { class: 'count' }, '');
      const btn = h('button', {
        class: 'tool',
        'aria-label': t(`tool_${tool}` as StrKey),
        title: t(`tool_${tool}` as StrKey),
        onclick: () => { H.click(); H.tool(tool); },
      }, TOOL_ICON[tool], h('span', { class: 'name' }, t(`tool_${tool}` as StrKey)), count);
      if (tool === 'erase' || tool === 'rules') count.style.display = 'none';
      this.toolBtns.set(tool, btn);
      this.toolCounts.set(tool, count);
      this.toolbar.append(btn);
    }
    // bridges are not a tool (they are placed automatically) but we show the stock
    const bCount = h('span', { class: 'count' }, '0');
    const bBtn = h('button', {
      class: 'tool',
      'aria-label': t('tool_bridge'),
      title: t('upgradeDesc_bridge'),
      onclick: () => { H.click(); this.toast(t('upgradeDesc_bridge')); },
    }, icons.bridge, h('span', { class: 'name' }, t('tool_bridge')), bCount);
    this.toolBtns.set('bridge', bBtn);
    this.toolCounts.set('bridge', bCount);
    this.toolbar.insertBefore(bBtn, this.toolBtns.get('roundabout') as HTMLElement);

    this.toasts = h('div', { class: 'toasts' });
    this.toolHintEl = h('div', { class: 'tool-hint panel' }, '');
    this.hud = h('div', { class: 'hud hidden' }, top, this.typeBar, this.toolbar, this.recenterBtn, this.toolHintEl, this.toasts);
    this.root.append(this.hud);
    this.lastPaused = null;
  }

  setHudVisible(v: boolean): void {
    this.hud.classList.toggle('hidden', !v);
  }

  /** Rebuild texts after a language change */
  relabel(): void {
    this.root.removeChild(this.hud);
    this.toolBtns.clear();
    this.toolCounts.clear();
    this.lastScore = -1;
    this.buildHud();
  }

  updateHud(game: Game, st: HudState): void {
    const { tool, paused, speed, zoomedIn } = st;
    if (game.score !== this.lastScore) {
      if (this.lastScore >= 0 && game.score > this.lastScore) {
        this.scoreBox.classList.remove('bump');
        void this.scoreBox.offsetWidth;
        this.scoreBox.classList.add('bump');
      }
      this.lastScore = game.score;
      this.scoreNum.textContent = String(game.score);
    }
    const days = t('days').split(',');
    const dayTxt = days[game.day] ?? '';
    if (this.weekDay.textContent !== dayTxt) this.weekDay.textContent = dayTxt;
    const rush = game.isRush;
    const lbl = rush ? t('rush') : t('week', { n: game.week });
    if (this.weekLbl.textContent !== lbl) this.weekLbl.textContent = lbl;
    this.weekBox.classList.toggle('rush', rush);
    const c = 2 * Math.PI * 14;
    this.weekRing.setAttribute('stroke-dashoffset', String(c * (1 - game.weekProgress)));
    if (this.lastPaused !== paused) {
      this.lastPaused = paused;
      this.pauseBtn.innerHTML = paused ? icons.play : icons.pause;
    }
    this.pauseBtn.classList.toggle('on', paused);
    this.speedBtn.classList.toggle('on', speed > 1);
    this.speedBtn.dataset.speed = speed > 1 ? `×${speed}` : '';
    this.heatBtn.classList.toggle('on', st.heat);
    this.recenterBtn.style.display = zoomedIn ? '' : 'none';

    const inv = game.inv;
    const counts: Record<string, number> = {
      road: inv.roads, bridge: inv.bridges, roundabout: inv.roundabouts, light: inv.lights, motorway: inv.motorways,
    };
    for (const [k, btn] of this.toolBtns) {
      const cnt = this.toolCounts.get(k) as HTMLElement;
      if (k === 'rules') {
        btn.classList.toggle('gone', !game.rulesUnlocked);
      } else if (k !== 'erase') {
        const v = counts[k] ?? 0;
        if (cnt.textContent !== String(v)) cnt.textContent = String(v);
        if (v > 0) this.seen.add(k);
        const visible = k === 'road' || this.seen.has(k);
        btn.classList.toggle('gone', !visible);
        btn.classList.toggle('empty', v <= 0);
      }
      btn.classList.toggle('active', k === tool);
    }
    const showTypes = tool === 'road' && game.typesUnlocked;
    this.typeBar.classList.toggle('gone', !showTypes);
    for (const [rt, b] of this.typeBtns) b.classList.toggle('on', rt === st.roadType);
  }

  resetSeen(): void {
    this.seen.clear();
  }

  shakeTool(tool: Tool | 'bridge'): void {
    const b = this.toolBtns.get(tool);
    if (!b) return;
    b.classList.remove('shake');
    void b.offsetWidth;
    b.classList.add('shake');
  }

  markFresh(tool: Tool | 'bridge'): void {
    const b = this.toolBtns.get(tool);
    if (!b) return;
    b.classList.remove('fresh');
    void b.offsetWidth;
    b.classList.add('fresh');
  }

  showToolHint(text: string): void {
    this.toolHintEl.textContent = text;
    this.toolHintEl.classList.add('show');
    window.clearTimeout(this.toolHintTimer);
    this.toolHintTimer = window.setTimeout(() => this.toolHintEl.classList.remove('show'), 2200);
  }

  toast(msg: string, warn = false, ms = 2600): void {
    // avoid stacking identical messages
    for (const el of Array.from(this.toasts.children)) if (el.textContent === msg && !el.classList.contains('out')) return;
    const el = h('div', { class: `toast panel${warn ? ' warn' : ''}` }, msg);
    this.toasts.append(el);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    window.setTimeout(() => {
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 320);
    }, ms);
  }

  showHint(text: string, onOk?: () => void): void {
    this.hideHint(true);
    const el = h('div', { class: 'hint panel' },
      h('p', null, text),
      h('button', { class: 'mini', onclick: () => { this.handlers.click(); this.hideHint(); onOk?.(); } }, t('tut_ok')),
    );
    this.hintEl = el;
    this.hud.append(el);
  }

  hideHint(instant = false): void {
    const el = this.hintEl;
    if (!el) return;
    this.hintEl = null;
    if (instant) {
      el.remove();
      return;
    }
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 320);
  }

  get hintVisible(): boolean {
    return this.hintEl !== null;
  }

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------

  private open(el: HTMLElement, name: string): void {
    this.closeScreen(true);
    this.screen = el;
    this.screenName = name;
    this.root.append(el);
  }

  closeScreen(instant = false): void {
    const el = this.screen;
    if (!el) return;
    this.screen = null;
    this.screenName = '';
    if (instant) {
      el.remove();
      return;
    }
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 260);
  }

  get hasScreen(): boolean {
    return this.screen !== null;
  }

  showMenu(): void {
    const H = this.handlers;
    const best = MAPS.map((m) => storage.best(m.id)?.score ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const el = h('div', { class: 'screen veil' },
      h('div', { class: 'menu' },
        h('h1', { class: 'logo' }, 'trafic', h('span', { class: 'dot' })),
        h('p', { class: 'tagline' }, t('tagline')),
        h('div', { class: 'btn-col' },
          h('button', { class: 'btn', onclick: () => { H.click(); this.showMapSelect(); } }, icons.play, t('play')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.showHowTo(false); } }, t('howTo')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.showSettings(false); } }, icons.settings, t('settings')),
        ),
        best > 0 ? h('div', { class: 'foot' }, `${t('best')} · ${best} ${t('trips')}`) : h('div', { class: 'foot' }, ' '),
      ),
    );
    this.open(el, 'menu');
  }

  showMapSelect(): void {
    const H = this.handlers;
    const cards: HTMLElement[] = [];
    const grid = h('div', { class: 'maps' });
    for (const m of MAPS) {
      const canvas = h('canvas', { width: 300, height: 200 });
      drawMapPreview(canvas, m.id, document.documentElement.dataset.theme === 'dark');
      const b = storage.best(m.id);
      const diff = h('span', { class: 'diff' });
      for (let i = 1; i <= 3; i++) diff.append(h('i', { class: i <= m.difficulty ? 'on' : '' }));
      const card = h('button', {
        class: `map-card${m.id === this.selectedMap ? ' selected' : ''}`,
        onclick: () => {
          H.click();
          this.selectedMap = m.id;
          storage.updateSettings({ lastMap: m.id });
          H.play(m.id);
        },
      },
        canvas,
        h('div', { class: 'minfo' },
          h('div', { class: 'mname' }, t(`map_${m.id}` as StrKey)),
          h('div', { class: 'mdesc' }, t(`mapDesc_${m.id}` as StrKey)),
          h('div', { class: 'meta' },
            h('span', null, b ? `${t('best')} ${b.score}` : t('noBest')),
            diff,
          ),
        ),
      );
      cards.push(card);
      grid.append(card);
    }
    const el = h('div', { class: 'screen veil' },
      h('div', { class: 'modal wide' },
        h('h2', null, t('chooseMap')),
        h('p', { class: 'sub' }, t('tagline')),
        grid,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.showMenu(); } }, t('back')),
        ),
      ),
    );
    this.open(el, 'maps');
  }

  showHowTo(inGame: boolean): void {
    const H = this.handlers;
    const colors = [PALETTE[0].base, PALETTE[1].base, PALETTE[2].base, PALETTE[3].base];
    const touch = matchMedia('(pointer: coarse)').matches;
    const steps = h('div', { class: 'steps' });
    for (let i = 1; i <= 4; i++) {
      steps.append(h('div', { class: 'step' },
        h('div', { class: 'n', style: `background:${colors[i - 1]}` }, String(i)),
        h('div', null,
          h('h4', null, t(`how_${i}_t` as StrKey)),
          h('p', null, t(`how_${i}` as StrKey)),
        ),
      ));
    }
    const el = h('div', { class: 'screen backdrop' },
      h('div', { class: 'modal' },
        h('h2', null, t('howTo')),
        h('p', { class: 'sub' }, t('tagline')),
        steps,
        h('div', { class: 'controls-note' }, h('b', null, `${t('controls')} · `), touch ? t('ctl_mobile') : t('ctl_desktop')),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => { H.click(); if (inGame) this.showPause(); else this.showMenu(); } }, t('back')),
        ),
      ),
    );
    this.open(el, 'howto');
  }

  showSettings(inGame: boolean): void {
    const H = this.handlers;
    const s = storage.settings;
    const seg = <T extends string | boolean>(opts: [T, string][], value: T, set: (v: T) => void) => {
      const wrap = h('div', { class: 'seg' });
      const btns: HTMLButtonElement[] = [];
      for (const [v, label] of opts) {
        const b = h('button', {
          class: v === value ? 'on' : '',
          onclick: () => {
            H.click();
            set(v);
            btns.forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            H.settingsChanged();
          },
        }, label);
        btns.push(b);
        wrap.append(b);
      }
      return wrap;
    };
    const row = (label: string, ctl: HTMLElement) => h('div', { class: 'setting' }, h('span', null, label), ctl);
    const langNow: Lang = s.lang ?? getLang();
    const content = h('div', null,
      row(t('sound'), seg<boolean>([[true, t('on')], [false, t('off')]], s.sound, (v) => storage.updateSettings({ sound: v }))),
      row(t('music'), seg<boolean>([[true, t('on')], [false, t('off')]], s.music, (v) => storage.updateSettings({ music: v }))),
      row(t('theme'), seg<ThemePref>([['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')]], s.theme, (v) => storage.updateSettings({ theme: v }))),
      row(t('language'), seg<Lang>([['fr', 'Français'], ['en', 'English']], langNow, (v) => {
        storage.updateSettings({ lang: v });
        window.setTimeout(() => this.showSettings(inGame), 0);
      })),
    );
    const el = h('div', { class: `screen${inGame ? ' backdrop' : ''}` },
      h('div', { class: 'modal' },
        h('h2', null, t('settings')),
        h('p', { class: 'sub' }, ' '),
        content,
        h('div', { class: 'btn-row', style: 'margin-top:16px;align-items:center' },
          h('button', { class: 'link-btn', onclick: () => { H.click(); H.replayTutorial(); this.toast(t('replayTutorial')); } }, t('replayTutorial')),
          h('button', { class: 'link-btn', onclick: () => { H.click(); storage.resetBest(); this.toast(t('resetDone')); } }, t('resetScores')),
        ),
        h('div', { class: 'btn-row', style: 'margin-top:10px' },
          h('button', { class: 'btn', onclick: () => { H.click(); if (inGame) this.showPause(); else this.showMenu(); } }, t('back')),
        ),
      ),
    );
    this.open(el, 'settings');
  }

  showPause(): void {
    const H = this.handlers;
    const el = h('div', { class: 'screen backdrop' },
      h('div', { class: 'modal center' },
        h('h2', null, t('paused')),
        h('p', { class: 'sub' }, ' '),
        h('div', { class: 'btn-col' },
          h('button', { class: 'btn', onclick: () => { H.click(); H.resume(); } }, icons.play, t('resume')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); H.restart(); } }, icons.restart, t('restart')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.showHowTo(true); } }, t('howTo')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.showSettings(true); } }, icons.settings, t('settings')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); H.menu(); } }, icons.home, t('mainMenu')),
        ),
      ),
    );
    this.open(el, 'pause');
  }

  showWeek(week: number, choices: Upgrade[], bonus: number, history: { trips: number; avgTrip: number }[] = []): void {
    const H = this.handlers;
    const grid = h('div', { class: 'choices' });
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    let recap: HTMLElement | null = null;
    if (last) {
      const delta = prev && prev.trips > 0 ? Math.round(((last.trips - prev.trips) / prev.trips) * 100) : null;
      recap = h('div', { class: 'recap' },
        weekChart(history.map((w) => w.trips)),
        h('div', { class: 'recap-txt' },
          h('b', null, t('recapTrips', { n: last.trips })),
          delta !== null ? h('span', { class: delta >= 0 ? 'up' : 'down' }, `${delta >= 0 ? '+' : ''}${delta} %`) : null,
          last.avgTrip > 0 ? h('span', { class: 'muted' }, t('recapAvg', { s: num(last.avgTrip) })) : null,
        ),
      );
    }
    choices.forEach((u, i) => {
      grid.append(h('button', {
        class: 'choice',
        onclick: () => { H.click(); H.choose(i); },
      },
        h('div', { class: 'big-icon' }, UPGRADE_ICON[u.kind]),
        h('div', { class: 'ctitle' }, upgradeTitle(u)),
        h('div', { class: 'cdesc' }, t(`upgradeDesc_${u.kind}` as StrKey)),
      ));
    });
    const el = h('div', { class: 'screen backdrop' },
      h('div', { class: 'modal center' },
        h('h2', null, t('weekTitle', { n: week - 1 })),
        recap,
        h('p', { class: 'sub' }, t('weekSub')),
        h('div', { class: 'bonus' }, icons.plus, t('weekBonus', { n: bonus })),
        grid,
      ),
    );
    this.open(el, 'week');
  }

  showGameOver(d: OverData): void {
    const H = this.handlers;
    const el = h('div', { class: 'screen backdrop' },
      h('div', { class: 'modal center over' },
        h('h2', null, t('overTitle')),
        h('p', { class: 'sub', style: 'margin-bottom:6px' }, t('overSub')),
        h('div', { class: 'big' }, String(d.score)),
        h('div', { class: 'unit' }, t('overScore')),
        d.record ? h('div', { class: 'record' }, t('newRecord')) : null,
        h('div', { class: 'row' },
          h('span', null, `${t(`map_${d.map}` as StrKey)} · ${t('overWeeks', { n: d.week })}`),
          h('span', null, `${t('best')} ${Math.max(d.best, d.score)}`),
        ),
        d.history.length > 1 ? h('div', { class: 'over-chart' }, weekChart(d.history), h('div', { class: 'muted' }, t('overChart'))) : null,
        h('div', { class: 'stats' },
          stat(d.avgTrip > 0 ? `${num(d.avgTrip)} s` : '–', t('statAvgTrip')),
          stat(String(d.roads), t('statRoads')),
          stat(String(d.maxCars), t('statCars')),
        ),
        h('div', { class: 'btn-col' },
          h('button', { class: 'btn', onclick: () => { H.click(); H.restart(); } }, icons.restart, t('retry')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); this.share(d); } }, icons.share, t('share')),
          h('button', { class: 'btn secondary', onclick: () => { H.click(); H.menu(); } }, icons.home, t('mainMenu')),
        ),
      ),
    );
    this.open(el, 'over');
  }

  private share(d: OverData): void {
    const text = t('shareText', { n: d.score, map: t(`map_${d.map}` as StrKey) });
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) {
      nav.share({ text, url: location.href }).catch(() => {});
      return;
    }
    navigator.clipboard?.writeText(`${text} ${location.href}`).then(() => this.toast(t('copied')), () => {});
  }
}

function upgradeTitle(u: Upgrade): string {
  switch (u.kind) {
    case 'roads': return t('upgrade_roads', { n: u.amount });
    case 'bridge': return u.amount === 1 ? t('upgrade_bridge1') : t('upgrade_bridge', { n: u.amount });
    case 'roundabout': return t('upgrade_roundabout');
    case 'lights': return t('upgrade_lights', { n: u.amount });
    case 'motorway': return t('upgrade_motorway');
  }
}

/** Quick terrain thumbnail for the map picker. */
export function drawMapPreview(canvas: HTMLCanvasElement, id: MapId, dark: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const world = generateWorld(getMap(id), false);
  const cw = canvas.width;
  const ch = canvas.height;
  const s = Math.min(cw / world.w, ch / world.h);
  const ox = (cw - world.w * s) / 2;
  const oy = (ch - world.h * s) / 2;
  const ground = dark ? '#23262E' : id === 'riviere' ? '#EEF1E8' : id === 'archipel' ? '#F5EEE0' : '#F4EFE6';
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = dark ? '#1E3448' : '#A9D0EA';
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      if (world.isWater(x, y)) ctx.fillRect(ox + x * s - 0.3, oy + y * s - 0.3, s + 0.6, s + 0.6);
    }
  }
  ctx.fillStyle = dark ? '#2C3B31' : '#C3D7AA';
  for (let y = 0; y < world.h; y++) {
    for (let x = 0; x < world.w; x++) {
      const tr = world.trees[world.idx(x, y)];
      if (tr) {
        ctx.beginPath();
        ctx.arc(ox + (x + 0.5) * s, oy + (y + 0.5) * s, s * (0.18 + tr * 0.06), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // a few fake buildings for flavour
  const cols = [PALETTE[0].base, PALETTE[1].base, PALETTE[2].base];
  const b = world.bounds;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const spots = [[cx - 1, cy - 1.5, 0], [cx + 4, cy + 1, 1], [cx - 6, cy + 1.5, 2]];
  for (const [x, y, c] of spots) {
    ctx.fillStyle = cols[c];
    const r = s * 0.35;
    const px = ox + x * s;
    const py = oy + y * s;
    ctx.beginPath();
    ctx.roundRect(px, py, s * 2, s * 2, r);
    ctx.fill();
  }
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.15)' : 'rgba(80,70,50,0.18)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(ox + b.x0 * s, oy + b.y0 * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
}
