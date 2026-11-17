//! A single process owns a cache directory. Files are the recovery record:
//! only a verified, synced original is renamed from .partial to .audio.
use super::*;
use std::fs::{self, File, OpenOptions};

struct Record {
    size: u64,
    used: u64,
}
#[derive(Default)]
struct DiskState {
    files: HashMap<String, Record>,
    leases: HashMap<String, usize>,
    reserved: HashMap<String, u64>,
    recovered: u64,
    evicted: u64,
}
pub(super) struct Disk {
    root: PathBuf,
    limit: u64,
    state: Mutex<DiskState>,
    _lock: File,
}
pub(super) struct Lease {
    disk: Arc<Disk>,
    name: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.disk.state.lock().unwrap();
        if let Some(count) = state.leases.get_mut(&self.name) {
            *count -= 1;
            if *count == 0 {
                state.leases.remove(&self.name);
            }
        }
    }
}
pub(super) struct Reservation {
    disk: Arc<Disk>,
    name: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.disk.state.lock().unwrap().reserved.remove(&self.name);
    }
}

pub(super) fn name(key: &str) -> String {
    format!("{}.audio", hex_hash(key.as_bytes()))
}
fn digest_name(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn managed_audio(value: &str) -> bool {
    value.strip_suffix(".audio").is_some_and(digest_name)
}
fn managed_partial(value: &str) -> bool {
    let Some(value) = value.strip_suffix(".partial") else {
        return false;
    };
    let Some((hash, nonce)) = value.split_once('.') else {
        return false;
    };
    digest_name(hash)
        && nonce.len() == 16
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

impl Disk {
    pub(super) fn open(root: &Path, limit: u64, current: &HashSet<String>) -> Result<Arc<Self>> {
        if limit == 0 {
            return Err(internal());
        }
        fs::create_dir_all(root).map_err(|_| internal())?;
        let root = fs::canonicalize(root).map_err(|_| internal())?;
        let lock_path = root.join(".mhub-library.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|m| !m.is_file()) {
            return Err(internal());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path).map_err(|_| internal())?;
        lock.try_lock()
            .map_err(|_| error(500, "cache_in_use", "缓存目录正在被其他进程使用"))?;
        let disk = Arc::new(Self {
            root,
            limit,
            state: Mutex::new(DiskState::default()),
            _lock: lock,
        });
        // Acquire the OS lock before examining or removing crash remnants.
        let mut state = disk.state.lock().unwrap();
        for item in fs::read_dir(&disk.root).map_err(|_| internal())? {
            let item = item.map_err(|_| internal())?;
            let file_name = item.file_name().to_string_lossy().into_owned();
            if item.file_type().map_err(|_| internal())?.is_file() && managed_partial(&file_name) {
                fs::remove_file(disk.root.join(file_name)).map_err(|_| internal())?;
                state.recovered += 1;
            }
        }
        disk.refresh(&mut state)?;
        disk.reclaim(&mut state, current, &HashSet::new(), 0)?;
        drop(state);
        Ok(disk)
    }
    pub(super) fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    pub(super) fn lease(self: &Arc<Self>, name: &str) -> Lease {
        *self
            .state
            .lock()
            .unwrap()
            .leases
            .entry(name.to_owned())
            .or_default() += 1;
        Lease {
            disk: self.clone(),
            name: name.to_owned(),
        }
    }
    fn refresh(&self, state: &mut DiskState) -> Result<()> {
        let mut found = HashSet::new();
        for item in fs::read_dir(&self.root).map_err(|_| internal())? {
            let item = item.map_err(|_| internal())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if managed_partial(&name)
                && item.file_type().map_err(|_| internal())?.is_file()
                && !state
                    .reserved
                    .contains_key(&format!("{}.audio", &name[..64]))
            {
                // No live transfer owns this partial. Retrying cleanup here
                // also handles a transient failure in the cancellation guard;
                // a persistent IO error rejects admission instead of escaping
                // quota accounting.
                fs::remove_file(self.root.join(&name)).map_err(|_| internal())?;
                state.recovered += 1;
                continue;
            }
            if !managed_audio(&name) || !item.file_type().map_err(|_| internal())?.is_file() {
                continue;
            }
            let metadata = item.metadata().map_err(|_| internal())?;
            let used = state.files.get(&name).map(|r| r.used).unwrap_or_else(|| {
                metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });
            found.insert(name.clone());
            state.files.insert(
                name,
                Record {
                    size: metadata.len(),
                    used,
                },
            );
        }
        state.files.retain(|name, _| found.contains(name));
        Ok(())
    }
    fn usage(state: &DiskState) -> u64 {
        state
            .files
            .values()
            .map(|r| r.size)
            .chain(state.reserved.values().copied())
            .fold(0, u64::saturating_add)
    }
    fn reclaim(
        &self,
        state: &mut DiskState,
        current: &HashSet<String>,
        pinned: &HashSet<String>,
        needed: u64,
    ) -> Result<()> {
        let mut candidates: Vec<_> = state
            .files
            .iter()
            .filter(|(name, _)| {
                !pinned.contains(*name)
                    && !state.leases.contains_key(*name)
                    && !state.reserved.contains_key(*name)
            })
            .map(|(name, record)| (current.contains(name), record.used, name.clone()))
            .collect();
        candidates.sort();
        for (is_current, _, name) in candidates {
            if is_current && Self::usage(state).saturating_add(needed) <= self.limit {
                break;
            }
            // Only recognized regular files directly under the canonical cache
            // root are deleted. No recursion or following directory links.
            if fs::symlink_metadata(self.path(&name)).is_ok_and(|m| m.is_file()) {
                fs::remove_file(self.path(&name)).map_err(|_| internal())?;
                state.evicted += 1;
            }
            state.files.remove(&name);
        }
        if Self::usage(state).saturating_add(needed) > self.limit {
            return Err(error(507, "cache_capacity", "缓存空间正在使用，请稍后重试"));
        }
        Ok(())
    }
    pub(super) fn maintain(
        &self,
        current: &HashSet<String>,
        pinned: &HashSet<String>,
    ) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        self.refresh(&mut state)?;
        self.reclaim(&mut state, current, pinned, 0)
    }
    pub(super) fn reserve(
        self: &Arc<Self>,
        name: &str,
        size: u64,
        current: &HashSet<String>,
        pinned: &HashSet<String>,
    ) -> Result<Reservation> {
        let mut state = self.state.lock().unwrap();
        self.refresh(&mut state)?;
        self.reclaim(&mut state, current, pinned, size)?;
        state.reserved.insert(name.to_owned(), size);
        Ok(Reservation {
            disk: self.clone(),
            name: name.to_owned(),
        })
    }
    pub(super) fn discard(&self, name: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.leases.get(name).copied().unwrap_or(0) > 1 {
            return Err(error(409, "cache_busy", "缓存正在读取，请稍后重试"));
        }
        fs::remove_file(self.path(name)).map_err(|_| internal())?;
        state.files.remove(name);
        Ok(())
    }
    pub(super) fn touch(&self, name: &str) {
        if let Some(record) = self.state.lock().unwrap().files.get_mut(name) {
            record.used = now();
        }
    }
    pub(super) fn publish(&self, partial: &Path, name: &str, size: u64) -> Result<PathBuf> {
        let mut state = self.state.lock().unwrap();
        let file = self.path(name);
        fs::rename(partial, &file).map_err(|_| internal())?;
        // Rename and reservation conversion share the same lock as eviction.
        state.reserved.remove(name);
        state
            .files
            .insert(name.to_owned(), Record { size, used: now() });
        Ok(file)
    }
    pub(super) fn diagnostics(&self, counters: &mut Counters) {
        let state = self.state.lock().unwrap();
        counters.cache_bytes = state.files.values().map(|r| r.size).sum();
        counters.reserved_bytes = state.reserved.values().sum();
        counters.recovered_partials = state.recovered;
        counters.cache_evictions = state.evicted;
        counters.active_file_leases = state.leases.values().sum::<usize>() as u64;
    }
}
