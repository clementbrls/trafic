import type { MapId } from '../game/maps';

export interface Theme {
  dark: boolean;
  bg: string;
  ground: string;
  groundEdge: string;
  locked: string;
  water: string;
  waterLocked: string;
  waterEdge: string;
  road: string;
  avenue: string;
  roadShadow: string;
  bridgeDeck: string;
  bridgeRail: string;
  motorway: string;
  motorwayEdge: string;
  motorwayShadow: string;
  motorwayLine: string;
  tree: string;
  treeDark: string;
  lot: string;
  lotLine: string;
  pin: string;
  grid: string;
  hover: string;
  danger: string;
  ok: string;
  island: string;
  shadow: string;
}

const LIGHT_GROUND: Record<MapId, string> = {
  plaine: '#F4EFE6',
  riviere: '#EEF1E8',
  archipel: '#F5EEE0',
};

export function makeTheme(dark: boolean, map: MapId): Theme {
  if (dark) {
    return {
      dark,
      bg: '#15171C',
      ground: '#23262E',
      groundEdge: 'rgba(255,255,255,0.06)',
      locked: 'rgba(0,0,0,0.38)',
      water: '#1E3448',
      waterLocked: '#1A2B3B',
      waterEdge: 'rgba(120,170,220,0.10)',
      road: '#5C6070',
      avenue: '#6A6F81',
      roadShadow: 'rgba(0,0,0,0.25)',
      bridgeDeck: '#666B7D',
      bridgeRail: '#8D92A3',
      motorway: '#7A7F93',
      motorwayEdge: '#30333D',
      motorwayShadow: 'rgba(0,0,0,0.35)',
      motorwayLine: 'rgba(255,255,255,0.35)',
      tree: '#2C3B31',
      treeDark: '#26332A',
      lot: '#383C47',
      lotLine: 'rgba(255,255,255,0.14)',
      pin: '#FFFFFF',
      grid: 'rgba(255,255,255,0.07)',
      hover: 'rgba(255,255,255,0.10)',
      danger: '#FF6B5E',
      ok: '#57D18F',
      island: '#2C3B31',
      shadow: 'rgba(0,0,0,0.30)',
    };
  }
  return {
    dark,
    bg: '#E4DFD5',
    ground: LIGHT_GROUND[map],
    groundEdge: 'rgba(90,75,55,0.10)',
    locked: 'rgba(125,112,92,0.13)',
    water: '#A9D0EA',
    waterLocked: '#A0C5DD',
    waterEdge: 'rgba(255,255,255,0.35)',
    road: '#4F5361',
    avenue: '#434653',
    roadShadow: 'rgba(60,50,40,0.10)',
    bridgeDeck: '#5D6170',
    bridgeRail: '#FFFFFF',
    motorway: '#3B3F4C',
    motorwayEdge: '#FBF9F5',
    motorwayShadow: 'rgba(45,40,60,0.20)',
    motorwayLine: 'rgba(255,255,255,0.55)',
    tree: '#C3D7AA',
    treeDark: '#AFCA93',
    lot: '#FFFFFF',
    lotLine: 'rgba(80,80,90,0.16)',
    pin: '#FFFFFF',
    grid: 'rgba(90,75,55,0.13)',
    hover: 'rgba(40,40,60,0.10)',
    danger: '#E5483B',
    ok: '#2E9E63',
    island: '#C3D7AA',
    shadow: 'rgba(60,45,30,0.16)',
  };
}
