//! SQLite schema and queries. Everything here takes a plain `Connection`
//! so it can be unit-tested without Tauri.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::search;

pub type DbResult<T> = rusqlite::Result<T>;

const SCHEMA_VERSION: i32 = 3;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open(path: &std::path::Path) -> DbResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

/// Brings the schema up to `SCHEMA_VERSION`.
///
/// Every step is safe to run again: an older build of the app that opens a
/// newer library may lower `user_version`, so the steps check what exists
/// instead of trusting the number. Each step runs in its own transaction and
/// records its version, and the version is never lowered here.
pub fn migrate(conn: &Connection) -> DbResult<()> {
    register_functions(conn)?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let step = |target: i32, f: &dyn Fn(&Connection) -> DbResult<()>| -> DbResult<()> {
        if version >= target {
            return Ok(());
        }
        let tx = conn.unchecked_transaction()?; // rolled back on error (drop)
        f(&tx)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()
    };

    // - items: the fonts. `font_*` are read from the file (fonts/mod.rs
    //   `FontMeta`); NULL `font_script` / `font_features` = not read yet (see
    //   `missing_font_meta`). `font_category_user` is the user's correction,
    //   used over the guess.
    // - folders: `sort_order` is the order among siblings. An item lives in
    //   one folder at most (`idx_item_folders_item`); `position` is its place
    //   in the folder's manual order.
    // - tags: ids are never reused (AUTOINCREMENT), so a smart folder's rule
    //   never matches a later tag that took a deleted one's id.
    // - smart_folders: saved conditions (`rule` is a JSON-encoded `Rule`).
    // - tray: the shelf (シェルフ), fonts gathered to be compared; tray_system
    //   holds the fonts installed on this computer on it (docs/SYSTEM_FONTS.md),
    //   in the same order (`position` shared with `tray`). They aren't items:
    //   `id` is fonts/system.rs's, `name` is for when this computer doesn't have it.
    // - settings: this library's settings (docs/SETTINGS.md), JSON values.
    step(1, &|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS items (
               id                 TEXT PRIMARY KEY,
               name               TEXT NOT NULL,
               file_name          TEXT NOT NULL,
               ext                TEXT NOT NULL,
               size               INTEGER NOT NULL,
               hash               TEXT NOT NULL,
               thumb              TEXT NOT NULL,
               note               TEXT NOT NULL DEFAULT '',
               rating             INTEGER NOT NULL DEFAULT 0,
               favorite           INTEGER NOT NULL DEFAULT 0,
               pinned_at          INTEGER,
               imported_at        INTEGER NOT NULL,
               deleted_at         INTEGER,
               font_family        TEXT,
               font_weight        INTEGER,
               font_weight_min    INTEGER,
               font_weight_max    INTEGER,
               font_script        TEXT,
               font_category      TEXT,
               font_category_user TEXT,
               font_features      TEXT,
               font_ps_name       TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_items_hash ON items(hash);
             CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at, imported_at);

             CREATE TABLE IF NOT EXISTS folders (
               id         TEXT PRIMARY KEY,
               parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
               name       TEXT NOT NULL,
               sort_order REAL,
               color      TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

             CREATE TABLE IF NOT EXISTS item_folders (
               item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
               position  REAL,
               PRIMARY KEY (item_id, folder_id)
             );
             CREATE INDEX IF NOT EXISTS idx_item_folders_folder ON item_folders(folder_id);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_item_folders_item ON item_folders(item_id);

             CREATE TABLE IF NOT EXISTS tags (
               id    INTEGER PRIMARY KEY AUTOINCREMENT,
               name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
               color TEXT
             );
             CREATE TABLE IF NOT EXISTS item_tags (
               item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
               tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
               PRIMARY KEY (item_id, tag_id)
             );
             CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

             CREATE TABLE IF NOT EXISTS smart_folders (
               id         TEXT PRIMARY KEY,
               name       TEXT NOT NULL,
               rule       TEXT NOT NULL,
               sort_order REAL NOT NULL,
               color      TEXT
             );

             CREATE TABLE IF NOT EXISTS tray (
               item_id  TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
               position REAL NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tray_system (
               id       TEXT PRIMARY KEY,
               name     TEXT NOT NULL,
               position REAL NOT NULL
             );

             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
    })?;
    // 2: the variation axes of each font (a NULL one is read again, with the
    //    colour-font feature added at the same time: `missing_font_meta`).
    step(2, &|c| {
        let has: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'font_axes'")?
            .exists([])?;
        if !has {
            c.execute_batch("ALTER TABLE items ADD COLUMN font_axes TEXT")?;
        }
        Ok(())
    })?;
    // 3: the characters each font maps (`fonts::coverage`; a NULL one is read again).
    step(3, &|c| {
        let has: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'font_chars'")?
            .exists([])?;
        if !has {
            c.execute_batch("ALTER TABLE items ADD COLUMN font_chars BLOB")?;
        }
        Ok(())
    })?;
    // New steps go above; the last one must be SCHEMA_VERSION.
    debug_assert!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))? >= SCHEMA_VERSION,
        "add a migrate() step for SCHEMA_VERSION"
    );
    Ok(())
}

// ---------------------------------------------------------------- items

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub ext: String,
    pub size: i64,
    pub thumb: String,
    pub note: String,
    pub rating: u8,
    pub imported_at: i64,
    pub deleted_at: Option<i64>,
    pub favorite: bool,
    /// When the item was pinned to the top of lists; None = not pinned.
    pub pinned_at: Option<i64>,
    /// The folder the item is in (an item is in one at most).
    pub folder_id: Option<String>,
    pub tag_ids: Vec<i64>,
    /// The family (shared by its styles) and weight (100-900) of the first
    /// font in the file.
    pub font_family: Option<String>,
    pub font_weight: Option<u32>,
    /// Writing system ("ja", "latin", ...), see `fonts::SCRIPTS`.
    pub font_script: Option<String>,
    /// Typeface style guessed from the font (None = can't tell) and the
    /// user's correction, which wins. See `fonts::CATEGORIES`.
    pub font_category: Option<String>,
    pub font_category_user: Option<String>,
    /// Features ("mono", "coding", ...), see `fonts::FEATURES`. Empty until read.
    pub font_features: Vec<String>,
    /// PostScript name of the first font (None until read, or when it has none).
    pub font_ps_name: Option<String>,
    /// On the shelf (シェルフ; the `tray` table).
    pub in_tray: bool,
}

