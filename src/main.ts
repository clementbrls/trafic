import './styles.css';
import { Renderer } from './render/renderer';
import { Ui } from './ui/ui';
import { Input } from './input';
import { Game } from './game/game';
import { Builder, type Feedback, type RoadType, type Tool } from './game/builder';
import { AutoBuilder } from './game/autobuild';
import { getMap, boundsForWeek, type MapId } from './game/maps';
import { PALETTE, OVERFLOW_TIME, PIN_PATIENCE, WARN_STRESS } from './game/constants';
import type { Destination } from './game/entities';
import { randomSeed } from './core/rng';
import { sound } from './audio';
import { storage } from './storage';
import { t, setLang, detectLang, type StrKey } from './i18n';
import type { Padding } from './render/camera';

const STEP = 1 / 60;

/** development helpers: ?nopause&play=plaine */
const DEV_FLAGS = new Set<string>();
const DEV_PLAY = import.meta.env.DEV ? new URLSearchParams(location.search).get('play') : null;
if (import.meta.env.DEV) for (const k of new URLSearchParams(location.search).keys()) DEV_FLAGS.add(k);

type TutStep = 'connect' | 'deliver' | 'erase' | 'junction' | 'overflow' | 'done';

const MILESTONES = [100, 250, 500, 1000, 1500, 2000, 3000, 4000, 5000];

