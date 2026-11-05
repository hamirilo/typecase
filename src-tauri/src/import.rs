//! Importing: copy into the library, hash for de-duplication, read the font
//! and render its sample. File work runs in parallel without touching the DB;
//! rows are written afterwards in a single transaction.

use crate::db::{self, NewItem};
use crate::fonts;
use crate::library::{self, Library};
use image::{DynamicImage, ImageFormat};
use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use walkdir::WalkDir;

/// The file types that can be added.
pub const SUPPORTED_EXTS: &[&str] = &["ttf", "otf", "woff", "woff2", "ttc", "otc"];

pub enum Source {
    /// `dirs` is the folder path to file it under, relative to the import
    /// target (e.g. `["Sans", "JP"]` for `Sans/JP/x.otf` from a dropped `Sans`).
    Path { path: PathBuf, dirs: Vec<String> },
    Bytes { name: String, data: Vec<u8> },
}

impl Source {
    pub fn file(path: impl Into<PathBuf>) -> Self {
        Source::Path { path: path.into(), dirs: vec![] }
    }

    fn label(&self) -> String {
        match self {
            Source::Path { path, .. } => path.display().to_string(),
            Source::Bytes { name, .. } => name.clone(),
        }
    }

    fn dirs(&self) -> &[String] {
        match self {
            Source::Path { dirs, .. } => dirs,
            Source::Bytes { .. } => &[],
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub duplicates: usize,
    pub failed: Vec<String>,
    /// The library items the sources ended up as (new and already known), in
    /// import order, for follow-up changes such as tagging.
    #[serde(skip)]
    pub ids: Vec<String>,
}

fn ext_of(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    SUPPORTED_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// Expands dropped paths. Directories are walked recursively and keep their
/// structure as folders (the dropped directory itself becomes a folder);
/// hidden and unsupported files are skipped.
pub fn collect_files(paths: &[PathBuf]) -> Vec<Source> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            let base = p.parent().unwrap_or(p);
            for e in WalkDir::new(p)
                .into_iter()
                .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .filter_map(Result::ok)
            {
                if e.file_type().is_file() && ext_of(&e.file_name().to_string_lossy()).is_some() {
                    let dirs = e
                        .path()
                        .parent()
                        .and_then(|d| d.strip_prefix(base).ok())
                        .map(|rel| {
                            rel.components()
                                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                                .collect()
                        })
                        .unwrap_or_default();
                    out.push(Source::Path { path: e.into_path(), dirs });
                }
            }
        } else if p.is_file() {
            if let Some(name) = p.file_name() {
                if ext_of(&name.to_string_lossy()).is_some() {
                    out.push(Source::file(p.clone()));
                }
            }
        }
    }
    out
}

enum Outcome {
    New(NewItem),
    Duplicate(String), // existing item id
    Failed(String),
}

/// Keeps file names portable across macOS and Windows.
pub(crate) fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() { "font".into() } else { trimmed.into() }
}

/// Writes the rendered sample as the thumbnail (PNG); returns its file name.
pub(crate) fn write_thumb(thumb: &DynamicImage, dir: &Path, id: &str) -> Result<String, String> {
    let name = format!("{id}.png");
    thumb.save_with_format(dir.join(&name), ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(name)
}

fn process(
    src: Source,
    root: &Path,
    known: &HashMap<String, String>,
    seen: &Mutex<HashSet<String>>,
) -> Result<Outcome, String> {
    let (name, data) = match src {
        Source::Path { path, .. } => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            (name, fs::read(path).map_err(|e| e.to_string())?)
        }
        Source::Bytes { name, data } => (name, data),
    };
    let ext = ext_of(&name).ok_or("フォントではありません")?;
    let hash = hex::encode(Sha256::digest(&data));
    if let Some(existing) = known.get(&hash) {
        return Ok(Outcome::Duplicate(existing.clone()));
    }
    // Same file twice in this batch.
    if !seen.lock().unwrap().insert(hash.clone()) {
        return Ok(Outcome::Duplicate(String::new()));
    }

    // Stored as is, with a rendered sample as the thumbnail.
    let sfnt = fonts::to_sfnt(&data, &ext)?;
    let sample = fonts::render_thumb(&sfnt)?;
    let font = fonts::meta(&sfnt)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = sanitize(&name);
    library::store_file(root, &id, &file_name, &data)?;
    let thumb = write_thumb(&sample, &root.join("thumbs"), &id).inspect_err(|_| library::remove_item_dir(root, &id))?;
    Ok(Outcome::New(NewItem { id, name, file_name, ext, size: data.len() as i64, hash, thumb, font }))
}