#[derive(Debug, Clone)]
pub struct NewItem {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub ext: String,
    pub size: i64,
    pub hash: String,
    pub thumb: String,
    /// Family, weight, script and style (see `Item::font_family`).
    pub font: crate::fonts::FontMeta,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum View {
    #[default]
    All,
    Unfiled,
    Untagged,
    Trash,
    Folder { id: String },
    Favorites,
    Pinned,
    /// The shelf (シェルフ; the `tray` table). The app only queries it for the shelf.
    Tray,
    /// Items matching a smart folder's saved rule.
    Smart { id: String },
    /// Items carrying a tag: the sidebar's tags are places like folders (docs/NAVIGATION.md).
    Tag { id: i64 },
    /// Fonts of one writing system (`fonts::SCRIPTS`): a place in the sidebar (docs/NAVIGATION.md).
    FontScript { id: String },
    /// Fonts of one typeface style (`fonts::CATEGORIES`, or "none" = unknown): a place in the sidebar.
    FontCategory { id: String },
}

/// Attribute filters (the filter row). Empty / None = no restriction.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Fonts of any of these writing systems / typeface styles. "none" = style unknown.
    pub font_scripts: Vec<String>,
    pub font_categories: Vec<String>,
    /// Fonts of any of these weight ranges (`FONT_WEIGHTS`) / with any of
    /// these features (`fonts::FEATURES`).
    pub font_weights: Vec<String>,
    pub font_features: Vec<String>,
    /// Variable fonts with any of these axes (`fonts::AXES`).
    pub font_axes: Vec<String>,
    /// Fonts of families with this many styles (`FONT_STYLES`): "1", "2-3", "4-8", "9+", or
    /// "wide" (the family runs from light to bold).
    pub font_styles: Vec<String>,
    /// Fonts that map every one of these characters (spaces don't count); "" = no restriction.
    pub font_chars: String,
    /// File types, e.g. "otf".
    pub exts: Vec<String>,
    /// Import time range in ms; `after` inclusive, `before` exclusive.
    pub imported_after: Option<i64>,
    pub imported_before: Option<i64>,
    /// File size range in bytes (inclusive).
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
}

/// A set of conditions. Ad-hoc queries are built from the toolbar state;
/// smart folders store one as JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    pub search: String,
    pub tag_ids: Vec<i64>,
    pub tag_match_all: bool,
    pub min_rating: u8,
    pub filter: Filter,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    #[default]
    ImportedAt,
    Name,
    Size,
    Rating,
    /// User-defined order inside a folder; other views fall back to import order.
    Manual,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemQuery {
    pub view: View,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    /// `tag_ids` must all be present (AND); otherwise any one of them (OR).
    #[serde(default)]
    pub tag_match_all: bool,
    /// Folder view also shows items of all subfolders.
    #[serde(default)]
    pub include_subfolders: bool,
    #[serde(default)]
    pub min_rating: u8,
    #[serde(default)]
    pub filter: Filter,
    pub sort: SortKey,
    pub desc: bool,
}

impl ItemQuery {
    fn rule(&self) -> Rule {
        Rule {
            search: self.search.clone(),
            tag_ids: self.tag_ids.clone(),
            tag_match_all: self.tag_match_all,
            min_rating: self.min_rating,
            filter: self.filter.clone(),
        }
    }
}

const ITEM_COLS: &str = "items.id, items.name, items.file_name, items.ext, items.size, items.thumb, items.note, \
     items.rating, items.imported_at, items.deleted_at, items.favorite, items.pinned_at, \
     (SELECT folder_id FROM item_folders WHERE item_id = items.id LIMIT 1), \
     (SELECT group_concat(tag_id) FROM item_tags WHERE item_id = items.id), \
     items.font_family, items.font_weight, items.font_script, items.font_category, items.font_category_user, \
     items.font_features, items.font_ps_name, EXISTS (SELECT 1 FROM tray WHERE tray.item_id = items.id)";

fn row_to_item(r: &rusqlite::Row) -> DbResult<Item> {
    let tag_ids: Option<String> = r.get(13)?;
    Ok(Item {
        id: r.get(0)?,
        name: r.get(1)?,
        file_name: r.get(2)?,
        ext: r.get(3)?,
        size: r.get(4)?,
        thumb: r.get(5)?,
        note: r.get(6)?,
        rating: r.get(7)?,
        imported_at: r.get(8)?,
        deleted_at: r.get(9)?,
        favorite: r.get::<_, i64>(10)? != 0,
        pinned_at: r.get(11)?,
        folder_id: r.get(12)?,
        tag_ids: tag_ids
            .map(|s| s.split(',').filter_map(|t| t.parse().ok()).collect())
            .unwrap_or_default(),
        font_family: r.get(14)?,
        font_weight: r.get(15)?,
        font_script: r.get(16)?,
        font_category: r.get(17)?,
        font_category_user: r.get(18)?,
        font_features: r
            .get::<_, Option<String>>(19)?
            .map(|s| s.split(',').filter(|f| !f.is_empty()).map(str::to_string).collect())
            .unwrap_or_default(),
        font_ps_name: r.get::<_, Option<String>>(20)?.filter(|s| !s.is_empty()),
        in_tray: r.get(21)?,
    })
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('%');
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// `IN` over a list of item ids of any length, bound as one JSON array
/// parameter (`ids_param`): SQLite takes at most 32766 parameters, and "select
/// all" on a large library or emptying a large trash goes past that.
const IN_IDS: &str = "IN (SELECT value FROM json_each(?))";

fn ids_param(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_default()
}

/// A file type as filtered and counted ("OTF" -> "otf").
pub fn canonical_ext(ext: &str) -> String {
    ext.trim().trim_start_matches('.').to_ascii_lowercase()
}

/// A font's typeface style as filtered and counted: the user's, else the guess, else "none".
const FONT_CATEGORY: &str = "COALESCE(items.font_category_user, items.font_category, 'none')";
/// The weights a font covers; a font without a range has its one weight.
const FONT_WEIGHT_MIN: &str = "COALESCE(items.font_weight_min, items.font_weight)";
const FONT_WEIGHT_MAX: &str = "COALESCE(items.font_weight_max, items.font_weight)";
/// Fonts whose details were read: what the sidebar's and filter row's font counts count.
const FONT_READ: &str = "items.font_script IS NOT NULL";

/// Weight ranges of the 太さ: 細い, 標準, 太い, 極太 (CSS weights, inclusive).
pub const FONT_WEIGHTS: &[(&str, u32, u32)] = &[("light", 1, 399), ("regular", 400, 549), ("bold", 550, 749), ("black", 750, 9999)];

/// SQL: the font's weight range overlaps the named one (false for unknown names).
fn font_weight_where(key: &str) -> String {
    match FONT_WEIGHTS.iter().find(|(k, _, _)| *k == key) {
        Some((_, lo, hi)) => format!("({FONT_WEIGHT_MIN} <= {hi} AND {FONT_WEIGHT_MAX} >= {lo})"),
        None => "0".into(),
    }
}

/// SQL functions of the queries: `covers(coverage, text)`, whether a font's coverage
/// (`items.font_chars`) holds every character of `text` (a font not read yet holds none).
fn register_functions(conn: &Connection) -> DbResult<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function("covers", 2, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let text: String = ctx.get(1)?;
        Ok(match ctx.get_raw(0) {
            rusqlite::types::ValueRef::Blob(b) => crate::fonts::covers(b, &text),
            _ => false,
        })
    })
}

/// How many styles a family has: its fonts in the library (a font with no family counts as one).
const FAMILY_STYLES: &str = "MAX(1, (SELECT COUNT(*) FROM items s
       WHERE s.deleted_at IS NULL AND s.font_family = items.font_family))";

/// Style-count buckets of a family, and "wide": from 300 or lighter to 700 or bolder.
pub const FONT_STYLES: &[&str] = &["1", "2-3", "4-8", "9+", "wide"];

/// SQL: the font's family is of the named bucket of `FONT_STYLES` (false for unknown names).
fn font_styles_where(key: &str) -> String {
    match key {
        "1" => format!("({FAMILY_STYLES} = 1)"),
        "2-3" => format!("({FAMILY_STYLES} BETWEEN 2 AND 3)"),
        "4-8" => format!("({FAMILY_STYLES} BETWEEN 4 AND 8)"),
        "9+" => format!("({FAMILY_STYLES} >= 9)"),
        "wide" => "((SELECT MIN(COALESCE(s.font_weight_min, s.font_weight)) FROM items s
               WHERE s.deleted_at IS NULL AND s.font_family = items.font_family) <= 300
             AND (SELECT MAX(COALESCE(s.font_weight_max, s.font_weight)) FROM items s
               WHERE s.deleted_at IS NULL AND s.font_family = items.font_family) >= 700)"
            .into(),
        _ => "0".into(),
    }
}

