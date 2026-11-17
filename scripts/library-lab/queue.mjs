// Explicit queue operations for the isolated library; the shared player owns transport state.
export function libraryTrackKey(track) {
  return track?.instanceId && track?.songId && track?.version
    ? JSON.stringify([track.instanceId, track.songId, track.version]) : '';
}

function snapshotItems(items) {
  const seen = new Set();
  return (items || []).filter(track => {
    const key = libraryTrackKey(track);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(track => ({ ...track }));
}

export function createLibraryQueue({ player, queue, status }) {
  const indexOf = track => queue.queue.findIndex(item => libraryTrackKey(item) === libraryTrackKey(track));
  return {
    append(items) { return player.insertManyToQueue(snapshotItems(items), queue.queueLength); },
    next(items) { return player.queueNextMany(snapshotItems(items)); },
    async replace(items, selected = items?.[0]) {
      const snapshot = snapshotItems(items);
      const index = snapshot.findIndex(item => libraryTrackKey(item) === libraryTrackKey(selected));
      if (!snapshot.length) return false;
      return player.playFrom(snapshot, Math.max(0, index));
    },
    async play(track, initialList = [track]) {
      if (!libraryTrackKey(track)) return false;
      if (!queue.queueLength) return this.replace(initialList, track);
      const index = indexOf(track);
      return index >= 0 ? player.playAtIndex(index) : player.playNow({ ...track });
    },
    async at(index) {
      return index >= 0 && index < queue.queueLength ? player.playAtIndex(index) : false;
    },
    async step(direction) {
      const index = status.playIndex + direction;
      if (status.playIndex < 0 || index < 0 || index >= queue.queueLength) return false;
      return player.playAtIndex(index);
    },
    remove(index) {
      // A removal edits the queue only. Replacing or selecting is the explicit way to change the active source.
      if (index < 0 || index >= queue.queueLength || index === status.playIndex) return false;
      void player.removeFromQueue(index); return true;
    },
    clearUpcoming() {
      const first = Math.max(0, status.playIndex + 1);
      const count = queue.queueLength - first;
      for (let index = queue.queueLength - 1; index >= first; index--) this.remove(index);
      return count;
    },
    restrictOffline(saved, keepCurrent = false) {
      const keys = new Set(snapshotItems(saved).filter(track => track.access === 'public' && track.offlineAllowed).map(libraryTrackKey));
      let count = 0;
      for (let index = queue.queueLength - 1; index >= 0; index--) {
        const track = queue.queue[index];
        if (index === status.playIndex && keepCurrent && track.access === 'public') continue;
        if (!keys.has(libraryTrackKey(track)) && this.remove(index)) count++;
      }
      return count;
    },
  };
}