/// One import at a time: two running at once could each miss the other's
/// files when checking for duplicates.
static RUN_LOCK: Mutex<()> = Mutex::new(());

/// Runs the import. `lib` is locked only briefly at the start and end so the
/// UI stays responsive while files are processed.
pub fn run(
    lib: &Mutex<Option<Library>>,
    sources: Vec<Source>,
    folder_id: Option<String>,
    on_progress: impl Fn(usize, usize) + Sync,
) -> Result<ImportSummary, String> {
    let _running = RUN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (root, known) = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or("ライブラリが開かれていません")?;
        (l.root.clone(), db::hash_index(&l.conn).map_err(|e| e.to_string())?)
    };

    let total = sources.len();
    let done = AtomicUsize::new(0);
    let seen = Mutex::new(HashSet::new());
    on_progress(0, total);
    let outcomes: Vec<(Outcome, Vec<String>)> = sources
        .into_par_iter()
        .map(|src| {
            let (label, dirs) = (src.label(), src.dirs().to_vec());
            let o = process(src, &root, &known, &seen).unwrap_or_else(|e| Outcome::Failed(format!("{label}: {e}")));
            on_progress(done.fetch_add(1, Ordering::Relaxed) + 1, total);
            (o, dirs)
        })
        .collect();

    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    if l.root != root {
        return Err("インポート中にライブラリが切り替わりました".into());
    }
    commit(&mut l.conn, outcomes, folder_id.as_deref()).map_err(|e| e.to_string())
}

/// Reads the family, script and style of fonts whose details aren't stored
/// (`db::missing_font_meta`). The library is locked only at the ends.
/// Returns how many were read.
pub fn compute_missing_font_meta(lib: &Mutex<Option<Library>>) -> Result<usize, String> {
    let (root, missing) = {
        let guard = lib.lock().unwrap();
        let l = guard.as_ref().ok_or("ライブラリが開かれていません")?;
        (l.root.clone(), db::missing_font_meta(&l.conn).map_err(|e| e.to_string())?)
    };
    if missing.is_empty() {
        return Ok(0);
    }
    let metas: Vec<(String, fonts::FontMeta)> = missing
        .par_iter()
        .map(|(id, file_name, ext)| {
            let path = library::stored_file(&root, id, file_name);
            // A file that can't be read is filed as "other", so it isn't retried every time.
            let meta = fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|d| fonts::to_sfnt(&d, ext))
                .and_then(|s| fonts::meta(&s))
                .unwrap_or(fonts::FontMeta {
                    family: String::new(),
                    weight: 400,
                    weight_min: 400,
                    weight_max: 400,
                    script: "other",
                    category: None,
                    features: Vec::new(),
                    axes: Vec::new(),
                    coverage: Vec::new(),
                    ps_name: String::new(),
                });
            (id.clone(), meta)
        })
        .collect();
    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().ok_or("ライブラリが開かれていません")?;
    if l.root != root {
        return Err("読み込み中にライブラリが切り替わりました".into());
    }
    db::set_font_meta(&mut l.conn, &metas).map_err(|e| e.to_string())?;
    Ok(metas.len())
}