/// SQL: the font has the axis (an argument `?`, matched as a whole word).
const FONT_AXIS_WHERE: &str = "instr(',' || IFNULL(items.font_axes, '') || ',', ',' || ? || ',') > 0";

/// SQL: the font has the axis `k` (one of `fonts::AXES`).
fn font_axis_term(k: &str) -> String {
    format!("instr(',' || IFNULL(items.font_axes, '') || ',', ',{k},') > 0")
}

/// SQL: the font has the feature (an argument `?`, matched as a whole word).
const FONT_FEATURE_WHERE: &str = "instr(',' || IFNULL(items.font_features, '') || ',', ',' || ? || ',') > 0";

/// SQL: the font has the feature `k` (one of `fonts::FEATURES`).
fn font_feature_term(k: &str) -> String {
    format!("instr(',' || IFNULL(items.font_features, '') || ',', ',{k},') > 0")
}

/// Adds the WHERE clauses for `rule`.
fn push_rule(rule: &Rule, wheres: &mut Vec<String>, args: &mut Vec<Box<dyn ToSql>>) {
    if let Some(expr) = search::parse(&rule.search) {
        let sql = search::to_sql(&expr, &mut |word| {
            let pat = escape_like(word);
            for _ in 0..3 {
                args.push(Box::new(pat.clone()));
            }
            args.push(Box::new(pat));
            "(items.name LIKE ? ESCAPE '\\' OR items.note LIKE ? ESCAPE '\\' OR IFNULL(items.font_family, '') LIKE ? ESCAPE '\\'
               OR EXISTS (
               SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id
               WHERE it.item_id = items.id AND t.name LIKE ? ESCAPE '\\'))"
                .into()
        });
        wheres.push(sql);
    }

    if rule.min_rating > 0 {
        wheres.push("items.rating >= ?".into());
        args.push(Box::new(rule.min_rating));
    }

    if !rule.tag_ids.is_empty() {
        let marks = placeholders(rule.tag_ids.len());
        // AND: the item carries every selected tag; OR: at least one of them.
        let need = if rule.tag_match_all { rule.tag_ids.len() } else { 1 };
        wheres.push(format!(
            "(SELECT COUNT(*) FROM item_tags t WHERE t.item_id = items.id AND t.tag_id IN ({marks})) >= {need}"
        ));
        for tag_id in &rule.tag_ids {
            args.push(Box::new(*tag_id));
        }
    }

    let f = &rule.filter;
    if !f.font_scripts.is_empty() {
        wheres.push(format!("items.font_script IN ({})", placeholders(f.font_scripts.len())));
        args.extend(f.font_scripts.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_categories.is_empty() {
        wheres.push(format!("{FONT_CATEGORY} IN ({})", placeholders(f.font_categories.len())));
        args.extend(f.font_categories.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_weights.is_empty() {
        let ranges: Vec<String> = f.font_weights.iter().map(|k| font_weight_where(k)).collect();
        wheres.push(format!("({})", ranges.join(" OR ")));
    }
    if !f.font_features.is_empty() {
        let has: Vec<&str> = f.font_features.iter().map(|_| FONT_FEATURE_WHERE).collect();
        wheres.push(format!("({})", has.join(" OR ")));
        args.extend(f.font_features.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_axes.is_empty() {
        let has: Vec<&str> = f.font_axes.iter().map(|_| FONT_AXIS_WHERE).collect();
        wheres.push(format!("({})", has.join(" OR ")));
        args.extend(f.font_axes.iter().map(|v| Box::new(v.clone()) as Box<dyn ToSql>));
    }
    if !f.font_chars.trim().is_empty() {
        wheres.push("covers(items.font_chars, ?)".into());
        args.push(Box::new(f.font_chars.clone()));
    }
    if !f.font_styles.is_empty() {
        let any: Vec<String> = f.font_styles.iter().map(|k| font_styles_where(k)).collect();
        wheres.push(format!("({})", any.join(" OR ")));
    }
    if !f.exts.is_empty() {
        let exts: Vec<String> = f.exts.iter().map(|e| canonical_ext(e)).collect();
        wheres.push(format!("lower(items.ext) IN ({})", placeholders(exts.len())));
        args.extend(exts.into_iter().map(|e| Box::new(e) as Box<dyn ToSql>));
    }
    let mut range = |col: &str, op: &str, v: Option<i64>| {
        if let Some(v) = v {
            wheres.push(format!("{col} {op} ?"));
            args.push(Box::new(v));
        }
    };
    range("items.imported_at", ">=", f.imported_after);
    range("items.imported_at", "<", f.imported_before);
    range("items.size", ">=", f.min_size);
    range("items.size", "<=", f.max_size);
}

const SUBFOLDERS_CTE: &str = "WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT c.id FROM folders c JOIN sub ON c.parent_id = sub.id)
     SELECT id FROM sub";

/// The WHERE terms (joined with AND) and their arguments of a query: its
/// view, ad-hoc conditions and smart folder rule.
fn query_where(conn: &Connection, q: &ItemQuery) -> DbResult<(Vec<String>, Vec<Box<dyn ToSql>>)> {
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    if q.view == View::Trash {
        wheres.push("items.deleted_at IS NOT NULL".into());
    } else {
        wheres.push("items.deleted_at IS NULL".into());
    }
    match &q.view {
        View::Unfiled => wheres
            .push("NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id)".into()),
        View::Untagged => {
            wheres.push("NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)".into())
        }
        View::Folder { id } if q.include_subfolders => {
            wheres.push(format!(
                "EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id
                   AND f.folder_id IN ({SUBFOLDERS_CTE}))"
            ));
            args.push(Box::new(id.clone()));
        }
        View::Folder { id } => {
            wheres.push(
                "EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id AND f.folder_id = ?)"
                    .into(),
            );
            args.push(Box::new(id.clone()));
        }
        View::Favorites => wheres.push("items.favorite = 1".into()),
        View::Pinned => wheres.push("items.pinned_at IS NOT NULL".into()),
        View::Tray => wheres.push("EXISTS (SELECT 1 FROM tray t WHERE t.item_id = items.id)".into()),
        View::Tag { id } => {
            wheres.push("EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag_id = ?)".into());
            args.push(Box::new(*id));
        }
        View::FontScript { id } => {
            wheres.push("items.font_script = ?".into());
            args.push(Box::new(id.clone()));
        }
        View::FontCategory { id } => {
            wheres.push(format!("{FONT_CATEGORY} = ?"));
            args.push(Box::new(id.clone()));
        }
        View::All | View::Trash | View::Smart { .. } => {}
    }

    push_rule(&q.rule(), &mut wheres, &mut args);
    if let View::Smart { id } = &q.view {
        match load_rule(conn, id)? {
            Some(rule) => push_rule(&rule, &mut wheres, &mut args),
            None => wheres.push("0".into()), // folder was deleted
        }
    }
    Ok((wheres, args))
}

/// The items of a query.
pub fn query_items(conn: &Connection, q: &ItemQuery) -> DbResult<Vec<Item>> {
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();

    // Manual order joins the folder's (or the tray's) positions; a folder's
    // bind value comes first, as the join comes before WHERE.
    let manual_folder = match (&q.view, q.sort) {
        (View::Folder { id }, SortKey::Manual) => Some(id.clone()),
        _ => None,
    };
    let manual_tray = q.view == View::Tray && matches!(q.sort, SortKey::Manual);
    let join = if let Some(f) = &manual_folder {
        args.push(Box::new(f.clone()));
        "LEFT JOIN item_folders pos ON pos.item_id = items.id AND pos.folder_id = ?"
    } else if manual_tray {
        "LEFT JOIN tray pos ON pos.item_id = items.id"
    } else {
        ""
    };
    let (wheres, where_args) = query_where(conn, q)?;
    args.extend(where_args);

    let dir = if q.desc { "DESC" } else { "ASC" };
    let order = match q.sort {
        SortKey::ImportedAt => format!("items.imported_at {dir}"),
        SortKey::Name => format!("items.name COLLATE NOCASE {dir}"),
        SortKey::Size => format!("items.size {dir}"),
        SortKey::Rating => format!("items.rating {dir}, items.imported_at DESC"),
        // Manual is always top-to-bottom; items without a position go last.
        SortKey::Manual if manual_folder.is_some() || manual_tray => {
            "pos.position IS NULL, pos.position ASC, items.imported_at ASC".into()
        }
        SortKey::Manual => format!("items.imported_at {dir}"),
    };
    // Pinned items come first (latest pin on top), whatever the sort —
    // except in the tray's own order, which is the order things are compared in.
    let pins = if manual_tray { "" } else { "items.pinned_at IS NULL, items.pinned_at DESC, " };
    let sql = format!(
        "SELECT {ITEM_COLS} FROM items {join} WHERE {}
         ORDER BY {pins}{order}, items.rowid {dir}",
        wheres.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter().map(|b| b.as_ref())), row_to_item)?;
    rows.collect()
}

/// How many of a query's items have each value of each condition of the
/// filter row (docs/NAVIGATION.md). The app asks with the condition whose
/// menu is open left out, so its counts are with the other conditions on.
#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    /// Items rated exactly n (0 = unrated); "★n 以上" adds them up.
    pub ratings: BTreeMap<u8, i64>,
    pub tags: BTreeMap<i64, i64>,
    /// File types (canonical, as `list_exts`), most first.
    pub exts: Vec<(String, i64)>,
    /// Fonts (details read) by writing system, typeface style, weight range and feature.
    pub font_scripts: BTreeMap<String, i64>,
    pub font_categories: BTreeMap<String, i64>,
    pub font_weights: BTreeMap<String, i64>,
    pub font_features: BTreeMap<String, i64>,
    /// ... by variation axis (`fonts::AXES`) and by family size (`FONT_STYLES`).
    pub font_axes: BTreeMap<String, i64>,
    pub font_styles: BTreeMap<String, i64>,
}

pub fn facet_counts(conn: &Connection, q: &ItemQuery) -> DbResult<Facets> {
    let (wheres, args) = query_where(conn, q)?;
    let matched = format!("SELECT items.id FROM items WHERE {}", wheres.join(" AND "));
    let args: Vec<&dyn ToSql> = args.iter().map(|b| b.as_ref()).collect();
    // Rows of (key, count) over the matched items, `col` and `cond` on `items`.
    let group = |col: &str, cond: &str| -> DbResult<Vec<(rusqlite::types::Value, i64)>> {
        let sql = format!("SELECT {col}, COUNT(*) FROM items WHERE items.id IN ({matched}) AND {cond} GROUP BY 1");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(args.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    };
    let text = |v: rusqlite::types::Value| match v {
        rusqlite::types::Value::Text(t) => t,
        _ => String::new(),
    };
    let int = |v: rusqlite::types::Value| match v {
        rusqlite::types::Value::Integer(i) => i,
        _ => 0,
    };
    let mut f = Facets {
        ratings: group("items.rating", "1")?.into_iter().map(|(k, n)| (int(k) as u8, n)).collect(),
        font_scripts: group("items.font_script", FONT_READ)?.into_iter().map(|(k, n)| (text(k), n)).collect(),
        font_categories: group(FONT_CATEGORY, FONT_READ)?.into_iter().map(|(k, n)| (text(k), n)).collect(),
        ..Default::default()
    };
    for (ext, n) in group("lower(items.ext)", "1")? {
        let ext = canonical_ext(&text(ext));
        match f.exts.iter_mut().find(|(e, _)| *e == ext) {
            Some((_, c)) => *c += n,
            None => f.exts.push((ext, n)),
        }
    }
    f.exts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    {
        let sql = format!(
            "SELECT x.tag_id, COUNT(*) FROM item_tags x WHERE x.item_id IN ({matched}) GROUP BY x.tag_id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(args.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;
        f.tags = rows.collect::<DbResult<_>>()?;
    }
    // One SUM per value where an item can have several (or a range spans several).
    let sums = |terms: &[(String, String)]| -> DbResult<BTreeMap<String, i64>> {
        let cols: Vec<String> = terms.iter().map(|(_, t)| format!("SUM({t})")).collect();
        let sql = format!("SELECT {} FROM items WHERE items.id IN ({matched}) AND {FONT_READ}", cols.join(", "));
        let mut stmt = conn.prepare(&sql)?;
        let out: BTreeMap<String, i64> = stmt.query_row(args.as_slice(), |r| {
            terms
                .iter()
                .enumerate()
                .map(|(i, (k, _))| Ok((k.clone(), r.get::<_, Option<i64>>(i)?.unwrap_or(0))))
                .collect()
        })?;
        Ok(out.into_iter().filter(|(_, n)| *n > 0).collect())
    };
    let weights: Vec<(String, String)> = FONT_WEIGHTS.iter().map(|(k, _, _)| (k.to_string(), font_weight_where(k))).collect();
    f.font_weights = sums(&weights)?;
    let features: Vec<(String, String)> =
        crate::fonts::FEATURES.iter().map(|k| (k.to_string(), font_feature_term(k))).collect();
    f.font_features = sums(&features)?;
    let axes: Vec<(String, String)> = crate::fonts::AXES.iter().map(|k| (k.to_string(), font_axis_term(k))).collect();
    f.font_axes = sums(&axes)?;
    let styles: Vec<(String, String)> = FONT_STYLES.iter().map(|k| (k.to_string(), font_styles_where(k))).collect();
    f.font_styles = sums(&styles)?;
    Ok(f)
}

/// Fonts whose details haven't been read yet, trash included: (id, file name, extension).
pub fn missing_font_meta(conn: &Connection) -> DbResult<Vec<(String, String, String)>> {
    let mut stmt =
        conn.prepare("SELECT id, file_name, lower(ext) FROM items WHERE font_script IS NULL OR font_features IS NULL OR font_axes IS NULL OR font_chars IS NULL")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

pub fn set_font_meta(conn: &mut Connection, metas: &[(String, crate::fonts::FontMeta)]) -> DbResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE items SET font_family = ?2, font_weight = ?3, font_script = ?4, font_category = ?5,
               font_weight_min = ?6, font_weight_max = ?7, font_features = ?8, font_ps_name = ?9, font_axes = ?10, font_chars = ?11 WHERE id = ?1",
        )?;
        for (id, m) in metas {
            stmt.execute(params![
                id,
                m.family,
                m.weight,
                m.script,
                m.category,
                m.weight_min,
                m.weight_max,
                m.features_text(),
                m.ps_name,
                m.axes_text(),
                m.coverage
            ])?;
        }
    }
    tx.commit()
}

/// PostScript names of the library's fonts (not in the trash): which of the
/// fonts installed on this computer are in the library (docs/SYSTEM_FONTS.md).
pub fn font_ps_names(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT font_ps_name FROM items
         WHERE deleted_at IS NULL AND font_ps_name IS NOT NULL AND font_ps_name != ''",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// The user's typeface style for fonts (None = back to the guess).
pub fn set_font_category(conn: &Connection, ids: &[String], category: Option<&str>) -> DbResult<usize> {
    let mut stmt = conn.prepare("UPDATE items SET font_category_user = ?2 WHERE id = ?1")?;
    let mut n = 0;
    for id in ids {
        n += stmt.execute(params![id, category])?;
    }
    Ok(n)
}

pub fn get_items(conn: &Connection, ids: &[String]) -> DbResult<Vec<Item>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(&format!("SELECT {ITEM_COLS} FROM items WHERE id {IN_IDS}"))?;
    let rows = stmt.query_map([ids_param(ids)], row_to_item)?;
    rows.collect()
}

/// hash -> item id, including trashed items.
pub fn hash_index(conn: &Connection) -> DbResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT hash, id FROM items")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// The item (trashed or not) with this hash, if any.
pub fn item_by_hash(conn: &Connection, hash: &str) -> DbResult<Option<String>> {
    conn.query_row("SELECT id FROM items WHERE hash = ?1 LIMIT 1", [hash], |r| r.get(0)).optional()
}

pub fn insert_item(tx: &Transaction, it: &NewItem, imported_at: i64) -> DbResult<()> {
    let f = &it.font;
    tx.execute(
        "INSERT INTO items (id, name, file_name, ext, size, hash, thumb, imported_at,
           font_family, font_weight, font_script, font_category, font_weight_min, font_weight_max, font_features,
           font_ps_name, font_axes, font_chars)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            it.id,
            it.name,
            it.file_name,
            it.ext,
            it.size,
            it.hash,
            it.thumb,
            imported_at,
            f.family,
            f.weight,
            f.script,
            f.category,
            f.weight_min,
            f.weight_max,
            f.features_text(),
            f.ps_name,
            f.axes_text(),
            f.coverage
        ],
    )?;
    Ok(())
}

