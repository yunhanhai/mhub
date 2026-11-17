// Draft a pointer or keyboard seek against one attached source; commit once when the gesture finishes.
export function createSeekInput({ readState, seek, onChange = () => {} }) {
  let pointer = null, inputCommit = null, cancelledChange = false;
  const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -10, PageUp: 10 };
  const clamp = (value, max) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  function state() {
    const value = readState();
    const duration = Number.isFinite(value.duration) && value.duration > 0 ? value.duration : 0;
    const enabled = Boolean(value.key && duration && value.enabled);
    if (pointer && (!enabled || pointer.key !== value.key)) pointer.cancelled = true;
    if (inputCommit && inputCommit.key !== value.key) inputCommit = null;
    return { key: value.key, duration, enabled, position: clamp(value.position, duration) };
  }
  function apply(value, snapshot) {
    const seconds = clamp(value, snapshot.duration);
    inputCommit = { key: snapshot.key, seconds };
    seek(seconds * 1000); onChange(); return true;
  }
  function end(id) {
    if (!pointer || pointer.id !== id) return false;
    const snapshot = state(), draft = pointer; pointer = null;
    if (draft.cancelled || !draft.changed || !snapshot.enabled || draft.key !== snapshot.key) { cancelledChange = true; onChange(); return false; }
    return apply(draft.seconds, snapshot);
  }
  return {
    begin(id) {
      const snapshot = state();
      if (!snapshot.enabled || pointer && pointer.id !== id) return false;
      pointer = { id, key: snapshot.key, seconds: snapshot.position, changed: false, cancelled: false, keyboard: false };
      inputCommit = null; cancelledChange = false; onChange(); return true;
    },
    input(value) {
      const snapshot = state();
      if (!snapshot.enabled || !Number.isFinite(value)) return false;
      if (pointer) {
        if (pointer.cancelled) { onChange(); return false; }
        pointer.seconds = clamp(value, snapshot.duration); pointer.changed = true; onChange(); return true;
      }
      cancelledChange = false; return apply(value, snapshot);
    },
    change(value) {
      if (pointer) return end(pointer.id);
      if (cancelledChange) { cancelledChange = false; return false; }
      const snapshot = state();
      if (!snapshot.enabled || !Number.isFinite(value)) return false;
      if (inputCommit?.key === snapshot.key && inputCommit.seconds === clamp(value, snapshot.duration)) { inputCommit = null; return false; }
      const result = apply(value, snapshot); inputCommit = null; return result;
    },
    end,
    keydown(key) {
      const snapshot = state();
      if (!snapshot.enabled || !(key in steps || key === 'Home' || key === 'End') || pointer && !pointer.keyboard) return false;
      if (!pointer) pointer = { id: 'keyboard', keyboard: true, key: snapshot.key, seconds: snapshot.position, changed: false, cancelled: false };
      if (pointer.cancelled) return true;
      pointer.seconds = clamp(key === 'Home' ? 0 : key === 'End' ? snapshot.duration : pointer.seconds + steps[key], snapshot.duration);
      pointer.changed = true; inputCommit = null; cancelledChange = false; onChange(); return true;
    },
    keyup(key) {
      if (!pointer?.keyboard || !(key in steps || key === 'Home' || key === 'End')) return false;
      end('keyboard'); return true;
    },
    cancel({ release = false } = {}) {
      if (!pointer) return false;
      pointer.cancelled = true;
      if (release || pointer.keyboard) { pointer = null; cancelledChange = true; }
      onChange(); return true;
    },
    view() {
      const snapshot = state(), preview = Boolean(pointer && !pointer.cancelled);
      return { enabled: snapshot.enabled, max: snapshot.duration || 1,
        value: preview ? clamp(pointer.seconds, snapshot.duration) : snapshot.position, preview, editing: Boolean(pointer),
        pointerId: pointer && !pointer.keyboard ? pointer.id : null };
    },
  };
}