fn commit(
    conn: &mut Connection,
    outcomes: Vec<(Outcome, Vec<String>)>,
    folder_id: Option<&str>,
) -> rusqlite::Result<ImportSummary> {
    let mut summary = ImportSummary::default();
    // Target folder (None = unfiled) -> item ids, in import order.
    // The flag marks already-known items, which only fill an empty spot.
    let mut placed: Vec<(Option<String>, bool, Vec<String>)> = Vec::new();
    let mut folder_cache: HashMap<Vec<String>, String> = HashMap::new();
    let tx = conn.transaction()?;
    let base = db::now_ms();
    for (i, (o, dirs)) in outcomes.into_iter().enumerate() {
        let known = matches!(o, Outcome::Duplicate(_));
        let id = match o {
            Outcome::New(item) => {
                // Offset by index so the import order is preserved when sorting.
                db::insert_item(&tx, &item, base + i as i64)?;
                summary.imported += 1;
                item.id
            }
            Outcome::Duplicate(id) => {
                summary.duplicates += 1;
                if id.is_empty() {
                    continue;
                }
                // Re-importing something from the trash brings it back.
                db::restore_items(&tx, std::slice::from_ref(&id))?;
                id
            }
            Outcome::Failed(msg) => {
                summary.failed.push(msg);
                continue;
            }
        };
        // Recreate the source directory structure under the target folder.
        let mut folder = folder_id.map(str::to_owned);
        for depth in 1..=dirs.len() {
            let key = dirs[..depth].to_vec();
            let next = match folder_cache.get(&key) {
                Some(f) => f.clone(),
                None => {
                    let f = db::find_or_create_folder(&tx, folder.as_deref(), &dirs[depth - 1])?;
                    folder_cache.insert(key, f.clone());
                    f
                }
            };
            folder = Some(next);
        }
        summary.ids.push(id.clone());
        match placed.iter_mut().find(|(f, k, _)| *f == folder && *k == known) {
            Some((_, _, ids)) => ids.push(id),
            None => placed.push((folder, known, vec![id])),
        }
    }
    for (folder, known, ids) in &placed {
        if let Some(f) = folder {
            // Re-importing something already filed elsewhere doesn't move it.
            if *known {
                db::file_unfiled(&tx, ids, f)?;
            } else {
                db::move_to_folder(&tx, ids, f)?;
            }
        }
    }
    tx.commit()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Mutex<Option<Library>>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::create(&dir.path().join("Test.library")).unwrap();
        (dir, Mutex::new(Some(lib)))
    }

    /// Two different fonts installed with the OS, if there are.
    fn two_fonts() -> Option<(Vec<u8>, Vec<u8>)> {
        let a = fonts::tests::system_font(fonts::tests::SINGLE)?;
        let b = fonts::tests::system_font(fonts::tests::OTHER)?;
        (a != b).then_some((a, b))
    }

    #[test]
    fn imports_dedupes_and_keeps_the_folders() {
        let Some((a, b)) = two_fonts() else { return };
        let (tmp, lib) = setup();
        let src_dir = tmp.path().join("src");
        fs::create_dir_all(src_dir.join("sub")).unwrap();
        fs::create_dir_all(src_dir.join(".hidden")).unwrap();
        fs::write(src_dir.join("a.ttf"), &a).unwrap();
        fs::write(src_dir.join("a-copy.ttf"), &a).unwrap(); // same dir, so placement is deterministic
        fs::write(src_dir.join("sub/b.ttf"), &b).unwrap();
        fs::write(src_dir.join("notes.txt"), "x").unwrap();
        fs::write(src_dir.join("broken.otf"), "not a font").unwrap();
        fs::write(src_dir.join(".hidden/x.ttf"), &a).unwrap();

        let files = collect_files(std::slice::from_ref(&src_dir));
        assert_eq!(files.len(), 4); // txt and hidden dir skipped
        let mut dirs: Vec<Vec<String>> = files.iter().map(|f| f.dirs().to_vec()).collect();
        dirs.sort();
        assert_eq!(dirs[0], ["src"]);
        assert_eq!(dirs[3], ["src", "sub"]);

        let target = {
            let g = lib.lock().unwrap();
            db::create_folder(&g.as_ref().unwrap().conn, "F", None).unwrap()
        };
        let calls = AtomicUsize::new(0);
        let sum = run(&lib, files, Some(target.clone()), |_, _| {
            calls.fetch_add(1, Ordering::Relaxed);
        })
        .unwrap();
        assert_eq!(sum.imported, 2);
        assert_eq!(sum.duplicates, 1);
        assert_eq!(sum.failed.len(), 1);
        assert_eq!(calls.load(Ordering::Relaxed), 5);

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        // The dropped directory is recreated as F/src/sub.
        let folders = db::list_folders(&l.conn).unwrap();
        let src = folders.iter().find(|f| f.name == "src").unwrap();
        let sub = folders.iter().find(|f| f.name == "sub").unwrap();
        assert_eq!(src.parent_id.as_deref(), Some(target.as_str()));
        assert_eq!(sub.parent_id.as_deref(), Some(src.id.as_str()));
        assert_eq!((src.count, sub.count), (1, 1));

        let items = db::query_items(
            &l.conn,
            &db::ItemQuery { view: db::View::Folder { id: target }, include_subfolders: true, ..Default::default() },
        )
        .unwrap();
        assert_eq!(items.len(), 2);
        for it in &items {
            assert!(l.file_path(it).is_file());
            let t = image::open(l.thumb_path(it)).unwrap();
            assert_eq!((t.width(), t.height()), (fonts::THUMB_W, fonts::THUMB_H));
        }
    }

    #[test]
    fn reimporting_a_folder_reuses_its_folders() {
        let Some((a, b)) = two_fonts() else { return };
        let (tmp, lib) = setup();
        let dir = tmp.path().join("Sans");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.ttf"), &a).unwrap();
        run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        fs::write(dir.join("b.ttf"), &b).unwrap();
        let sum = run(&lib, collect_files(std::slice::from_ref(&dir)), None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.duplicates), (1, 1));
        let g = lib.lock().unwrap();
        let folders = db::list_folders(&g.as_ref().unwrap().conn).unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].count, 2);
    }

    #[test]
    fn reimport_restores_from_trash_and_bytes_source() {
        let Some(ttf) = fonts::tests::system_font(fonts::tests::SINGLE) else { return };
        let (_tmp, lib) = setup();
        let src = || vec![Source::Bytes { name: "Pasted.ttf".into(), data: ttf.clone() }];
        assert_eq!(run(&lib, src(), None, |_, _| {}).unwrap().imported, 1);

        let id = {
            let g = lib.lock().unwrap();
            let conn = &g.as_ref().unwrap().conn;
            let id = db::hash_index(conn).unwrap().into_values().next().unwrap();
            db::trash_items(conn, std::slice::from_ref(&id)).unwrap();
            id
        };
        let sum = run(&lib, src(), None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.duplicates), (0, 1));
        assert_eq!(sum.ids, std::slice::from_ref(&id), "a known font reports the existing item");
        let g = lib.lock().unwrap();
        let conn = &g.as_ref().unwrap().conn;
        assert!(db::trashed_ids(conn).unwrap().is_empty());
        assert_eq!(db::get_items(conn, &[id]).unwrap().len(), 1);
    }

    #[test]
    fn only_fonts_are_taken() {
        let (_tmp, lib) = setup();
        let sources = vec![
            Source::Bytes { name: "photo.png".into(), data: b"\x89PNG".to_vec() },
            Source::Bytes { name: "memo.md".into(), data: b"# x".to_vec() },
        ];
        let sum = run(&lib, sources, None, |_, _| {}).unwrap();
        assert_eq!((sum.imported, sum.failed.len()), (0, 2));
    }

    #[test]
    fn imports_fonts_with_their_details() {
        let Some(ttf) = fonts::tests::system_font(fonts::tests::SINGLE) else { return };
        let (_tmp, lib) = setup();
        let sources = vec![
            Source::Bytes { name: "Sample.ttf".into(), data: ttf.clone() },
            Source::Bytes { name: "Sample.woff".into(), data: fonts::tests::encode_woff(&ttf) },
        ];
        let sum = run(&lib, sources, None, |_, _| {}).unwrap();
        assert!(sum.failed.is_empty(), "{:?}", sum.failed);
        assert_eq!(sum.imported, 2);

        let g = lib.lock().unwrap();
        let l = g.as_ref().unwrap();
        let all = db::query_items(&l.conn, &db::ItemQuery { sort: db::SortKey::Name, ..Default::default() }).unwrap();
        let ttf_item = all.iter().find(|i| i.name == "Sample.ttf").unwrap();
        assert_eq!(fs::read(l.file_path(ttf_item)).unwrap(), ttf, "stored as is");

        // The family is stored, so the TTF and the WOFF of one font group and search together.
        let meta = fonts::meta(&ttf).unwrap();
        let family = meta.family.clone();
        let fonts_of = |conn: &rusqlite::Connection| -> Vec<(Option<String>, Option<u32>, Option<String>)> {
            let q = db::ItemQuery { search: format!("\"{family}\""), sort: db::SortKey::Name, ..Default::default() };
            db::query_items(conn, &q).unwrap().into_iter().map(|i| (i.font_family, i.font_weight, i.font_script)).collect()
        };
        let found = fonts_of(&l.conn);
        assert_eq!(found.len(), 2, "found by family name");
        assert!(found.iter().all(|f| f.0.as_deref() == Some(family.as_str())
            && f.1.is_some_and(|w| w >= 100)
            && f.2.as_deref() == Some(meta.script)));

        // Fonts whose details are missing get them filled in.
        l.conn.execute("UPDATE items SET font_family = NULL, font_weight = NULL, font_script = NULL", []).unwrap();
        drop(g);
        assert_eq!(compute_missing_font_meta(&lib).unwrap(), 2);
        assert_eq!(compute_missing_font_meta(&lib).unwrap(), 0);
        assert_eq!(fonts_of(&lib.lock().unwrap().as_ref().unwrap().conn), found);
    }

    #[test]
    fn sanitize_names() {
        assert_eq!(sanitize("a/b:c?.ttf"), "a_b_c_.ttf");
        assert_eq!(sanitize(" ..."), "font");
    }
}
