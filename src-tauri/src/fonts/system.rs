//! Fonts installed on this computer (docs/SYSTEM_FONTS.md): listed next to
//! the library's fonts, read only. They are never imported
//! and never stored in the library: the list is read from the OS's font
//! folders (the ones resvg's font database finds).
//!
//! Reading every font file takes a while (a Mac has a few gigabytes of them),
//! so what was read is kept in a cache file in the app's cache folder and only
//! files that are new or changed are read again.

use super::{meta, to_sfnt, FontMeta};
use rayon::prelude::*;
use resvg::usvg::fontdb;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Ids of installed fonts start with this, so they are never taken for a
/// library item (the frontend's `isSystemId`).
pub const ID_PREFIX: &str = "sys:";

/// Files larger than this are left out. The largest real fonts (CJK
/// collections, the colour emoji) are around 200 MB.
const MAX_FILE: u64 = 256 << 20;

/// Bumped when what is read from a font changes, so the cache is read again.
const CACHE_VERSION: u32 = 3;
const CACHE_FILE: &str = "system-fonts.json";

/// One font file installed on this computer (a collection is one entry, like
/// a library item). What the list shows, filters and groups it by.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    /// `ID_PREFIX` and a hash of the PostScript name (see `assign_ids`): the
    /// same font has the same id on another computer.
    pub id: String,
    pub path: PathBuf,
    pub file_name: String,
    /// Lower case, e.g. "ttc".
    pub ext: String,
    pub size: u64,
    /// When the file was last changed (ms since 1970); 0 when unknown.
    pub modified: i64,
    /// Full name of the first font, e.g. "Hiragino Sans W3".
    pub name: String,
    /// PostScript name of the first font ("" when it has none): what tells the
    /// same font in the library (`items.font_ps_name`).
    pub ps_name: String,
    pub family: String,
    pub weight: u32,
    pub weight_min: u32,
    pub weight_max: u32,
    pub script: String,
    pub category: Option<String>,
    pub features: Vec<String>,
    /// Variation axes (`fonts::AXES`), empty unless variable.
    #[serde(default)]
    pub axes: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Cache {
    version: u32,
    fonts: Vec<SystemFont>,
}

/// The list read last, so a font's data is only read from a path that was
/// listed (the frontend only ever sends an id).
static LISTED: Mutex<Option<Arc<Vec<SystemFont>>>> = Mutex::new(None);

pub fn is_system_id(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

fn hash_id(key: &str) -> String {
    let hash = Sha256::digest(key.as_bytes());
    format!("{ID_PREFIX}{}", hex::encode(&hash[..12]))
}

/// Ids from the PostScript name, so a font put on a library's shelf is found
/// again when the library is opened on another computer that has it. A second
/// file with the same name (another copy installed by hand) is told by its
/// place among them (by path); a font without one by its path.
fn assign_ids(fonts: &mut [SystemFont]) {
    let mut order: Vec<usize> = (0..fonts.len()).collect();
    order.sort_by(|&a, &b| fonts[a].path.cmp(&fonts[b].path));
    let mut seen: HashMap<String, usize> = HashMap::new();
    for i in order {
        let f = &mut fonts[i];
        let key = if f.ps_name.is_empty() {
            format!("path\0{}", f.path.to_string_lossy())
        } else {
            let n = seen.entry(f.ps_name.clone()).or_insert(0);
            *n += 1;
            if *n == 1 {
                f.ps_name.clone()
            } else {
                format!("{}\0{n}", f.ps_name)
            }
        };
        f.id = hash_id(&key);
    }
}

/// Font files in the OS's font folders (fontdb knows them on every platform,
/// including fonts downloaded on demand on macOS and per-user fonts on Windows).
fn font_files() -> Vec<PathBuf> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let paths: BTreeSet<PathBuf> = db
        .faces()
        .filter_map(|f| match &f.source {
            fontdb::Source::File(p) => Some(p.clone()),
            fontdb::Source::SharedFile(p, _) => Some(p.clone()),
            _ => None,
        })
        .collect();
    paths.into_iter().collect()
}

fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// Size and last change of a file; None when it can't be read or is too big.
fn stat(path: &Path) -> Option<(u64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    if !m.is_file() || m.len() > MAX_FILE {
        return None;
    }
    let modified = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    Some((m.len(), modified))
}

/// Reads one installed font; None when it isn't a font this app can read.
fn read_font(path: &Path, size: u64, modified: i64) -> Option<SystemFont> {
    let ext = ext_of(path);
    if !crate::import::SUPPORTED_EXTS.contains(&ext.as_str()) {
        return None;
    }
    let sfnt = to_sfnt(&std::fs::read(path).ok()?, &ext).ok()?;
    let FontMeta { family, weight, weight_min, weight_max, script, category, features, axes, ps_name } = meta(&sfnt).ok()?;
    let name = super::faces(&sfnt).ok()?.into_iter().next().map(|f| f.full_name).unwrap_or_default();
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    Some(SystemFont {
        // Set once every font is read (`assign_ids`).
        id: String::new(),
        path: path.to_path_buf(),
        name: if name.is_empty() { file_name.clone() } else { name },
        ps_name,
        file_name,
        ext,
        size,
        modified,
        family,
        weight,
        weight_min,
        weight_max,
        script: script.to_string(),
        category: category.map(str::to_string),
        features: features.into_iter().map(str::to_string).collect(),
        axes: axes.into_iter().map(str::to_string).collect(),
    })
}

fn read_cache(dir: &Path) -> HashMap<PathBuf, SystemFont> {
    let Ok(text) = std::fs::read_to_string(dir.join(CACHE_FILE)) else { return HashMap::new() };
    match serde_json::from_str::<Cache>(&text) {
        Ok(c) if c.version == CACHE_VERSION => c.fonts.into_iter().map(|f| (f.path.clone(), f)).collect(),
        _ => HashMap::new(),
    }
}

fn write_cache(dir: &Path, fonts: &[SystemFont]) {
    let cache = Cache { version: CACHE_VERSION, fonts: fonts.to_vec() };
    let written = std::fs::create_dir_all(dir)
        .and_then(|_| std::fs::write(dir.join(CACHE_FILE), serde_json::to_vec(&cache).unwrap_or_default()));
    if let Err(e) = written {
        log::warn!("could not save the installed fonts' cache: {e}");
    }
}

/// Reads `paths`, taking what didn't change from `cached`. Sorted by name.
fn read_all(paths: &[PathBuf], cached: &HashMap<PathBuf, SystemFont>) -> Vec<SystemFont> {
    let mut fonts: Vec<SystemFont> = paths
        .par_iter()
        .filter_map(|p| {
            let (size, modified) = stat(p)?;
            match cached.get(p) {
                Some(f) if f.size == size && f.modified == modified => Some(f.clone()),
                _ => read_font(p, size, modified),
            }
        })
        .collect();
    fonts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    assign_ids(&mut fonts);
    fonts
}

/// The installed fonts. Read once per run; `reload` looks at the font
/// folders again (fonts installed or removed since). `cache_dir` is the
/// app's cache folder.
pub fn list(cache_dir: &Path, reload: bool) -> Arc<Vec<SystemFont>> {
    if !reload {
        if let Some(l) = LISTED.lock().unwrap().as_ref() {
            return l.clone();
        }
    }
    let cached = read_cache(cache_dir);
    let fonts = read_all(&font_files(), &cached);
    if fonts.len() != cached.len() || fonts.iter().any(|f| cached.get(&f.path) != Some(f)) {
        write_cache(cache_dir, &fonts);
    }
    let fonts = Arc::new(fonts);
    *LISTED.lock().unwrap() = Some(fonts.clone());
    fonts
}

