// Small presentation helpers. Geometry is authored locally; no remote assets.
const paths = {
  music: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/><path d="M9 9l10-2"/>',
  library: '<path d="M4 5h3v15H4zM10 5h3v15h-3zM16 4l3-1 4 15-3 1z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
  previous: '<path d="M5 5v14m14-14-11 7 11 7z"/>',
  next: '<path d="M19 5v14M5 5l11 7-11 7z"/>',
  queue: '<path d="M4 6h13M4 12h9M4 18h9m4-6 5 3-5 3z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon: '<path d="M20.7 14a9 9 0 0 1-10.8-10.8A9 9 0 1 0 20.7 14Z"/>',
  volume: '<path d="M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M3 9h4l5-4v14l-5-4H3zM17 9l5 6m0-6-5 6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M6 12a6 6 0 0 1 6-6m6 6a6 6 0 0 1-6 6"/>',
};

export function iconMarkup(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.music}</svg>`;
}

export function coverTone(track) {
  const identity = track?.songId || track?.title || '';
  return [...identity].reduce((sum, character) => sum + character.codePointAt(0), 0) % 3;
}

// Abstract sleeve placeholders, never presented as an upstream album cover.
export function coverMarkup(track) {
  const tone = coverTone(track);
  const art = [
    '<path d="M0 44h120v20H0z" fill="#344846"/><circle cx="82" cy="42" r="26" fill="#ebe2be"/><path d="M0 78h120v42H0z" fill="#52716a"/><path d="M0 84h120M0 91h120M0 98h120" stroke="#a9c8b3" stroke-width="2"/>',
    '<path d="M0 0h120v120H0z" fill="#9cafc4"/><circle cx="60" cy="60" r="43" fill="#354c6b"/><circle cx="60" cy="60" r="28" fill="none" stroke="#8fa8c3" stroke-width="1.5"/><circle cx="60" cy="60" r="17" fill="#b9cbdc"/><circle cx="60" cy="60" r="4" fill="#354c6b"/>',
    '<path d="M0 0h120v120H0z" fill="#c6b498"/><path d="M16 16h88v88H16z" fill="#635c48"/><circle cx="60" cy="60" r="33" fill="#d8cdb6"/><circle cx="60" cy="60" r="21" fill="none" stroke="#8b7f63"/><path d="M55 55h10v10H55z" fill="#635c48"/>',
  ];
  return `<svg viewBox="0 0 120 120" fill="none" aria-hidden="true" focusable="false"><path d="M0 0h120v120H0z" fill="#97b4a2"/>${art[tone]}</svg>`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
