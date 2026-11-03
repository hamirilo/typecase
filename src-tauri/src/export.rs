//! 書き出し: copies items' files out of the library as they are, named as in
//! the app (docs/EXPORT.md). A list goes into the chosen folder (a folder's
//! items optionally keeping its subfolders); the whole library goes into a
//! new "<library name>/" laid out like the app's folders.

use crate::commands::{err, item_paths, library_name, with_lib, AppState, CmdResult};
use crate::db::{self, Folder, Item};
use crate::library::{self, Library};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// Set by `cancel_export`; checked between files.
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Copies the original files into `dest`, never overwriting existing files.
/// Off the main thread (gigabytes may be copied), holding the library only
/// to look the items up.
#[tauri::command]
pub async fn export_items(
    app: AppHandle,
    ids: Vec<String>,
    dest: PathBuf,
    subdirs: Option<Vec<String>>,
) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let items = item_paths(&app.state::<AppState>(), &ids)?;
        for (item, src) in &items {
            // The folder under `dest` given for this item (same position as its id).
            let sub = subdirs
                .as_ref()
                .and_then(|s| s.get(ids.iter().position(|x| *x == item.id)?))
                .map_or("", String::as_str);
            let dir = export_dir(&dest, sub);
            fs::create_dir_all(&dir).map_err(err)?;
            fs::copy(src, export_target(&dir, &item.name, &item.ext)).map_err(err)?;
        }
        Ok(items.len())
    })
    .await
    .map_err(err)?
}

/// What a whole-library export did.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryExport {
    /// The folder made for it ("<dest>/<library name>").
    pub folder: PathBuf,
    pub copied: usize,
    pub total: usize,
    /// Names of the items whose file couldn't be copied.
    pub failed: Vec<String>,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// Copies every item not in the trash into a new folder in `dest`, laid out