pub fn set_note(conn: &Connection, id: &str, note: &str) -> DbResult<()> {
    conn.execute("UPDATE items SET note = ?2 WHERE id = ?1", params![id, note])?;
    Ok(())
}

pub fn set_rating(conn: &Connection, ids: &[String], rating: u8) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE items SET rating = ?2 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id, rating.min(5)])?;
    }
    Ok(())
}

pub fn set_favorite(conn: &Connection, ids: &[String], on: bool) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE items SET favorite = ?2 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id, on as i64])?;
    }
    Ok(())
}

/// Pins (to the top of every list) or unpins. Items already pinned keep
/// their place when pinned again.
pub fn set_pinned(conn: &Connection, ids: &[String], on: bool) -> DbResult<()> {
    let mut stmt = if on {
        conn.prepare("UPDATE items SET pinned_at = COALESCE(pinned_at, ?2) WHERE id = ?1")?
    } else {
        conn.prepare("UPDATE items SET pinned_at = NULL WHERE id = ?1 AND ?2")?
    };
    let now = now_ms();
    for id in ids {
        stmt.execute(params![id, now])?;
    }
    Ok(())
}

// ---------------------------------------------------------------- shelf

/// The shelf's order across the items (`tray`) and the fonts installed on
/// this computer (`tray_system`, docs/SYSTEM_FONTS.md): their ids by position.
const TRAY_ORDER: &str = "SELECT item_id FROM (SELECT item_id, position, 0 AS k, rowid AS r FROM tray
       UNION ALL SELECT id, position, 1, rowid FROM tray_system) ORDER BY position, k, r";

