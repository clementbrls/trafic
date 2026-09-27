const svg = (body: string, extra = '') => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  road: svg('<path d="M7 21 10 3M17 21 14 3"/><path d="M12 5.5v2.5M12 11v2.5M12 16.5V19" stroke-width="1.8"/>'),
  erase: svg('<path d="M20 20H9.5"/><path d="m4.6 14.6 8.8-8.8a2 2 0 0 1 2.8 0l2.8 2.8a2 2 0 0 1 0 2.8L12 18.4a2 2 0 0 1-1.4.6H8.3a2 2 0 0 1-1.4-.6l-2.3-2.3a1 1 0 0 1 0-1.5Z"/><path d="m9.5 9.8 5 5"/>'),
  bridge: svg('<path d="M2 9h20"/><path d="M4 9v10M20 9v10"/><path d="M4 19c0-5 3.6-7.5 8-7.5s8 2.5 8 7.5"/><path d="M9 9v2.8M15 9v2.8"/>'),
  roundabout: svg('<circle cx="12" cy="12" r="5.2"/><path d="M12 2v4.8M12 17.2V22M2 12h4.8M17.2 12H22"/><path d="m14.6 7.2 1.7-.6.3 1.8" stroke-width="1.6"/>'),
  light: svg('<rect x="7.5" y="2" width="9" height="17" rx="3"/><circle cx="12" cy="6.4" r="1.4"/><circle cx="12" cy="10.5" r="1.4"/><circle cx="12" cy="14.6" r="1.4"/><path d="M12 19v3"/>'),
  rules: svg('<path d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/><path d="M12 7.6 16.4 12 12 16.4 7.6 12Z" fill="currentColor" stroke="none"/>'),
  street: svg('<path d="M8 21 10 3M16 21 14 3"/>'),
  avenue: svg('<path d="M5 21 8 3M19 21 16 3"/><path d="M12 4v3M12 10.5v3M12 17v3" stroke-width="1.8"/>'),
  oneway: svg('<path d="M4 12h13"/><path d="m13 7 5 5-5 5"/>'),
  heat: svg('<path d="M4 18c2.5-6 5.5-9 8-9s5.5 3 8 9"/><circle cx="7" cy="14.5" r="1.3" fill="currentColor"/><circle cx="12" cy="9.5" r="1.3" fill="currentColor"/><circle cx="17" cy="14.5" r="1.3" fill="currentColor"/>'),
  motorway: svg('<path d="M2 16c5-1 7.5-8 10-8s5 7 10 8"/><path d="M5 20v-3.5M19 20v-3.5M12 20v-9"/><path d="M2 20h20" stroke-width="1.6"/>'),
  pause: svg('<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z" fill="currentColor" stroke="none"/>'),
  fast: svg('<path d="M4 6.4v11.2a.8.8 0 0 0 1.2.7l8.3-5.6a.8.8 0 0 0 0-1.4L5.2 5.7A.8.8 0 0 0 4 6.4Z" fill="currentColor" stroke="none"/><path d="M12 6.4v11.2a.8.8 0 0 0 1.2.7l8.3-5.6a.8.8 0 0 0 0-1.4l-8.3-5.6a.8.8 0 0 0-1.2.7Z" fill="currentColor" stroke="none"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  home: svg('<path d="m3 10 9-7 9 7v9.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5Z"/>'),
  target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  sound: svg('<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  warn: svg('<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>'),
  car: svg('<rect x="3" y="8" width="18" height="9" rx="3"/><path d="M6.5 8 8 4.8A1.5 1.5 0 0 1 9.4 4h5.2a1.5 1.5 0 0 1 1.4.8L17.5 8"/><circle cx="7.5" cy="17" r="1.6" fill="currentColor"/><circle cx="16.5" cy="17" r="1.6" fill="currentColor"/>'),
};

export type IconName = keyof typeof icons;
