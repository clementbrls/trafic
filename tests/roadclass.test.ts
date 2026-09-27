import { describe, it, expect } from 'vitest';
import { World } from '../src/game/world';
import { Network } from '../src/game/network';
import { findRoute, isLeftTurn } from '../src/game/pathfind';
import { TERM } from '../src/game/constants';
import { Game } from '../src/game/game';
import { getMap } from '../src/game/maps';
import { Builder } from '../src/game/builder';
import { Junction } from '../src/game/traffic';

function world(w = 12, h = 10): World {
  const wd = new World(w, h);
  wd.bounds = { x0: 0, y0: 0, x1: w, y1: h };
  return wd;
}

describe('road classes', () => {
  it('detects left turns for right-hand traffic', () => {
    // arriving from the west (arm 4) heading east: north (6) is a left turn, south (2) a right turn
    expect(isLeftTurn(4, 6)).toBe(true);
    expect(isLeftTurn(4, 2)).toBe(false);
    expect(isLeftTurn(4, 0)).toBe(false);
    expect(isLeftTurn(4, 4)).toBe(true); // U-turn
  });

  it('routes respect one-way streets', () => {
    const n = new Network(world());
    const row = [];
    for (let x = 1; x <= 5; x++) row.push(n.addRoad(x, 2)!);
    for (let k = 0; k + 1 < row.length; k++) n.linkRoad(row[k], row[k + 1], 0);
    const h = n.addTerminal(1, 1, 'house', 1);
    const g = n.addTerminal(5, 3, 'gate', 2, 6);
    n.linkRoad(h, row[0], 2);
    n.linkRoad(row[4], g, 2);
    expect(findRoute(h, TERM, g, () => 0)).not.toBeNull();
    // make the middle link one-way westbound: no way east anymore
    const mid = row[2].links[0]!;
    n.setLinkStyle(mid, 'street', mid.a === row[2] ? -1 : 1);
    expect(findRoute(h, TERM, g, () => 0)).toBeNull();
    // and the other way round is fine
    n.setLinkStyle(mid, 'street', mid.a === row[2] ? 1 : -1);
    expect(findRoute(h, TERM, g, () => 0)).not.toBeNull();
  });

  it('left-turn bans force a detour', () => {
    const n = new Network(world(12, 10));
    // T junction at (4,4): west arm road, north arm to the gate, east arm loop around
    const w = n.addRoad(3, 4)!;
    const c = n.addRoad(4, 4)!;
    const up = n.addRoad(4, 3)!;
    n.linkRoad(w, c, 0);
    n.linkRoad(c, up, 6);
    const e = n.addRoad(5, 4)!;
    n.linkRoad(c, e, 0);
    const h = n.addTerminal(2, 4, 'house', 1);
    n.linkRoad(h, w, 0);
    const g = n.addTerminal(4, 2, 'gate', 2, 2);
    n.linkRoad(up, g, 6);
    const r1 = findRoute(h, TERM, g, () => 0)!;
    expect(r1.nodes.length).toBe(5);
    n.setRule(c, true);
    // arriving from the west, turning north is a left turn: the car must go east,
    // turn around at the dead end and come back (a right turn)
    const r2 = findRoute(h, TERM, g, () => 0)!;
    expect(r2).not.toBeNull();
    expect(r2.nodes.includes(e)).toBe(true);
    // once the east arm is gone c is a simple bend again: the rule no longer applies
    n.unlink(c.links[0]!);
    expect(findRoute(h, TERM, g, () => 0)!.nodes.includes(e)).toBe(false);
  });

  it('avenues make the crossing streets yield', () => {
    const n = new Network(world());
    const c = n.addRoad(5, 5)!;
    const arms = [n.addRoad(6, 5)!, n.addRoad(5, 6)!, n.addRoad(4, 5)!, n.addRoad(5, 4)!];
    n.linkRoad(c, arms[0], 0);
    n.linkRoad(c, arms[1], 2);
    n.linkRoad(c, arms[2], 4);
    n.linkRoad(c, arms[3], 6);
    const j = new Junction(c);
    // four equal streets: all-way stop
    expect(j.majorMask).toBe(0);
    expect(j.mustStop(0)).toBe(true);
    n.setLinkStyle(c.links[0]!, 'avenue', 0);
    n.setLinkStyle(c.links[4]!, 'avenue', 0);
    j.refresh();
    expect(j.isMajor(0)).toBe(true);
    expect(j.isMajor(4)).toBe(true);
    expect(j.isMinor(2)).toBe(true);
    expect(j.mustStop(0)).toBe(false);
    expect(j.mustStop(6)).toBe(true);
  });
});

describe('builder road types', () => {
  function setup() {
    const game = new Game(getMap('plaine'), false, 5, { demo: true });
    game.world.bounds = { x0: 0, y0: 0, x1: game.world.w, y1: game.world.h };
    return { game, b: new Builder(game) };
  }

  it('avenues cost double and are refunded when erased', () => {
    const { game, b } = setup();
    const start = game.inv.roads;
    b.roadType = 'avenue';
    b.begin(13.5, 10.5);
    b.move(14.5, 10.5);
    b.move(15.5, 10.5);
    b.end();
    // 3 tiles + 2 avenue links
    expect(game.inv.roads).toBe(start - 5);
    expect(game.net.nodeAt(14, 10)!.links[0]!.tier).toBe('avenue');
    b.begin(13.5, 10.5, 'erase');
    b.move(15.5, 10.5);
    b.end();
    expect(game.inv.roads).toBe(start);
  });

  it('upgrades a street by drawing over it, and cancel() restores it', () => {
    const { game, b } = setup();
    b.begin(13.5, 10.5);
    b.move(16.5, 10.5);
    b.end();
    const after = game.inv.roads;
    b.roadType = 'avenue';
    b.begin(13.5, 10.5);
    b.move(16.5, 10.5);
    expect(game.inv.roads).toBe(after - 3);
    b.cancel();
    expect(game.inv.roads).toBe(after);
    expect(game.net.nodeAt(14, 10)!.links[0]!.tier).toBe('street');
  });

  it('one-way streets follow the stroke direction', () => {
    const { game, b } = setup();
    b.roadType = 'oneway';
    b.begin(16.5, 10.5);
    b.move(15.5, 10.5);
    b.move(14.5, 10.5);
    b.end();
    const l = game.net.nodeAt(15, 10)!.links[4]!; // link towards (6,5)
    const from = game.net.nodeAt(15, 10)!;
    expect(l.allows(from)).toBe(true);
    expect(l.allows(l.other(from))).toBe(false);
    // redraw as street: two-way again
    b.roadType = 'street';
    b.begin(14.5, 10.5);
    b.move(16.5, 10.5);
    b.end();
    expect(l.oneway).toBe(0);
  });

  it('junction rules toggle with the rules tool', () => {
    const { game, b } = setup();
    b.begin(13.5, 10.5);
    b.move(15.5, 10.5);
    b.end();
    b.begin(14.5, 9.5);
    b.move(14.5, 10.5);
    b.end();
    const n = game.net.nodeAt(14, 10)!;
    expect(n.degree).toBe(3);
    b.tap(14.5, 10.5, 'rules');
    expect(n.noLeft).toBe(true);
    b.tap(14.5, 10.5, 'rules');
    expect(n.noLeft).toBe(false);
  });
});