/// The last position on the shelf (0 when it is empty).
fn tray_last(conn: &Connection) -> DbResult<f64> {
    conn.query_row(
        "SELECT MAX(COALESCE((SELECT MAX(position) FROM tray), 0), COALESCE((SELECT MAX(position) FROM tray_system), 0))",
        [],
        |r| r.get(0),
    )
}

/// Every id on the shelf in its order: items and installed fonts together.
pub fn tray_order(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(TRAY_ORDER)?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Installed fonts on the shelf (id, name), in its order.
pub fn system_tray(conn: &Connection) -> DbResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT id, name FROM tray_system ORDER BY position, rowid")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Puts installed fonts (id, name) on the shelf after what is there. Fonts
/// already on it keep their place.
pub fn add_system_to_tray(conn: &Connection, fonts: &[(String, String)]) -> DbResult<usize> {
    let last = tray_last(conn)?;
    let mut stmt = conn.prepare("INSERT OR IGNORE INTO tray_system (id, name, position) VALUES (?1, ?2, ?3)")?;
    let mut added = 0;
    for (id, name) in fonts {
        added += stmt.execute(params![id, name, last + (added + 1) as f64])?;
    }
    Ok(added)
}

/// Puts items on the shelf, after the ones already there (in the given
/// order). Items already on it keep their place.
pub fn add_to_tray(conn: &Connection, ids: &[String]) -> DbResult<usize> {
    let last = tray_last(conn)?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO tray (item_id, position) SELECT id, ?2 FROM items WHERE id = ?1",
    )?;
    let mut added = 0;
    for id in ids {
        added += stmt.execute(params![id, last + (added + 1) as f64])?;
    }
    Ok(added)
}

/// Takes items and installed fonts off the shelf.
pub fn remove_from_tray(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let mut items = conn.prepare("DELETE FROM tray WHERE item_id = ?1")?;
    let mut system = conn.prepare("DELETE FROM tray_system WHERE id = ?1")?;
    for id in ids {
        items.execute([id])?;
        system.execute([id])?;
    }
    Ok(())
}

/// Empties the shelf (installed fonts too); returns what was on it, in order (to put it back).
pub fn clear_tray(conn: &Connection) -> DbResult<Vec<String>> {
    let ids = tray_order(conn)?;
    conn.execute_batch("DELETE FROM tray; DELETE FROM tray_system;")?;
    Ok(ids)
}

/// Moves `ids` in front of `before` (None = to the end) in the shelf's order
/// (items and installed fonts together).
pub fn reorder_tray(conn: &mut Connection, ids: &[String], before: Option<&str>) -> DbResult<()> {
    let tx = conn.transaction()?;
    let mut order = tray_order(&tx)?;
    let moving: Vec<String> = ids.iter().filter(|id| order.contains(id)).cloned().collect();
    order.retain(|id| !moving.contains(id));
    let at = before
        .and_then(|b| order.iter().position(|id| id == b))
        .unwrap_or(order.len());
    order.splice(at..at, moving);
    {
        let mut items = tx.prepare("UPDATE tray SET position = ?2 WHERE item_id = ?1")?;
        let mut system = tx.prepare("UPDATE tray_system SET position = ?2 WHERE id = ?1")?;
        for (i, id) in order.iter().enumerate() {
            items.execute(params![id, (i + 1) as f64])?;
            system.execute(params![id, (i + 1) as f64])?;
        }
    }
    tx.commit()
}