class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
  readonly ui: Ui;
  readonly input: Input;
  game: Game | null = null;
  builder: Builder | null = null;
  demo: Game | null = null;
  mode: 'menu' | 'play' = 'menu';
  paused = false;
  speed = 1;
  tool: Tool = 'road';
  roadType: RoadType = 'street';
  heat = false;
  mapId: MapId = 'plaine';
  private acc = 0;
  private last = 0;
  private overTimer = -1;
  private warnClock = 0;
  private hovering = false;
  private feedbackAt = new Map<string, number>();
  private tut: TutStep = 'done';
  private tutClock = 0;
  private tutRing = 0;
  private dark = false;
  private overflowToasted = new Set<number>();
  private demoClock = 0;
  // contextual advice
  private adviceClock = 0;
  private tipCooldown = 20;
  private jamTime = new Map<number, number>();
  private adviced = new Map<number, number>();
  private lateTipDone = false;
  private milestone = 0;

  constructor() {
    this.canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new Renderer(this.canvas);
    const s = storage.settings;
    setLang(s.lang ?? detectLang());
    sound.sfxOn = s.sound;
    sound.musicOn = s.music;
    sound.volume = s.volume;
    this.ui = new Ui(document.getElementById('ui') as HTMLElement, {
      play: (m) => this.startGame(m),
      togglePause: () => this.togglePause(),
      toggleSpeed: () => this.toggleSpeed(),
      toggleHeat: () => this.toggleHeat(),
      tool: (tl) => this.selectTool(tl),
      roadType: (rt) => this.selectRoadType(rt),
      resume: () => this.resume(),
      restart: () => this.startGame(this.mapId),
      continueFree: () => this.continueFree(),
      menu: () => this.toMenu(),
      focusAlert: () => this.focusAlert(),
      choose: (i) => this.chooseUpgrade(i),
      recenter: () => this.recenter(),
      settingsChanged: () => this.applySettings(),
      replayTutorial: () => storage.updateSettings({ tutorialDone: false }),
      click: () => sound.click(),
    });
    this.input = new Input(this.canvas, {
      cam: this.renderer.cam,
      builder: () => (this.mode === 'play' && this.game?.state !== 'over' && !this.blockingScreen() ? this.builder : null),
      tool: () => this.tool,
      canBuild: () => this.mode === 'play' && !!this.game && this.game.state === 'play' && !this.blockingScreen(),
      canView: () => this.mode === 'play' && !this.blockingScreen(),
      bounds: () => (this.game ? this.game.world.bounds : { x0: 0, y0: 0, x1: 30, y1: 20 }),
      onInteract: () => this.unlockAudio(),
      onHover: (a) => (this.hovering = a),
    });
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', () => this.unlockAudio(), { once: false, passive: true });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.applyTheme();
    this.resize();
    this.buildDemo();
    if (DEV_PLAY === 'plaine' || DEV_PLAY === 'riviere' || DEV_PLAY === 'archipel') this.startGame(DEV_PLAY);
    else this.ui.showMenu();
    requestAnimationFrame((t0) => {
      this.last = t0;
      this.frame(t0);
    });
  }

  private unlockAudio(): void {
    sound.unlock();
    if (sound.musicOn) sound.startMusic();
  }

  // ------------------------------------------------------------------
  // Settings & theme
  // ------------------------------------------------------------------

  private applyTheme(): void {
    const pref = storage.settings.theme;
    this.dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = this.dark ? 'dark' : 'light';
    const map = this.game?.preset.id ?? 'plaine';
    this.renderer.setTheme(this.dark, map);
    const meta = document.querySelector('meta[name="theme-color"]:not([media])') ?? null;
    if (meta) meta.setAttribute('content', this.renderer.theme.bg);
  }

  private applySettings(): void {
    const s = storage.settings;
    sound.setSfx(s.sound);
    sound.setMusic(s.music);
    if (s.music) this.unlockAudio();
    const lang = s.lang ?? detectLang();
    setLang(lang);
    this.ui.relabel();
    this.ui.setHudVisible(this.mode === 'play');
    this.applyTheme();
  }

  // ------------------------------------------------------------------
  // Layout
  // ------------------------------------------------------------------

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.renderer.resize(w, h, dpr);
    this.renderer.cam.setViewport(w, h, this.padding());
    if (this.mode === 'play' && this.game && !this.renderer.cam.manual) this.renderer.cam.fit(this.game.world.bounds);
    if (this.mode === 'menu' && this.demo) this.fitDemo(true);
  }

  private padding(): Padding {
    if (this.mode !== 'play') return { top: 0, right: 0, bottom: 0, left: 0 };
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pad: Padding = { top: 70, right: 10, bottom: 92, left: 10 };
    const tb = document.querySelector('.toolbar');
    const top = document.querySelector('.hud-top');
    if (top) {
      const r = top.getBoundingClientRect();
      if (r.height > r.width) {
        // HUD stacked in a left column (short landscape screens)
        pad.left = r.right + 6;
        pad.top = 12;
      } else {
        pad.top = r.bottom + 6;
      }
    }
    if (tb) {
      const r = tb.getBoundingClientRect();
      if (r.width > 0) {
        if (r.height > r.width) {
          pad.right = w - r.left + 8;
          pad.bottom = 12;
        } else {
          pad.bottom = h - r.top + 8;
          // the road class picker sits above the toolbar once unlocked
          if (this.game?.typesUnlocked) pad.bottom += 50;
        }
      }
    }
    return pad;
  }

  private blockingScreen(): boolean {
    return this.ui.hasScreen;
  }

  // ------------------------------------------------------------------
  // Menu demo
  // ------------------------------------------------------------------

  private buildDemo(): void {
    const portrait = window.innerHeight > window.innerWidth;
    const g = new Game(getMap('plaine'), portrait, randomSeed(), { demo: true });
    g.world.bounds = boundsForWeek(g.world, 5, portrait);
    g.seedDemo(4, 22);
    const bot = new AutoBuilder(g);
    bot.connectAll();
    bot.connectAll();
    // warm up so the menu starts with traffic on the roads
    for (let i = 0; i < 60 * 25; i++) g.step(STEP);
    g.events.length = 0;
    this.demo = g;
    this.renderer.resetBounds(g.world.bounds);
    this.fitDemo(true);
  }

  private fitDemo(instant: boolean): void {
    if (!this.demo) return;
    const cam = this.renderer.cam;
    cam.setViewport(window.innerWidth, window.innerHeight, { top: 0, right: 0, bottom: 0, left: 0 });
    const b = this.demo.world.bounds;
    cam.fit({ x0: b.x0 + 2, y0: b.y0 + 1, x1: b.x1 - 2, y1: b.y1 - 1 }, instant);
  }

  // ------------------------------------------------------------------
  // Game flow
  // ------------------------------------------------------------------

  private startGame(map: MapId): void {
    this.mapId = map;
    this.ui.closeScreen();
    this.mode = 'play';
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    const g = new Game(getMap(map), portrait, randomSeed());
    this.game = g;
    this.builder = new Builder(g);
    this.builder.onFeedback = (f, x, y) => this.feedback(f, x, y);
    this.builder.onBuild = (s, x, y, n) => this.onBuild(s, x, y, n);
    this.paused = false;
    this.speed = 1;
    this.tool = 'road';
    this.roadType = 'street';
    this.heat = false;
    this.acc = 0;
    this.overTimer = -1;
    this.overflowToasted.clear();
    this.jamTime.clear();
    this.adviced.clear();
    this.lateTipDone = false;
    this.milestone = 0;
    this.tipCooldown = 20;
    this.renderer.fx.clear();
    this.renderer.resetBounds(g.world.bounds);
    this.ui.resetSeen();
    this.ui.hideHint(true);
    this.ui.setHudVisible(true);
    this.applyTheme();
    this.renderer.cam.setViewport(window.innerWidth, window.innerHeight, this.padding());
    // HUD layout needs a frame to settle
    requestAnimationFrame(() => {
      this.renderer.cam.setViewport(window.innerWidth, window.innerHeight, this.padding());
      this.renderer.cam.fit(g.world.bounds, false);
    });
    this.renderer.cam.fit(g.world.bounds, false);
    this.tut = storage.settings.tutorialDone ? 'done' : 'connect';
    this.tutClock = 0;
    if (this.tut === 'connect') {
      const touch = matchMedia('(pointer: coarse)').matches;
      this.ui.showHint(t(touch ? 'tut_1m' : 'tut_1'));
    }
    this.unlockAudio();
  }

  private toMenu(): void {
    this.mode = 'menu';
    this.game = null;
    this.builder = null;
    this.ui.hideHint(true);
    this.ui.setHudVisible(false);
    this.applyTheme();
    if (this.demo) this.renderer.resetBounds(this.demo.world.bounds);
    this.fitDemo(false);
    this.ui.showMenu();
  }

  private togglePause(): void {
    if (this.mode !== 'play' || !this.game || this.game.state !== 'play') return;
    if (this.ui.screenName === 'pause') {
      this.resume();
      return;
    }
    if (this.ui.hasScreen) return;
    this.paused = true;
    this.input.endAll();
    this.ui.showPause();
  }

  private resume(): void {
    this.paused = false;
    this.ui.closeScreen();
  }

  private toggleSpeed(): void {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 3 : 1;
    this.ui.showToolHint(`${t('speed')} ×${this.speed}`);
  }

  private toggleHeat(): void {
    this.heat = !this.heat;
    if (this.heat) this.ui.showToolHint(t('heatOn'));
  }

  private selectRoadType(rt: RoadType): void {
    this.roadType = rt;
    if (this.builder) this.builder.roadType = rt;
    this.tool = 'road';
    this.ui.showToolHint(t(`typeHint_${rt}` as StrKey));
  }

  private selectTool(tl: Tool): void {
    // tapping the active road tool again cycles the road class
    if (tl === 'road' && this.tool === 'road' && this.game?.typesUnlocked) {
      const order: RoadType[] = ['street', 'avenue', 'oneway'];
      this.selectRoadType(order[(order.indexOf(this.roadType) + 1) % order.length]);
      return;
    }
    this.tool = tl;
    const g = this.game;
    if (g) {
      const empty =
        (tl === 'roundabout' && g.inv.roundabouts <= 0) ||
        (tl === 'light' && g.inv.lights <= 0) ||
        (tl === 'motorway' && g.inv.motorways <= 0);
      if (empty) this.ui.shakeTool(tl);
    }
    this.ui.showToolHint(t(`toolHint_${tl}` as StrKey));
  }

  private chooseUpgrade(i: number): void {
    const g = this.game;
    if (!g) return;
    const u = g.pendingChoices[i];
    g.chooseUpgrade(i);
    this.ui.closeScreen();
    if (u) {
      const map: Record<string, Tool | 'bridge'> = { roads: 'road', bridge: 'bridge', roundabout: 'roundabout', lights: 'light', motorway: 'motorway' };
      window.setTimeout(() => this.ui.markFresh(map[u.kind]), 100);
    }
    sound.item();
  }

  private recenter(): void {
    if (!this.game) return;
    this.renderer.cam.setViewport(window.innerWidth, window.innerHeight, this.padding());
    this.renderer.cam.fit(this.game.world.bounds);
  }

  private onVisibility(): void {
    if (DEV_FLAGS.has('nopause')) return;
    if (document.hidden) {
      this.input.endAll();
      if (this.mode === 'play' && this.game?.state === 'play' && !this.ui.hasScreen) {
        this.paused = true;
        this.ui.showPause();
      }
      sound.suspend();
    } else {
      sound.resume();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    if (this.mode !== 'play' || !this.game) return;
    if (e.code === 'Space' || e.code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) this.togglePause();
      return;
    }
    if (e.code === 'Escape') {
      if (this.ui.screenName === 'pause') this.resume();
      else if (!this.ui.hasScreen) this.togglePause();
      return;
    }
    if (this.ui.hasScreen) return;
    const tools: Record<string, Tool> = {
      Digit1: 'road', Digit2: 'erase', Digit3: 'roundabout', Digit4: 'light', Digit5: 'motorway', Digit6: 'rules',
    };
    const tl = tools[e.code];
    if (tl) {
      if (tl === 'rules' && !this.game.rulesUnlocked) return;
      if (tl === 'road' && this.tool === 'road') return;
      this.selectTool(tl);
      return;
    }
    if (e.code === 'KeyF' || e.code === 'Tab') {
      e.preventDefault();
      this.toggleSpeed();
    }
    if (e.code === 'KeyT' && this.game.typesUnlocked) {
      const order: RoadType[] = ['street', 'avenue', 'oneway'];
      this.selectRoadType(order[(order.indexOf(this.roadType) + 1) % order.length]);
    }
    if (e.code === 'KeyV') this.toggleHeat();
    if (e.code === 'KeyC') this.recenter();
  }

  // ------------------------------------------------------------------
  // Builder callbacks
  // ------------------------------------------------------------------

  private feedback(f: Feedback, x: number, y: number): void {
    const now = performance.now();
    const last = this.feedbackAt.get(f) ?? 0;
    this.renderer.fx.cross(x, y);
    if (now - last < 1600) return;
    this.feedbackAt.set(f, now);
    sound.error();
    if (matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(15);
    this.ui.toast(t(`fb_${f}` as StrKey), false, 2400);
    if (f === 'noRoads') this.ui.shakeTool('road');
    if (f === 'noBridges') this.ui.shakeTool('bridge');
    if (f === 'noRoundabouts') this.ui.shakeTool('roundabout');
    if (f === 'noLights') this.ui.shakeTool('light');
    if (f === 'noMotorways') this.ui.shakeTool('motorway');
  }

  private onBuild(s: string, x: number, y: number, n: number): void {
    switch (s) {
      case 'road': sound.road(n); break;
      case 'link': sound.link(); break;
      case 'bridge': sound.bridge(); break;
      case 'erase': sound.erase(); break;
      case 'item': sound.item(); this.renderer.fx.ring(x + 0.5, y + 0.5, this.dark ? '#fff' : '#23252d', 0.2, 0.8, 0.5, 0.05); break;
      case 'motorway': sound.motorway(); break;
      case 'style': sound.link(); break;
      case 'rule':
        sound.item();
        this.ui.showToolHint(t(n === 0 ? 'rule_auto' : n === 5 ? 'rule_noleft' : 'rule_axis'));
        this.renderer.fx.ring(x + 0.5, y + 0.5, n === 5 ? this.renderer.theme.danger : '#F2B233', 0.2, 0.7, 0.5, 0.05);
        break;
    }
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------

  private frame = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    try {
      this.update(dt);
      this.draw(dt);
    } catch (err) {
      console.error(err);
    }
    requestAnimationFrame(this.frame);
  };

  private update(dt: number): void {
    const cam = this.renderer.cam;
    if (this.mode === 'menu') {
      const g = this.demo;
      if (g) {
        this.demoClock += dt;
        this.acc += dt;
        let n = 0;
        while (this.acc >= STEP && n < 4) {
          g.step(STEP);
          this.acc -= STEP;
          n++;
        }
        if (n === 4) this.acc = 0;
        g.events.length = 0;
        // keep the demo alive: drain overflowing pins
        for (const d of g.dests) if (d.pins > 5) d.pins = 5;
      }
      cam.update(dt);
      return;
    }
    const g = this.game;
    if (!g) return;
    const running = !this.paused && g.state === 'play' && !this.ui.hasScreen;
    if (running) {
      this.acc += dt * this.speed;
      let n = 0;
      const max = 4 * this.speed;
      while (this.acc >= STEP && n < max) {
        g.step(STEP);
        this.acc -= STEP;
        n++;
      }
      if (n === max) this.acc = 0;
    } else {
      g.syncNetwork();
    }
    this.handleEvents(g);
    this.updateTutorial(g, running ? dt : 0);
    if (running) this.updateAdvice(g, dt * this.speed);

    // periodic warning while something overflows
    const danger = !g.free && g.dests.some((d) => d.timer > OVERFLOW_TIME * 0.35);
    if (danger && running) {
      this.warnClock -= dt;
      if (this.warnClock <= 0) {
        this.warnClock = 2.2;
        sound.warn();
      }
    }

    if (g.state === 'over' && this.overTimer >= 0) {
      this.overTimer -= dt;
      if (this.overTimer < 0) this.showGameOver(g);
    }
    this.ui.updateHud(g, {
      tool: this.tool,
      roadType: this.roadType,
      paused: this.paused,
      speed: this.speed,
      zoomedIn: cam.manual && cam.isZoomedIn,
      heat: this.heat,
      alert: this.alertState(g),
    });
    cam.update(dt);
  }

  private handleEvents(g: Game): void {
    const fx = this.renderer.fx;
    for (const e of g.events) {
      switch (e.type) {
        case 'deliver':
          sound.deliver(e.dest.color);
          break;
        case 'house':
          sound.house();
          fx.ring(e.house.x + 0.5, e.house.y + 0.5, PALETTE[e.house.color].base, 0.2, 0.9, 0.7, 0.06);
          break;
        case 'dest':
          sound.destination();
          fx.ring(e.dest.cx, e.dest.cy, PALETTE[e.dest.color].base, 0.6, 2.4, 1.1, 0.09);
          if (e.newColor && g.dests.length > 1) this.ui.toast(t('toast_newColor'));
          break;
        case 'week':
          sound.week();
          this.input.endAll();
          this.ui.hideHint(true);
          this.ui.showWeek(e.week, e.choices, e.bonus, g.weekStats);
          break;
        case 'over':
          sound.gameOver();
          this.input.endAll();
          this.ui.hideHint(true);
          this.overTimer = 2.2;
          this.renderer.cam.focus(e.dest.cx, e.dest.cy, this.renderer.cam.zoom * 1.7);
          break;
        case 'overflow':
          if (g.free) break;
          if (!this.overflowToasted.has(e.dest.id)) {
            this.overflowToasted.add(e.dest.id);
            this.ui.toast(t('toast_overflow'), true, 3200);
          }
          sound.warn();
          if (this.tut !== 'done' && this.tut !== 'connect') {
            this.ui.showHint(t('tut_3'));
          }
          break;
        case 'poof':
          fx.pop(e.x, e.y, PALETTE[e.color].base);
          sound.poof();
          break;
        case 'bounds':
          this.ui.toast(t('toast_bounds'));
          this.renderer.cam.setViewport(window.innerWidth, window.innerHeight, this.padding());
          this.renderer.cam.fit(g.world.bounds);
          break;
        case 'unlock':
          sound.destination();
          if (e.what === 'types') {
            this.ui.toast(t('unlock_types'));
            this.ui.showHint(t('unlock_types_hint'));
            this.tool = 'road';
          } else {
            this.ui.toast(t('unlock_rules'));
            this.ui.showHint(t('unlock_rules_hint'));
            window.setTimeout(() => this.ui.markFresh('rules'), 150);
          }
          break;
        case 'rush':
          if (e.on) this.ui.toast(t('toast_rush'), false, 2600);
          break;
      }
    }
    g.events.length = 0;
  }

  private updateTutorial(g: Game, dt: number): void {
    if (this.tut === 'done') return;
    this.tutClock += dt;
    const touch = matchMedia('(pointer: coarse)').matches;
    switch (this.tut) {
      case 'connect': {
        this.tutRing -= dt;
        if (this.tutRing <= 0) {
          this.tutRing = 1.6;
          const d = g.dests[0];
          if (d) {
            this.renderer.fx.ring(d.gate.cx, d.gate.cy, PALETTE[d.color].base, 0.3, 1.1, 1.0, 0.06);
            for (const h of g.houses) if (!g.houseConnected(h)) this.renderer.fx.ring(h.x + 0.5, h.y + 0.5, PALETTE[h.color].base, 0.2, 0.9, 1.0, 0.05);
          }
        }
        if (g.houses.some((h) => g.houseConnected(h))) {
          this.tut = 'deliver';
          this.tutClock = 0;
          this.ui.showHint(t('tut_2'));
        }
        break;
      }
      case 'deliver':
        if (this.tutClock > 9) {
          this.ui.hideHint();
          this.tut = 'erase';
          this.tutClock = 0;
        }
        break;
      case 'erase':
        if (this.tutClock > 14) {
          this.ui.showHint(t(touch ? 'tut_4m' : 'tut_4'));
          this.tut = 'junction';
          this.tutClock = 0;
        }
        break;
      case 'junction': {
        if (this.tutClock > 9 && this.ui.hintVisible) this.ui.hideHint();
        let junction = false;
        for (const n of g.net.nodes.values()) {
          if (n.kind === 'road' && n.degree >= 3) {
            junction = true;
            break;
          }
        }
        if (junction && this.tutClock > 3) {
          this.ui.showHint(t('tut_5'));
          this.tut = 'overflow';
          this.tutClock = 0;
          storage.updateSettings({ tutorialDone: true });
        }
        break;
      }
      case 'overflow':
        if (this.tutClock > 10 && this.ui.hintVisible) {
          this.ui.hideHint();
          this.tut = 'done';
        }
        break;
    }
  }

  /**
   * Contextual tips: point at saturated junctions, isolated buildings and
   * celebrate milestones. Rate-limited so they never spam.
   */
  private updateAdvice(g: Game, dt: number): void {
    this.adviceClock -= dt;
    this.tipCooldown -= dt;
    // milestones
    const next = MILESTONES[this.milestone];
    if (next !== undefined && g.score >= next) {
      this.milestone++;
      this.ui.toast(t('milestone', { n: next }));
      sound.week();
    }
    if (this.adviceClock > 0) return;
    this.adviceClock = 1;
    const fx = this.renderer.fx;
    // sustained jams at plain junctions
    for (const j of g.traffic.junctions) {
      const n = j.node;
      const hot = n.control === 'none' && j.queue > 1.7;
      const was = this.jamTime.get(n.id) ?? 0;
      this.jamTime.set(n.id, hot ? was + 1 : Math.max(0, was - 1));
    }
    if (this.tipCooldown <= 0) {
      let worst: { n: import('./game/network').RNode; q: number; majorMask: number } | null = null;
      for (const j of g.traffic.junctions) {
        const n = j.node;
        if ((this.jamTime.get(n.id) ?? 0) < 6) continue;
        if ((this.adviced.get(n.id) ?? -1e9) > g.time - 120) continue;
        if (!worst || j.queue > worst.q) worst = { n, q: j.queue, majorMask: j.majorMask };
      }
      if (worst) {
        const n = worst.n;
        let roadArms = 0;
        for (const l of n.links) if (l && !l.other(n).isTerminal) roadArms++;
        const fixes: string[] = [];
        if (g.inv.roundabouts > 0) fixes.push(t('tip_fix_ring'));
        if (g.inv.lights > 0 && roadArms >= 3) fixes.push(t('tip_fix_light'));
        if (g.rulesUnlocked && worst.majorMask === 0 && g.net.priorityAxes(n).length > 0) fixes.push(t('tip_fix_prio'));
        if (fixes.length === 0) fixes.push(t('tip_fix_road'));
        this.ui.toast(t('tip_jam', { fix: fixes.slice(0, 2).join(t('tip_or')) }), false, 4200);
        fx.ring(n.cx, n.cy, this.renderer.theme.danger, 0.3, 1.4, 1.2, 0.08);
        fx.ring(n.cx, n.cy, this.renderer.theme.danger, 0.2, 1.1, 1.6, 0.05);
        this.adviced.set(n.id, g.time);
        this.tipCooldown = 30;
        return;
      }
      // a building with nobody to serve it
      for (const d of g.dests) {
        if (g.time - d.born < 25 || d.pins < 2) continue;
        if ((this.adviced.get(-d.id) ?? -1e9) > g.time - 90) continue;
        if (g.destConnected(d)) continue;
        this.ui.toast(t('tip_isolated'), true, 3800);
        fx.ring(d.cx, d.cy, PALETTE[d.color].base, 0.8, 2.6, 1.3, 0.1);
        this.adviced.set(-d.id, g.time);
        this.tipCooldown = 25;
        return;
      }
      // first impatient customers of the game
      if (!this.lateTipDone && g.dests.some((d) => d.lateCount(g.time, PIN_PATIENCE) > 0)) {
        this.lateTipDone = true;
        this.ui.toast(t('tip_late'), false, 4000);
        this.tipCooldown = 20;
      }
    }
  }

  /** the building closest to overflowing, if one is worth warning about */
  private urgentDest(g: Game): Destination | null {
    let best: Destination | null = null;
    let top = WARN_STRESS;
    for (const d of g.dests) {
      const s = g.stress(d) + d.timer / OVERFLOW_TIME;
      if (s >= top) {
        top = s;
        best = d;
      }
    }
    return best;
  }

  private alertState(g: Game): { level: 'warn' | 'danger'; seconds: number; color: number } | null {
    if (g.state !== 'play' || g.free) return null;
    const d = this.urgentDest(g);
    if (!d) return null;
    return { level: d.timer > 0 ? 'danger' : 'warn', seconds: Math.max(1, Math.ceil(OVERFLOW_TIME - d.timer)), color: d.color };
  }

  private focusAlert(): void {
    const g = this.game;
    if (!g) return;
    const d = this.urgentDest(g);
    if (d) this.renderer.cam.focus(d.cx, d.cy, this.renderer.cam.zoom);
  }

  /** After a game over: close the summary and let the city run on, without any way to lose. */
  private continueFree(): void {
    const g = this.game;
    if (!g || g.state !== 'over') return;
    g.continueFree();
    this.overTimer = -1;
    this.paused = false;
    this.ui.closeScreen();
    this.recenter();
    this.ui.toast(t('freeModeToast'), false, 3600);
  }

  private showGameOver(g: Game): void {
    const prev = storage.best(g.preset.id)?.score ?? 0;
    const record = storage.submit(g.preset.id, g.score, g.week);
    this.ui.showGameOver({
      score: g.score,
      week: g.week,
      record,
      best: prev,
      map: g.preset.id,
      roads: g.net.roadCount(),
      maxCars: g.stats.maxCars,
      avgTrip: g.stats.trips > 0 ? g.stats.tripSum / g.stats.trips : 0,
      history: [...g.weekStats.map((w) => w.trips), g.currentWeekStats().trips],
    });
  }

  private draw(dt: number): void {
    const game = this.mode === 'play' ? this.game : this.demo;
    if (!game) return;
    const b = this.mode === 'play' ? this.builder : null;
    let hoverValid = true;
    if (b?.hover && this.game) {
      const n = this.game.net.nodeAt(b.hover.x, b.hover.y);
      if (this.tool === 'roundabout') hoverValid = !!n && n.kind === 'road';
      else if (this.tool === 'light' || this.tool === 'rules') hoverValid = !!n && n.kind === 'road' && n.degree >= 3;
      else if (this.tool === 'road') hoverValid = this.game.world.inBounds(b.hover.x, b.hover.y);
    }
    this.renderer.render(game, b, dt, {
      tool: this.tool,
      hoverValid,
      showHover: this.hovering && this.mode === 'play' && !this.ui.hasScreen,
      reducedMotion: false,
      heat: this.mode === 'play' && this.heat,
    });
  }
}

const app = new App();
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;

// offline support once built (not in dev, to keep hot reload predictable)
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
