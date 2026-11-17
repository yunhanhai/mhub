// Use the full representation identity at the adapter boundary. Navidrome IDs
// are local to an instance; a version is the trusted original-file SHA-256.
export function representationKey(instanceId, songId, version) {
  return 'library-lab:' + [instanceId, songId, version, 'raw'].map(encodeURIComponent).join(':');
}