pub fn rename_item(conn: &Connection, id: &str, name: &str) -> DbResult<()> {
    conn.execute("UPDATE items SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Moves items to the trash.
pub fn trash_items(conn: &Connection, ids: &[String]) -> DbResult<()> {
    conn.execute(
        &format!("UPDATE items SET deleted_at = ?1 WHERE deleted_at IS NULL AND id {IN_IDS}"),
        params![now_ms(), ids_param(ids)],
    )?;
    Ok(())
}

/// Takes items out of the trash.
pub fn restore_items(conn: &Connection, ids: &[String]) -> DbResult<()> {
    conn.execute(&format!("UPDATE items SET deleted_at = NULL WHERE id {IN_IDS}"), [ids_param(ids)])?;
    Ok(())
}

/// Deletes rows and returns them so the caller can remove the files.
pub fn delete_items(conn: &Connection, ids: &[String]) -> DbResult<Vec<Item>> {
    let items = get_items(conn, ids)?;
    conn.execute(&format!("DELETE FROM items WHERE id {IN_IDS}"), [ids_param(ids)])?;
    Ok(items)
}

/// Ids of every item not in the trash, oldest first.
pub fn live_ids(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM items WHERE deleted_at IS NULL ORDER BY imported_at")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

pub fn trashed_ids(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM items WHERE deleted_at IS NOT NULL")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: i64,
    pub unfiled: i64,
    pub untagged: i64,
    pub trash: i64,
    pub favorites: i64,
    pub pinned: i64,
    /// Items on the shelf (not in the trash).
    pub tray: i64,
    /// Fonts not in the trash by writing system, and by typeface style ("none" = unknown).
    pub font_scripts: BTreeMap<String, i64>,
    pub font_categories: BTreeMap<String, i64>,
    /// Fonts not in the trash by weight range (`FONT_WEIGHTS`; a variable
    /// font counts under every range it spans) and by feature.
    pub font_weights: BTreeMap<String, i64>,
    pub font_features: BTreeMap<String, i64>,
}

/// Totals for the sidebar.
pub fn counts(conn: &Connection) -> DbResult<Counts> {
    let by = |col: &str| -> DbResult<BTreeMap<String, i64>> {
        let sql = format!("SELECT {col}, COUNT(*) FROM items WHERE deleted_at IS NULL AND {FONT_READ} GROUP BY 1");
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect()
    };
    let font_scripts = by("items.font_script")?;
    let font_categories = by(FONT_CATEGORY)?;
    // One SUM per range / feature, of fonts whose details were read.
    let sums = |terms: &[(&str, String)]| -> DbResult<BTreeMap<String, i64>> {
        let cols: Vec<String> = terms.iter().map(|(_, t)| format!("SUM({t})")).collect();
        let sql = format!("SELECT {} FROM items WHERE deleted_at IS NULL AND {FONT_READ}", cols.join(", "));
        let mut stmt = conn.prepare_cached(&sql)?;
        stmt.query_row([], |r| {
            terms
                .iter()
                .enumerate()
                .map(|(i, (k, _))| Ok((k.to_string(), r.get::<_, Option<i64>>(i)?.unwrap_or(0))))
                .collect()
        })
    };
    let weight_terms: Vec<(&str, String)> = FONT_WEIGHTS.iter().map(|(k, _, _)| (*k, font_weight_where(k))).collect();
    let feature_terms: Vec<(&str, String)> = crate::fonts::FEATURES.iter().map(|k| (*k, font_feature_term(k))).collect();
    let font_weights = sums(&weight_terms)?.into_iter().filter(|(_, n)| *n > 0).collect();
    let font_features = sums(&feature_terms)?.into_iter().filter(|(_, n)| *n > 0).collect();
    conn.query_row(
        "SELECT
           SUM(deleted_at IS NULL),
           SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_folders f WHERE f.item_id = items.id)),
           SUM(deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id)),
           SUM(deleted_at IS NOT NULL),
           SUM(deleted_at IS NULL AND favorite = 1),
           SUM(deleted_at IS NULL AND pinned_at IS NOT NULL),
           SUM(deleted_at IS NULL AND EXISTS (SELECT 1 FROM tray WHERE tray.item_id = items.id))
         FROM items",
        [],
        |r| {
            Ok(Counts {
                all: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                unfiled: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                untagged: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                trash: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                favorites: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                pinned: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                tray: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                font_scripts,
                font_categories,
                font_weights,
                font_features,
            })
        },
    )
}

// ------------------------------------------------------------- settings

/// Every setting of the library as JSON; values that don't parse are left out
/// (written by something else, read by an older or newer build).
pub fn library_settings(conn: &Connection) -> DbResult<BTreeMap<String, serde_json::Value>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        if let Ok(v) = serde_json::from_str(&value) {
            out.insert(key, v);
        }
    }
    Ok(out)
}

/// Stores a setting; `None` (or JSON null) removes it.
pub fn set_library_setting(conn: &Connection, key: &str, value: Option<&serde_json::Value>) -> DbResult<()> {
    match value.filter(|v| !v.is_null()) {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v.to_string()],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", [key])?,
    };
    Ok(())
}

/// Total size of the files in the library (trash included).
pub fn total_size(conn: &Connection) -> DbResult<i64> {
    conn.query_row("SELECT COALESCE(SUM(size), 0) FROM items", [], |r| r.get(0))
}

// -------------------------------------------------------------- folders

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub count: i64,
    pub color: Option<String>,
}

/// Every folder; `count` is its live items.
pub fn list_folders(conn: &Connection) -> DbResult<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.parent_id, f.name,
           (SELECT COUNT(*) FROM item_folders x JOIN items i ON i.id = x.item_id
            WHERE x.folder_id = f.id AND i.deleted_at IS NULL),
           f.color
         FROM folders f
         ORDER BY f.sort_order IS NULL, f.sort_order, f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Folder { id: r.get(0)?, parent_id: r.get(1)?, name: r.get(2)?, count: r.get(3)?, color: r.get(4)? })
    })?;
    rows.collect()
}

/// Creates a folder at the end of its siblings.
pub fn create_folder(conn: &Connection, name: &str, parent_id: Option<&str>) -> DbResult<String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order) VALUES (?1, ?2, ?3,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM folders WHERE parent_id IS ?2))",
        params![id, parent_id, name],
    )?;
    Ok(id)
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> DbResult<()> {
    conn.execute("UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

/// Deletes the folder and its subfolders. Items themselves are kept.
pub fn delete_folder(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
    Ok(())
}

/// Re-parents a folder (to the end of its new siblings). Returns false (and
/// does nothing) if that would create a cycle.
pub fn move_folder(conn: &mut Connection, id: &str, new_parent: Option<&str>) -> DbResult<bool> {
    place_folder(conn, id, new_parent, None)
}

fn would_cycle(conn: &Connection, id: &str, new_parent: Option<&str>) -> DbResult<bool> {
    let mut cur = new_parent.map(str::to_owned);
    while let Some(c) = cur {
        if c == id {
            return Ok(true);
        }
        cur = conn
            .query_row("SELECT parent_id FROM folders WHERE id = ?1", [&c], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
    }
    Ok(false)
}

/// The folders under `parent` (the top level when None), in their order.
fn sibling_ids(conn: &Connection, parent: Option<&str>) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM folders WHERE parent_id IS ?1
         ORDER BY sort_order IS NULL, sort_order, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![parent], |r| r.get(0))?;
    rows.collect()
}

fn renumber(conn: &Connection, ids: &[String]) -> DbResult<()> {
    let mut stmt = conn.prepare("UPDATE folders SET sort_order = ?2 WHERE id = ?1")?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(params![id, (i + 1) as f64])?;
    }
    Ok(())
}