/// The installed font with this id, from the list read last.
pub fn find(id: &str) -> Result<SystemFont, String> {
    LISTED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|l| l.iter().find(|f| f.id == id).cloned())
        .ok_or_else(|| "このフォントは見つかりません（この端末から削除された可能性があります）".into())
}

/// The font file of an installed font, unpacked like a library font's.
pub fn sfnt(id: &str) -> Result<Vec<u8>, String> {
    let font = find(id)?;
    if stat(&font.path).is_none() {
        return Err("このフォントは読めません（この端末から削除された可能性があります）".into());
    }
    to_sfnt(&std::fs::read(&font.path).map_err(|e| e.to_string())?, &font.ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_installed_fonts_and_reuses_the_cache() {
        let paths = font_files();
        let Some(path) = paths.iter().find(|p| stat(p).is_some() && read_font(p, 0, 0).is_some()) else { return };
        let one = vec![path.clone()];

        let fonts = read_all(&one, &HashMap::new());
        assert_eq!(fonts.len(), 1);
        let f = &fonts[0];
        assert!(is_system_id(&f.id));
        assert!(!f.family.is_empty() && !f.name.is_empty());

        // Unchanged files come from the cache (here marked by a name the file doesn't have).
        let mut cached = f.clone();
        cached.name = "cached".into();
        let again = read_all(&one, &HashMap::from([(path.clone(), cached.clone())]));
        assert_eq!(again[0].name, "cached");
        // A changed file is read again.
        cached.size += 1;
        let changed = read_all(&one, &HashMap::from([(path.clone(), cached)]));
        assert_eq!(changed[0].name, f.name);
    }

    fn font(path: &str, ps_name: &str) -> SystemFont {
        SystemFont {
            id: String::new(),
            path: path.into(),
            file_name: "A.ttf".into(),
            ext: "ttf".into(),
            size: 10,
            modified: 1,
            name: "A Regular".into(),
            ps_name: ps_name.into(),
            family: "A".into(),
            weight: 400,
            weight_min: 400,
            weight_max: 400,
            script: "latin".into(),
            category: None,
            features: vec!["mono".into()],
            axes: vec![],
        }
    }

    #[test]
    fn ids_follow_the_postscript_name() {
        let mut here = vec![font("/Library/Fonts/A.ttf", "A-Regular"), font("/fonts/B.ttf", "")];
        let mut there = vec![font("/Users/me/Library/Fonts/A.ttf", "A-Regular"), font("/other/B.ttf", "")];
        assign_ids(&mut here);
        assign_ids(&mut there);
        assert_eq!(here[0].id, there[0].id, "the same font elsewhere has the same id");
        assert_ne!(here[1].id, there[1].id, "without a name, the path tells it");
        assert!(here.iter().all(|f| is_system_id(&f.id)));

        // Two copies of one font: both listed, the first by path keeps the plain id.
        let mut both = vec![font("/z/A.ttf", "A-Regular"), font("/a/A.ttf", "A-Regular")];
        assign_ids(&mut both);
        assert_eq!(both[1].id, here[0].id);
        assert_ne!(both[0].id, both[1].id);
    }

    #[test]
    fn the_cache_round_trips_and_ignores_other_versions() {
        let dir = tempfile::tempdir().unwrap();
        let mut font = font("/fonts/A.ttf", "A-Regular");
        assign_ids(std::slice::from_mut(&mut font));
        write_cache(dir.path(), std::slice::from_ref(&font));
        assert_eq!(read_cache(dir.path()).get(Path::new("/fonts/A.ttf")), Some(&font));

        std::fs::write(dir.path().join(CACHE_FILE), r#"{"version":0,"fonts":[]}"#).unwrap();
        assert!(read_cache(dir.path()).is_empty());
        std::fs::write(dir.path().join(CACHE_FILE), "not json").unwrap();
        assert!(read_cache(dir.path()).is_empty());
    }

    #[test]
    fn only_listed_fonts_are_read() {
        assert!(sfnt("sys:not-listed").is_err());
        assert!(!is_system_id("0b5c…"));
    }
}
