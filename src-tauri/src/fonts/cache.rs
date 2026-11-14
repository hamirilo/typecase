//! Font files already read and unpacked (`to_sfnt`), kept for the next command
//! about the same font. A grid tile asks for its sample line
//! (`font_list_preview`) and its font (`font_data`) at the same moment; each
//! used to read the whole file (several MB for a Japanese font) and unpack it
//! again. Now the first one reads it and the other waits for that and shares it.
//!
//! Keyed by the file's path, size and modified time, so a changed file is read
//! again. The least recently used are dropped past `BUDGET` bytes.

use super::to_sfnt;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

/// Bytes of unpacked fonts kept: room for a screen of tiles of Japanese fonts.
const BUDGET: usize = 128 * 1024 * 1024;

pub type Sfnt = Arc<Vec<u8>>;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
}

/// One file: empty until read (its lock is held while reading, so a second
/// caller waits instead of reading it too), and empty again if that failed.
type Slot = Arc<Mutex<Option<Sfnt>>>;

struct Entry {
    slot: Slot,
    used: u64,
}

pub struct Cache {
    budget: usize,
    inner: Mutex<(HashMap<Key, Entry>, u64)>,
}

impl Cache {
    pub fn new(budget: usize) -> Self {
        Cache { budget, inner: Mutex::new((HashMap::new(), 0)) }
    }

    /// The file at `path` (of type `ext`) as plain OpenType data.
    pub fn load(&self, path: &Path, ext: &str) -> Result<Sfnt, String> {
        let meta = fs::metadata(path).map_err(|e| e.to_string())?;
        let key = Key { path: path.to_path_buf(), len: meta.len(), modified: meta.modified().ok() };
        let slot = {
            let mut guard = self.inner.lock().unwrap();
            let (map, tick) = &mut *guard;
            *tick += 1;
            let e = map.entry(key).or_insert_with(|| Entry { slot: Slot::default(), used: 0 });
            e.used = *tick;
            e.slot.clone()
        };
        let mut s = slot.lock().unwrap();
        if let Some(data) = &*s {
            return Ok(data.clone());
        }
        let read = fs::read(path).map_err(|e| e.to_string()).and_then(|d| to_sfnt(&d, ext)).map(Arc::new);
        if let Ok(data) = &read {
            *s = Some(data.clone());
        }
        drop(s);
        self.trim();
        read
    }

    /// Drops the least recently used files past the budget, and the slots of
    /// files that failed. Slots being read now are left alone.
    fn trim(&self) {
        let mut guard = self.inner.lock().unwrap();
        let map = &mut guard.0;
        let mut kept: Vec<(u64, usize, Key)> = Vec::new();
        let mut failed: Vec<Key> = Vec::new();
        for (k, e) in map.iter() {
            let Ok(s) = e.slot.try_lock() else { continue };
            match &*s {
                Some(d) => kept.push((e.used, d.len(), k.clone())),
                None => failed.push(k.clone()),
            }
        }
        for k in failed {
            map.remove(&k);
        }
        let mut total: usize = kept.iter().map(|(_, n, _)| n).sum();
        kept.sort_by_key(|(used, _, _)| *used);
        for (_, n, k) in kept {
            if total <= self.budget {
                break;
            }
            map.remove(&k);
            total -= n;
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().0.len()
    }
}

static CACHE: LazyLock<Cache> = LazyLock::new(|| Cache::new(BUDGET));

/// The font file at `path` (of type `ext`) as plain OpenType data, read once
/// for the commands that ask about it in a row.
pub fn load(path: &Path, ext: &str) -> Result<Sfnt, String> {
    CACHE.load(path, ext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn reads_a_file_once_for_callers_at_the_same_time() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(dir.path(), "a.ttf", &[1; 1000]);
        let cache = Arc::new(Cache::new(1 << 20));
        let loads: Vec<Sfnt> = (0..8)
            .map(|_| {
                let (cache, p) = (cache.clone(), p.clone());
                thread::spawn(move || cache.load(&p, "ttf").unwrap())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        assert!(loads.iter().all(|d| Arc::ptr_eq(d, &loads[0])));
        assert_eq!(*loads[0], vec![1; 1000]);
    }

    #[test]
    fn reads_a_changed_file_again() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(dir.path(), "a.ttf", &[1; 10]);
        let cache = Cache::new(1 << 20);
        let first = cache.load(&p, "ttf").unwrap();
        write(dir.path(), "a.ttf", &[2; 20]);
        let second = cache.load(&p, "ttf").unwrap();
        assert_eq!(*first, vec![1; 10]);
        assert_eq!(*second, vec![2; 20]);
    }

    #[test]
    fn drops_the_least_recently_used_past_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let a = write(dir.path(), "a.ttf", &[1; 100]);
        let b = write(dir.path(), "b.ttf", &[2; 100]);
        let c = write(dir.path(), "c.ttf", &[3; 100]);
        let cache = Cache::new(250);
        let first_a = cache.load(&a, "ttf").unwrap();
        cache.load(&b, "ttf").unwrap();
        // `a` used again: `b` is now the oldest.
        assert!(Arc::ptr_eq(&first_a, &cache.load(&a, "ttf").unwrap()));
        cache.load(&c, "ttf").unwrap();
        assert_eq!(cache.len(), 2);
        assert!(Arc::ptr_eq(&first_a, &cache.load(&a, "ttf").unwrap()));
    }

    #[test]
    fn a_failed_read_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let p = write(dir.path(), "a.woff2", b"not a font");
        let cache = Cache::new(1 << 20);
        assert!(cache.load(&p, "woff2").is_err());
        assert_eq!(cache.len(), 0);
    }
}