/// Puts a folder under `parent`, in front of sibling `before` (None = last).
/// Returns false (and does nothing) if the folder is gone or that would create a cycle.
pub fn place_folder(
    conn: &mut Connection,
    id: &str,
    parent: Option<&str>,
    before: Option<&str>,
) -> DbResult<bool> {
    let exists = conn.query_row("SELECT 1 FROM folders WHERE id = ?1", [id], |_| Ok(())).optional()?.is_some();
    if !exists || would_cycle(conn, id, parent)? {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    tx.execute("UPDATE folders SET parent_id = ?2 WHERE id = ?1", params![id, parent])?;
    let mut order = sibling_ids(&tx, parent)?;
    order.retain(|x| x != id);
    let at = before
        .and_then(|b| order.iter().position(|x| x == b))
        .unwrap_or(order.len());
    order.insert(at, id.to_owned());
    renumber(&tx, &order)?;
    tx.commit()?;
    Ok(true)
}

/// Moves a folder up (-1) / down (+1) among its siblings, or to the
/// top (`i32::MIN`) / bottom (`i32::MAX`).
pub fn shift_folder(conn: &mut Connection, id: &str, by: i32) -> DbResult<()> {
    let tx = conn.transaction()?;
    let parent: Option<String> = tx.query_row("SELECT parent_id FROM folders WHERE id = ?1", [id], |r| r.get(0))?;
    let mut order = sibling_ids(&tx, parent.as_deref())?;
    if let Some(from) = order.iter().position(|x| x == id) {
        let item = order.remove(from);
        let to = (from as i64 + by as i64).clamp(0, order.len() as i64) as usize;
        order.insert(to, item);
        renumber(&tx, &order)?;
    }
    tx.commit()
}

/// Resets the children of `parent` (the top level when None) to A→Z order.
pub fn sort_folders_by_name(conn: &mut Connection, parent: Option<&str>) -> DbResult<()> {
    let tx = conn.transaction()?;
    let ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM folders WHERE parent_id IS ?1 ORDER BY name COLLATE NOCASE, id")?;
        let rows = stmt.query_map(params![parent], |r| r.get(0))?;
        rows.collect::<DbResult<_>>()?
    };
    renumber(&tx, &ids)?;
    tx.commit()
}

// -------------------------------------------------------- smart folders

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolder {
    pub id: String,
    pub name: String,
    pub rule: Rule,
    pub count: i64,
    pub color: Option<String>,
}

fn load_rule(conn: &Connection, id: &str) -> DbResult<Option<Rule>> {
    let json: Option<String> = conn
        .query_row("SELECT rule FROM smart_folders WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;
    Ok(json.map(|j| clean_rule(conn, serde_json::from_str(&j).unwrap_or_default())))
}

/// Drops references to tags that have since been deleted.
fn clean_rule(conn: &Connection, mut rule: Rule) -> Rule {
    rule.tag_ids.retain(|t| {
        conn.query_row("SELECT 1 FROM tags WHERE id = ?1", [t], |_| Ok(()))
            .optional()
            .ok()
            .flatten()
            .is_some()
    });
    rule
}

fn count_rule(conn: &Connection, rule: &Rule) -> DbResult<i64> {
    let mut wheres = vec!["items.deleted_at IS NULL".to_string()];
    let mut args: Vec<Box<dyn ToSql>> = Vec::new();
    push_rule(rule, &mut wheres, &mut args);
    conn.query_row(
        &format!("SELECT COUNT(*) FROM items WHERE {}", wheres.join(" AND ")),
        params_from_iter(args.iter().map(|b| b.as_ref())),
        |r| r.get(0),
    )
}

/// Every smart folder; `count` is its live matches.
pub fn list_smart_folders(conn: &Connection) -> DbResult<Vec<SmartFolder>> {
    let rows: Vec<(String, String, String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, name, rule, color FROM smart_folders ORDER BY sort_order, name")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    rows.into_iter()
        .map(|(id, name, json, color)| {
            let rule = clean_rule(conn, serde_json::from_str(&json).unwrap_or_default());
            let count = count_rule(conn, &rule)?;
            Ok(SmartFolder { id, name, rule, count, color })
        })
        .collect()
}

pub fn create_smart_folder(conn: &Connection, name: &str, rule: &Rule) -> DbResult<String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO smart_folders (id, name, rule, sort_order)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM smart_folders))",
        params![id, name, serde_json::to_string(rule).unwrap_or_default()],
    )?;
    Ok(id)
}

pub fn update_smart_folder(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    rule: Option<&Rule>,
) -> DbResult<()> {
    if let Some(n) = name {
        conn.execute("UPDATE smart_folders SET name = ?2 WHERE id = ?1", params![id, n])?;
    }
    if let Some(r) = rule {
        conn.execute(
            "UPDATE smart_folders SET rule = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(r).unwrap_or_default()],
        )?;
    }
    Ok(())
}

pub fn delete_smart_folder(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute("DELETE FROM smart_folders WHERE id = ?1", [id])?;
    Ok(())
}

/// File types in the library with counts (live items), for the filter row.
pub fn list_exts(conn: &Connection) -> DbResult<Vec<(String, i64)>> {
    let mut stmt =
        conn.prepare("SELECT lower(ext), COUNT(*) FROM items WHERE deleted_at IS NULL GROUP BY lower(ext)")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    let mut merged: Vec<(String, i64)> = Vec::new();
    for row in rows {
        let (ext, n) = row?;
        let ext = canonical_ext(&ext);
        match merged.iter_mut().find(|(e, _)| *e == ext) {
            Some((_, c)) => *c += n,
            None => merged.push((ext, n)),
        }
    }
    merged.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(merged)
}

/// Puts items into a folder (taking them out of the one they were in); they
/// go to the end of its manual order. Items already there stay where they are.
pub fn move_to_folder(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let mut del = conn.prepare("DELETE FROM item_folders WHERE item_id = ?1 AND folder_id != ?2")?;
    for id in item_ids {
        del.execute(params![id, folder_id])?;
    }
    file_unfiled(conn, item_ids, folder_id)
}

/// Like `move_to_folder`, but leaves items that already have a folder alone.
pub fn file_unfiled(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO item_folders (item_id, folder_id, position)
         SELECT ?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM item_folders WHERE folder_id = ?2)
         WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2)",
    )?;
    for id in item_ids {
        stmt.execute(params![id, folder_id])?;
    }
    Ok(())
}

/// Moves `ids` (in the given order) in front of `before`, or to the end.
pub fn reorder_in_folder(
    conn: &mut Connection,
    folder_id: &str,
    ids: &[String],
    before: Option<&str>,
) -> DbResult<()> {
    let tx = conn.transaction()?;
    let mut order: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT item_id FROM item_folders WHERE folder_id = ?1
             ORDER BY position IS NULL, position, rowid",
        )?;
        let rows = stmt.query_map([folder_id], |r| r.get(0))?;
        rows.collect::<DbResult<_>>()?
    };
    let moving: Vec<String> = ids.iter().filter(|id| order.contains(id)).cloned().collect();
    order.retain(|id| !moving.contains(id));
    let at = before
        .and_then(|b| order.iter().position(|id| id == b))
        .unwrap_or(order.len());
    order.splice(at..at, moving);
    {
        let mut stmt =
            tx.prepare("UPDATE item_folders SET position = ?3 WHERE item_id = ?1 AND folder_id = ?2")?;
        for (i, id) in order.iter().enumerate() {
            stmt.execute(params![id, folder_id, (i + 1) as f64])?;
        }
    }
    tx.commit()
}