/// like the app's folders (`plan`). Reports "export-progress"; `cancel_export`
/// stops it between files, keeping what was written.
#[tauri::command]
pub async fn export_library(app: AppHandle, dest: PathBuf) -> CmdResult<LibraryExport> {
    tauri::async_runtime::spawn_blocking(move || {
        CANCEL.store(false, Ordering::Relaxed);
        let (name, files) = with_lib(&app.state::<AppState>(), |lib| Ok((library_name(&lib.root), plan(lib)?)))?;
        let folder = new_dir(&dest, &safe_part(&name));
        write(&folder, &files, || CANCEL.load(Ordering::Relaxed), |done, total| {
            let _ = app.emit("export-progress", Progress { done, total });
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn cancel_export() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// One file of a whole-library export.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub src: PathBuf,
    /// Folders under the export's folder: the app's folders.
    pub dir: Vec<String>,
    pub name: String,
    pub ext: String,
}

/// Every item not in the trash, oldest first: in "<folder>/…", or right in
/// the export's folder when in no folder. An item is in at most one folder
/// (`idx_item_folders_item`), so each file has one place.
pub fn plan(lib: &Library) -> CmdResult<Vec<Planned>> {
    let ids = db::live_ids(&lib.conn).map_err(err)?;
    let mut items = db::get_items(&lib.conn, &ids).map_err(err)?;
    items.sort_by(|a, b| (a.imported_at, &a.id).cmp(&(b.imported_at, &b.id)));
    let folders = db::list_folders(&lib.conn).map_err(err)?;
    let paths = folder_paths(&folders);
    Ok(items
        .into_iter()
        .map(|it: Item| {
            let dir = it.folder_id.as_ref().and_then(|f| paths.get(f)).cloned().unwrap_or_default();
            Planned { src: library::file_path(&lib.root, &it), dir, name: it.name, ext: it.ext }
        })
        .collect())
}

/// Each folder's names from the top ("和文", "ゴシック", "見出し").
fn folder_paths(folders: &[Folder]) -> HashMap<String, Vec<String>> {
    let by_id: HashMap<&str, &Folder> = folders.iter().map(|f| (f.id.as_str(), f)).collect();
    folders
        .iter()
        .map(|f| {
            let mut names = vec![];
            let mut cur = Some(f);
            // Bounded, in case a parent loop ever got into the database.
            while let Some(c) = cur.filter(|_| names.len() <= folders.len()) {
                names.push(c.name.clone());
                cur = c.parent_id.as_deref().and_then(|p| by_id.get(p).copied());
            }
            names.reverse();
            (f.id.clone(), names)
        })
        .collect()
}

/// Copies the planned files into `folder`. A file that can't be copied is
/// skipped and named in `failed`; the rest go on.
pub fn write(
    folder: &Path,
    files: &[Planned],
    cancelled: impl Fn() -> bool,
    progress: impl Fn(usize, usize),
) -> CmdResult<LibraryExport> {
    fs::create_dir_all(folder).map_err(err)?;
    let mut done = LibraryExport { folder: folder.to_path_buf(), copied: 0, total: files.len(), failed: vec![], cancelled: false };
    for (i, f) in files.iter().enumerate() {
        if cancelled() {
            done.cancelled = true;
            break;
        }
        let dir = f.dir.iter().fold(folder.to_path_buf(), |d, p| d.join(safe_part(p)));
        let copied = fs::create_dir_all(&dir).and_then(|_| fs::copy(&f.src, export_target(&dir, &f.name, &f.ext)));
        match copied {
            Ok(_) => done.copied += 1,
            Err(e) => {
                log::warn!("export {}: {e}", f.src.display());
                done.failed.push(f.name.clone());
            }
        }
        progress(i + 1, files.len());
    }
    Ok(done)
}

/// `dest/name`, or `name (2)`… when taken: an export never writes into an
/// earlier one.
fn new_dir(dest: &Path, name: &str) -> PathBuf {
    let mut candidate = dest.join(name);
    let mut n = 2;
    while candidate.exists() {
        candidate = dest.join(format!("{name} ({n})"));
        n += 1;
    }
    candidate
}

/// `dest` plus a relative folder path ("和文/ゴシック", `/`-separated), each
/// part made safe as a file name. Empty parts, "." and ".." are dropped so
/// nothing lands outside `dest`.
fn export_dir(dest: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .fold(dest.to_path_buf(), |d, p| d.join(safe_name(p)))
}

/// One folder name as given (it may contain "/"), made safe: no separators,
/// no trailing dots or spaces (Windows drops them), never "", "." or "..".
fn safe_part(name: &str) -> String {
    let s = safe_name(name.trim());
    let s = s.trim_end_matches(['.', ' ']);
    if s.is_empty() { "_".into() } else { s.into() }
}

/// Characters not allowed in file names on Windows (or anywhere) become `_`.
fn safe_name(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect()
}

/// `dest/name.ext`, or `name (2).ext`… when taken. Keeps a renamed item's
/// display name but makes sure the extension is there.
fn export_target(dest: &Path, name: &str, ext: &str) -> PathBuf {
    let has_ext = Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case(ext));
    let stem = if has_ext { &name[..name.len() - ext.len() - 1] } else { name };
    let clean = safe_name(stem);
    let mut candidate = dest.join(format!("{clean}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dest.join(format!("{clean} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::NewItem;

    #[test]
    fn export_names() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        assert_eq!(export_target(d, "Sans.OTF", "otf"), d.join("Sans.otf"));
        assert_eq!(export_target(d, "renamed", "ttf"), d.join("renamed.ttf"));
        assert_eq!(export_target(d, "a/b:c", "ttf"), d.join("a_b_c.ttf"));
        fs::write(d.join("Sans.otf"), "x").unwrap();
        fs::write(d.join("Sans (2).otf"), "x").unwrap();
        assert_eq!(export_target(d, "Sans.otf", "otf"), d.join("Sans (3).otf"));
    }

    #[test]
    fn export_folders() {
        let d = Path::new("/out");
        assert_eq!(export_dir(d, ""), d);
        assert_eq!(export_dir(d, "和文/ゴシック/見出し"), d.join("和文").join("ゴシック").join("見出し"));
        // Names unsafe on Windows are replaced; nothing climbs out of `dest`.
        assert_eq!(export_dir(d, "a:b/../c*"), d.join("a_b").join("c_"));
        assert_eq!(export_dir(d, "/./ x /"), d.join("x"));
    }

    #[test]
    fn folder_names_stay_one_folder() {
        assert_eq!(safe_part("a/b"), "a_b");
        assert_eq!(safe_part(" メモ. "), "メモ");
        for name in ["", ".", "..", " "] {
            assert_eq!(safe_part(name), "_", "{name:?}");
        }
    }

    /// An item `id` named `name`, its file holding `id`.
    fn add(lib: &mut Library, id: &str, name: &str, at: i64) {
        library::store_file(&lib.root, id, "f", id.as_bytes()).unwrap();
        let ext = Path::new(name).extension().unwrap().to_string_lossy().into_owned();
        let tx = lib.conn.transaction().unwrap();
        let it = NewItem {
            id: id.into(),
            name: name.into(),
            file_name: "f".into(),
            ext,
            size: 1,
            hash: format!("h-{id}"),
            thumb: format!("{id}.png"),
            font: crate::fonts::FontMeta {
                family: "F".into(),
                weight: 400,
                weight_min: 400,
                weight_max: 400,
                script: "latin",
                category: None,
                features: vec![],
                ps_name: String::new(),
            },
        };
        db::insert_item(&tx, &it, at).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn whole_library_in_its_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let mut lib = Library::create(&tmp.path().join("L.library")).unwrap();
        let ja = db::create_folder(&lib.conn, "和文", None).unwrap();
        let gothic = db::create_folder(&lib.conn, "ゴシック", Some(&ja)).unwrap();
        let latin = db::create_folder(&lib.conn, "欧文", None).unwrap();
        add(&mut lib, "a", "見出し.otf", 1);
        add(&mut lib, "b", "見出し.otf", 2);
        add(&mut lib, "c", "未分類.ttf", 3);
        add(&mut lib, "d", "Inter.ttf", 4);
        add(&mut lib, "e", "捨てた.ttf", 5);
        let s = |xs: &[&str]| xs.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        db::move_to_folder(&lib.conn, &s(&["a", "b"]), &gothic).unwrap();
        db::move_to_folder(&lib.conn, &s(&["d"]), &latin).unwrap();
        db::trash_items(&lib.conn, &s(&["e"])).unwrap();

        let files = plan(&lib).unwrap();
        let dirs: Vec<_> = files.iter().map(|f| (f.dir.join("/"), f.name.as_str())).collect();
        assert_eq!(
            dirs,
            [
                ("和文/ゴシック".to_string(), "見出し.otf"),
                ("和文/ゴシック".to_string(), "見出し.otf"),
                ("".to_string(), "未分類.ttf"), // unfiled: right in the export's folder
                ("欧文".to_string(), "Inter.ttf"),
            ],
            "the trash is left out"
        );

        let out = tmp.path().join("out");
        let first = write(&new_dir(&out, "L"), &files, || false, |_, _| {}).unwrap();
        assert_eq!((first.copied, first.total, first.failed.len(), first.cancelled), (4, 4, 0, false));
        let root = out.join("L");
        assert_eq!(fs::read(root.join("和文/ゴシック/見出し.otf")).unwrap(), b"a");
        assert_eq!(fs::read(root.join("和文/ゴシック/見出し (2).otf")).unwrap(), b"b");
        assert_eq!(fs::read(root.join("未分類.ttf")).unwrap(), b"c");
        assert_eq!(fs::read(root.join("欧文/Inter.ttf")).unwrap(), b"d");

        // Again: a new folder, the first one untouched.
        let again = new_dir(&out, "L");
        assert_eq!(again, out.join("L (2)"));
        write(&again, &files, || false, |_, _| {}).unwrap();
        assert!(!root.join("和文/ゴシック/見出し (3).otf").exists());
    }

    #[test]
    fn missing_files_and_cancelling() {
        let tmp = tempfile::tempdir().unwrap();
        let mut lib = Library::create(&tmp.path().join("L.library")).unwrap();
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            add(&mut lib, id, &format!("{id}.ttf"), i as i64);
        }
        library::remove_item_dir(&lib.root, "b");
        let files = plan(&lib).unwrap();

        let r = write(&tmp.path().join("x"), &files, || false, |_, _| {}).unwrap();
        assert_eq!((r.copied, r.failed.clone()), (2, vec!["b.ttf".to_string()]), "the others still go");

        let seen = std::cell::Cell::new(0);
        let r = write(&tmp.path().join("y"), &files, || seen.get() == 1, |done, _| seen.set(done)).unwrap();
        assert_eq!((r.copied, r.cancelled), (1, true));
        assert!(tmp.path().join("y/a.ttf").is_file(), "what was written stays");
    }
}
