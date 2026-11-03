//! Font-only commands (the frontend's features/fonts/api.ts). The shared
//! item commands stay in crate::commands.

use crate::commands::{err, item_paths, with_lib, AppState, CmdResult};
use crate::db;
use crate::import;
use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Manager, State};

/// The fonts installed on this computer (fonts/system.rs); `reload` reads the
/// font folders again.
#[tauri::command]
pub async fn system_fonts(app: AppHandle, reload: bool) -> CmdResult<Vec<super::system::SystemFont>> {
    let cache = app.path().app_cache_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || super::system::list(&cache, reload).to_vec()).await.map_err(err)
}

/// Shows an installed font's file in Finder / Explorer.
#[tauri::command]
pub fn reveal_system_font(id: String) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(super::system::find(&id)?.path).map_err(err)
}

/// Puts installed fonts on the font shelf after what is there (their names are
/// kept for a computer that doesn't have them). Returns how many were added.
#[tauri::command]
pub fn add_system_to_tray(state: State<AppState>, ids: Vec<String>) -> CmdResult<usize> {
    let fonts: Vec<(String, String)> =
        ids.iter().filter_map(|id| super::system::find(id).ok()).map(|f| (f.id, f.name)).collect();
    with_lib(&state, |lib| db::add_system_to_tray(&lib.conn, &fonts).map_err(err))
}

#[derive(Serialize)]
pub struct SystemTrayFont {
    id: String,
    name: String,
}

/// The installed fonts on the shelf, and the shelf's order across them and the
/// items (the frontend puts the two together).
#[derive(Serialize)]
pub struct SystemTray {
    order: Vec<String>,
    fonts: Vec<SystemTrayFont>,
}

#[tauri::command]
pub fn system_tray(state: State<AppState>) -> CmdResult<SystemTray> {
    with_lib(&state, |lib| {
        let fonts = db::system_tray(&lib.conn).map_err(err)?;
        Ok(SystemTray {
            order: db::tray_order(&lib.conn).map_err(err)?,
            fonts: fonts.into_iter().map(|(id, name)| SystemTrayFont { id, name }).collect(),
        })
    })
}

/// PostScript names of the library's fonts: which installed fonts are in the library.
#[tauri::command]
pub fn library_font_ps_names(state: State<AppState>) -> CmdResult<Vec<String>> {
    with_lib(&state, |lib| db::font_ps_names(&lib.conn).map_err(err))
}

/// The font file of a font item, or of a font installed on this computer
/// (`system`), unpacked (WOFF / WOFF2) and, for a collection, cut down to one font.
fn font_sfnt(state: &AppState, id: &str) -> CmdResult<Vec<u8>> {
    if super::system::is_system_id(id) {
        return super::system::sfnt(id);
    }
    let (item, path) = item_paths(state, &[id.to_string()])?.pop().ok_or("フォントが見つかりません")?;
    super::to_sfnt(&fs::read(path).map_err(err)?, &item.ext)
}

/// Names of every font in the file and the characters of font `face`.
#[tauri::command]
pub async fn font_info(app: AppHandle, id: String, face: u32) -> CmdResult<super::FontInfo> {
    tauri::async_runtime::spawn_blocking(move || super::info(&font_sfnt(&app.state::<AppState>(), &id)?, face))
        .await
        .map_err(err)?
}

/// Names and details of every font in the file (the details panel).
#[tauri::command]
pub async fn font_faces(app: AppHandle, id: String) -> CmdResult<Vec<super::FaceInfo>> {
    tauri::async_runtime::spawn_blocking(move || super::faces(&font_sfnt(&app.state::<AppState>(), &id)?))
        .await
        .map_err(err)?
}

/// Sets the typeface style of fonts by hand (None = back to the guess).
#[tauri::command]
pub fn set_font_category(state: State<AppState>, ids: Vec<String>, category: Option<String>) -> CmdResult<usize> {
    if category.as_deref().is_some_and(|c| !super::CATEGORIES.contains(&c)) {
        return Err("書体の指定が正しくありません".into());
    }
    with_lib(&state, |lib| db::set_font_category(&lib.conn, &ids, category.as_deref()).map_err(err))
}

/// A sample line and the style of a font, for the list layout.
#[tauri::command]
pub async fn font_list_preview(app: AppHandle, id: String) -> CmdResult<super::ListPreview> {
    tauri::async_runtime::spawn_blocking(move || super::list_preview(&font_sfnt(&app.state::<AppState>(), &id)?))
        .await
        .map_err(err)?
}

/// Font `face` as plain OpenType data, for `new FontFace()` in the viewer
/// (web views can't load one font out of a collection).
#[tauri::command]
pub async fn font_data(app: AppHandle, id: String, face: u32) -> CmdResult<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let sfnt = font_sfnt(&app.state::<AppState>(), &id)?;
        Ok(tauri::ipc::Response::new(super::extract_face(&sfnt, face)?))
    })
    .await
    .map_err(err)?
}

/// Reads the family, writing system and style of fonts imported by versions
/// that didn't store them (grouping, search, filters). Returns how many were read.
#[tauri::command]
pub async fn index_fonts(app: AppHandle) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || import::compute_missing_font_meta(&app.state::<AppState>().lib))
        .await
        .map_err(err)?
}