/// Returns the child folder called `name` under `parent` (the top level when
/// None), creating it if needed.
pub fn find_or_create_folder(conn: &Connection, parent: Option<&str>, name: &str) -> DbResult<String> {
    let existing = conn
        .query_row("SELECT id FROM folders WHERE name = ?1 AND parent_id IS ?2", params![name, parent], |r| r.get(0))
        .optional()?;
    match existing {
        Some(id) => Ok(id),
        None => create_folder(conn, name, parent),
    }
}

pub fn remove_from_folder(conn: &Connection, item_ids: &[String], folder_id: &str) -> DbResult<()> {
    let mut stmt = conn.prepare("DELETE FROM item_folders WHERE item_id = ?1 AND folder_id = ?2")?;
    for id in item_ids {
        stmt.execute(params![id, folder_id])?;
    }
    Ok(())
}

// ----------------------------------------------------------------- tags

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
    pub color: Option<String>,
}

/// Every tag; `count` is its live items.
pub fn list_tags(conn: &Connection) -> DbResult<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name,
           (SELECT COUNT(*) FROM item_tags x JOIN items i ON i.id = x.item_id
            WHERE x.tag_id = t.id AND i.deleted_at IS NULL),
           t.color
         FROM tags t ORDER BY t.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], tag_row)?;
    rows.collect()
}

fn tag_row(r: &rusqlite::Row) -> DbResult<Tag> {
    Ok(Tag { id: r.get(0)?, name: r.get(1)?, count: r.get(2)?, color: r.get(3)? })
}

/// Colours a folder, smart folder or tag can take (the UI maps them to shades).
pub const COLORS: [&str; 9] = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"];

#[derive(Debug, Clone, Copy)]
pub enum ColorTarget {
    Folder,
    SmartFolder,
    Tag,
}

/// Sets (or with `None`, clears) the colour of a folder, smart folder or tag.
pub fn set_color(conn: &Connection, target: ColorTarget, id: &dyn ToSql, color: Option<&str>) -> DbResult<()> {
    if let Some(c) = color {
        if !COLORS.contains(&c) {
            return Err(rusqlite::Error::InvalidParameterName(format!("unknown colour: {c}")));
        }
    }
    let table = match target {
        ColorTarget::Folder => "folders",
        ColorTarget::SmartFolder => "smart_folders",
        ColorTarget::Tag => "tags",
    };
    conn.execute(&format!("UPDATE {table} SET color = ?1 WHERE id = ?2"), params![color, id])?;
    Ok(())
}

/// The tag `name`, made if there isn't one.
pub(crate) fn ensure_tag(conn: &Connection, name: &str) -> DbResult<i64> {
    conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [name])?;
    conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
}

/// Makes the tag `name` (the sidebar's ＋): the existing one if the name is taken. Empty names make none.
pub fn create_tag(conn: &Connection, name: &str) -> DbResult<Option<Tag>> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let id = ensure_tag(conn, name)?;
    list_tags(conn).map(|tags| tags.into_iter().find(|t| t.id == id))
}

/// Tags items by name (tags are made where missing).
pub fn add_tags(conn: &mut Connection, item_ids: &[String], names: &[String]) -> DbResult<()> {
    let tx = conn.transaction()?;
    for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        let tag_id = ensure_tag(&tx, name)?;
        let mut stmt = tx.prepare_cached(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT id, ?2 FROM items WHERE id = ?1",
        )?;
        for id in item_ids {
            stmt.execute(params![id, tag_id])?;
        }
    }
    tx.commit()
}

pub fn remove_tag(conn: &Connection, item_ids: &[String], tag_id: i64) -> DbResult<()> {
    let mut stmt = conn.prepare("DELETE FROM item_tags WHERE item_id = ?1 AND tag_id = ?2")?;
    for id in item_ids {
        stmt.execute(params![id, tag_id])?;
    }
    Ok(())
}

/// Renames a tag. If another tag already has that name, the two are merged.
pub fn rename_tag(conn: &mut Connection, id: i64, name: &str) -> DbResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let existing: Option<i64> = tx
        .query_row("SELECT id FROM tags WHERE name = ?1 AND id != ?2", params![name, id], |r| r.get(0))
        .optional()?;
    match existing {
        Some(target) => {
            tx.execute(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
                 SELECT item_id, ?2 FROM item_tags WHERE tag_id = ?1",
                params![id, target],
            )?;
            tx.execute("DELETE FROM tags WHERE id = ?1", [id])?;
            merge_rule_tag(&tx, id, target)?;
        }
        None => {
            tx.execute("UPDATE tags SET name = ?2 WHERE id = ?1", params![id, name])?;
        }
    }
    tx.commit()
}

/// Smart-folder rules on tag `from` now use `to` (merged into it). The JSON
/// is edited in place, so fields this build doesn't know are kept.
fn merge_rule_tag(conn: &Connection, from: i64, to: i64) -> DbResult<()> {
    let rows: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, rule FROM smart_folders")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<DbResult<_>>()?
    };
    for (id, json) in rows {
        let Ok(mut rule) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
        let Some(tags) = rule.get_mut("tagIds").and_then(|t| t.as_array_mut()) else { continue };
        if !tags.iter().any(|t| t.as_i64() == Some(from)) {
            continue;
        }
        tags.retain(|t| t.as_i64() != Some(from));
        if !tags.iter().any(|t| t.as_i64() == Some(to)) {
            tags.push(to.into());
        }
        conn.execute("UPDATE smart_folders SET rule = ?2 WHERE id = ?1", params![id, rule.to_string()])?;
    }
    Ok(())
}

pub fn delete_tag(conn: &Connection, id: i64) -> DbResult<()> {
    conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
    Ok(())
}

// ------------------------------------------------------------ selection

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderRef {
    pub id: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionInfo {
    /// Tags present on at least one selected item; `count` = how many of them.
    pub tags: Vec<Tag>,
    pub folders: Vec<FolderRef>,
}

pub fn selection_info(conn: &Connection, ids: &[String]) -> DbResult<SelectionInfo> {
    if ids.is_empty() {
        return Ok(SelectionInfo { tags: vec![], folders: vec![] });
    }
    let ids = ids_param(ids);
    let mut stmt = conn.prepare(&format!(
        "SELECT t.id, t.name, COUNT(*), t.color FROM item_tags x JOIN tags t ON t.id = x.tag_id
         WHERE x.item_id {IN_IDS} GROUP BY t.id ORDER BY t.name COLLATE NOCASE"
    ))?;
    let tags = stmt.query_map([&ids], tag_row)?.collect::<DbResult<Vec<_>>>()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT folder_id, COUNT(*) FROM item_folders WHERE item_id {IN_IDS} GROUP BY folder_id"
    ))?;
    let folders = stmt
        .query_map([&ids], |r| Ok(FolderRef { id: r.get(0)?, count: r.get(1)? }))?
        .collect::<DbResult<Vec<_>>>()?;
    Ok(SelectionInfo { tags, folders })
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests;
