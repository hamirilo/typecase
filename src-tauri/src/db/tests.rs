use super::*;

fn mem() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrate(&conn).unwrap();
    conn
}

fn meta(ps: &str) -> crate::fonts::FontMeta {
    crate::fonts::FontMeta {
        family: "F".into(),
        weight: 400,
        weight_min: 400,
        weight_max: 400,
        script: "latin",
        category: None,
        features: vec![],
        axes: vec![],
        ps_name: ps.into(),
    }
}

fn add(conn: &mut Connection, id: &str, name: &str, at: i64) {
    let tx = conn.transaction().unwrap();
    insert_item(
        &tx,
        &NewItem {
            id: id.into(),
            name: name.into(),
            file_name: name.into(),
            ext: "ttf".into(),
            size: at,
            hash: format!("h-{id}"),
            thumb: format!("{id}.png"),
            font: meta(""),
        },
        at,
    )
    .unwrap();
    tx.commit().unwrap();
}

fn q(view: View) -> ItemQuery {
    ItemQuery {
        view,
        search: String::new(),
        tag_ids: vec![],
        tag_match_all: false,
        include_subfolders: false,
        min_rating: 0,
        filter: Filter::default(),
        sort: SortKey::ImportedAt,
        desc: false,
    }
}

fn ids(items: Vec<Item>) -> Vec<String> {
    items.into_iter().map(|i| i.id).collect()
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn tag_id(conn: &Connection, name: &str) -> i64 {
    conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0)).unwrap()
}

#[test]
fn migrate_is_idempotent() {
    let conn = mem();
    migrate(&conn).unwrap();
    let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, SCHEMA_VERSION);
}

#[test]
fn views_and_counts() {
    let mut conn = mem();
    add(&mut conn, "a", "Alpha.ttf", 1);
    add(&mut conn, "b", "Beta.ttf", 2);
    add(&mut conn, "c", "Gamma.ttf", 3);
    let f = create_folder(&conn, "Sans", None).unwrap();
    move_to_folder(&conn, &s(&["a"]), &f).unwrap();
    add_tags(&mut conn, &s(&["b"]), &s(&["body"])).unwrap();
    trash_items(&conn, &s(&["c"])).unwrap();

    assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "b"]));
    assert_eq!(ids(query_items(&conn, &q(View::Unfiled)).unwrap()), s(&["b"]));
    assert_eq!(ids(query_items(&conn, &q(View::Untagged)).unwrap()), s(&["a"]));
    assert_eq!(ids(query_items(&conn, &q(View::Trash)).unwrap()), s(&["c"]));
    assert_eq!(ids(query_items(&conn, &q(View::Folder { id: f.clone() })).unwrap()), s(&["a"]));
    let latin = BTreeMap::from([("latin".to_string(), 2)]);
    assert_eq!(
        counts(&conn).unwrap(),
        Counts {
            all: 2,
            unfiled: 1,
            untagged: 1,
            trash: 1,
            favorites: 0,
            pinned: 0,
            tray: 0,
            font_scripts: latin,
            font_categories: BTreeMap::from([("none".to_string(), 2)]),
            font_weights: BTreeMap::from([("regular".to_string(), 2)]),
            font_features: BTreeMap::new(),
        }
    );

    restore_items(&conn, &s(&["c"])).unwrap();
    assert_eq!(counts(&conn).unwrap().trash, 0);
    assert_eq!(counts(&conn).unwrap().all, 3);
}

#[test]
fn colours_folders_smart_folders_and_tags() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    let f = create_folder(&conn, "F", None).unwrap();
    let sf = create_smart_folder(&conn, "S", &Rule::default()).unwrap();
    add_tags(&mut conn, &s(&["a"]), &s(&["t"])).unwrap();
    let tag = list_tags(&conn).unwrap()[0].id;
    set_color(&conn, ColorTarget::Folder, &f, Some("red")).unwrap();
    set_color(&conn, ColorTarget::SmartFolder, &sf, Some("blue")).unwrap();
    set_color(&conn, ColorTarget::Tag, &tag, Some("green")).unwrap();
    assert_eq!(list_folders(&conn).unwrap()[0].color.as_deref(), Some("red"));
    assert_eq!(list_smart_folders(&conn).unwrap()[0].color.as_deref(), Some("blue"));
    assert_eq!(list_tags(&conn).unwrap()[0].color.as_deref(), Some("green"));
    assert_eq!(selection_info(&conn, &s(&["a"])).unwrap().tags[0].color.as_deref(), Some("green"));
    set_color(&conn, ColorTarget::Folder, &f, None).unwrap();
    assert_eq!(list_folders(&conn).unwrap()[0].color, None);
    assert!(set_color(&conn, ColorTarget::Folder, &f, Some("chartreuse")).is_err());
}

#[test]
fn an_item_lives_in_one_folder() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    let (f, g) = (create_folder(&conn, "F", None).unwrap(), create_folder(&conn, "G", None).unwrap());
    move_to_folder(&conn, &s(&["a"]), &f).unwrap();
    move_to_folder(&conn, &s(&["a"]), &f).unwrap(); // same folder again: no-op
    move_to_folder(&conn, &s(&["a"]), &g).unwrap();
    assert_eq!(ids(query_items(&conn, &q(View::Folder { id: f.clone() })).unwrap()), Vec::<String>::new());
    assert_eq!(ids(query_items(&conn, &q(View::Folder { id: g.clone() })).unwrap()), s(&["a"]));
    file_unfiled(&conn, &s(&["a"]), &f).unwrap(); // already filed: stays in G
    assert_eq!(ids(query_items(&conn, &q(View::Folder { id: g })).unwrap()), s(&["a"]));
    remove_from_folder(&conn, &s(&["a"]), &f).unwrap(); // not in F: no-op
    assert_eq!(counts(&conn).unwrap().unfiled, 0);
    // A folder that is gone takes nothing.
    add(&mut conn, "b", "b.ttf", 2);
    file_unfiled(&conn, &s(&["b"]), "gone").unwrap();
    assert_eq!(counts(&conn).unwrap().unfiled, 1);
}

#[test]
fn tag_filter_any_or_all() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    add(&mut conn, "c", "c.ttf", 3);
    add_tags(&mut conn, &s(&["a", "b"]), &s(&["red"])).unwrap();
    add_tags(&mut conn, &s(&["b", "c"]), &s(&["blue"])).unwrap();
    let tags = list_tags(&conn).unwrap();
    let id = |n: &str| tags.iter().find(|t| t.name == n).unwrap().id;

    let mut query = q(View::All);
    query.tag_ids = vec![id("red"), id("blue")];
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c"]));
    query.tag_match_all = true;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));
}

#[test]
fn search_tags_and_sort() {
    let mut conn = mem();
    add(&mut conn, "a", "Mono_1.ttf", 1);
    add(&mut conn, "b", "serif.ttf", 2);
    add(&mut conn, "c", "mono%2.ttf", 3);
    add_tags(&mut conn, &s(&["b", "c"]), &s(&["body", "Heading"])).unwrap();
    set_note(&conn, "b", "for long texts").unwrap();
    conn.execute("UPDATE items SET font_family = 'Noto Serif JP' WHERE id = 'b'", []).unwrap();

    let mut query = q(View::All);
    query.search = "mono".into();
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "c"]));
    query.search = "%".into(); // LIKE wildcard must be escaped
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c"]));
    query.search = "long".into(); // note
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));
    query.search = "head".into(); // tag name
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c"]));
    query.search = "noto".into(); // family
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));

    let tags = list_tags(&conn).unwrap();
    assert_eq!(tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["body", "Heading"]);
    let body = tags.iter().find(|t| t.name == "body").unwrap().id;
    remove_tag(&conn, &s(&["c"]), body).unwrap();
    let mut query = q(View::All);
    query.tag_ids = vec![body];
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));

    let mut query = q(View::All);
    query.sort = SortKey::Name;
    query.desc = true;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "a", "c"])); // "_" > "%"
}

#[test]
fn tag_rename_merges() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    add_tags(&mut conn, &s(&["a"]), &s(&["red"])).unwrap();
    add_tags(&mut conn, &s(&["a", "b"]), &s(&["Rouge"])).unwrap();
    let red = list_tags(&conn).unwrap().into_iter().find(|t| t.name == "red").unwrap();
    rename_tag(&mut conn, red.id, "rouge").unwrap(); // case-insensitive clash
    let tags = list_tags(&conn).unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].count, 2);
}

#[test]
fn folder_tree_ops() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    let p = create_folder(&conn, "Parent", None).unwrap();
    let c = create_folder(&conn, "Child", Some(&p)).unwrap();
    move_to_folder(&conn, &s(&["a"]), &c).unwrap();

    assert!(!move_folder(&mut conn, &p, Some(&c)).unwrap(), "cycle must be rejected");
    assert!(!move_folder(&mut conn, &p, Some(&p)).unwrap());
    assert!(move_folder(&mut conn, &c, None).unwrap());
    assert!(move_folder(&mut conn, &c, Some(&p)).unwrap());

    let info = selection_info(&conn, &s(&["a"])).unwrap();
    assert_eq!(info.folders, vec![FolderRef { id: c.clone(), count: 1 }]);

    delete_folder(&conn, &p).unwrap(); // cascades to child
    assert!(list_folders(&conn).unwrap().is_empty());
    assert_eq!(counts(&conn).unwrap().unfiled, 1);
    assert_eq!(counts(&conn).unwrap().all, 1);
}

#[test]
fn delete_cascades_links() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add_tags(&mut conn, &s(&["a"]), &s(&["x"])).unwrap();
    trash_items(&conn, &s(&["a"])).unwrap();
    assert_eq!(trashed_ids(&conn).unwrap(), s(&["a"]));
    let removed = delete_items(&conn, &s(&["a"])).unwrap();
    assert_eq!(removed.len(), 1);
    let links: i64 = conn.query_row("SELECT COUNT(*) FROM item_tags", [], |r| r.get(0)).unwrap();
    assert_eq!(links, 0);
    assert!(hash_index(&conn).unwrap().is_empty());
}

#[test]
fn id_lists_past_the_parameter_limit() {
    let mut conn = mem();
    // More than SQLite's 32766 parameters.
    let ids: Vec<String> = (0..40_000).map(|i| format!("i{i}")).collect();
    let tx = conn.transaction().unwrap();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO items (id, name, file_name, ext, size, hash, thumb, imported_at)
                 VALUES (?1, 'n', 'n.ttf', 'ttf', 1, ?1, 't.png', 1)",
            )
            .unwrap();
        for id in &ids {
            stmt.execute([id]).unwrap();
        }
    }
    tx.commit().unwrap();
    add_tags(&mut conn, &ids[..2], &s(&["x"])).unwrap();

    assert_eq!(get_items(&conn, &ids).unwrap().len(), ids.len());
    assert_eq!(selection_info(&conn, &ids).unwrap().tags[0].count, 2);
    trash_items(&conn, &ids).unwrap();
    assert_eq!(trashed_ids(&conn).unwrap().len(), ids.len());
    restore_items(&conn, &ids).unwrap();
    assert!(trashed_ids(&conn).unwrap().is_empty());
    assert_eq!(delete_items(&conn, &ids).unwrap().len(), ids.len());
    assert!(query_items(&conn, &q(View::All)).unwrap().is_empty());
}

#[test]
fn tag_ids_are_never_reused() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add_tags(&mut conn, &s(&["a"]), &s(&["x", "y"])).unwrap();
    let y = tag_id(&conn, "y");
    delete_tag(&conn, y).unwrap();
    // Still cascading, and the highest id isn't handed out again.
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM item_tags", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(ensure_tag(&conn, "z").unwrap(), y + 1);
    assert_eq!(ensure_tag(&conn, "x").unwrap(), tag_id(&conn, "x"), "an existing tag is found");
}

#[test]
fn ratings_sort_and_filter() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    add(&mut conn, "c", "c.ttf", 3);
    set_rating(&conn, &s(&["a"]), 3).unwrap();
    set_rating(&conn, &s(&["c"]), 9).unwrap(); // clamped to 5
    let mut query = q(View::All);
    query.sort = SortKey::Rating;
    query.desc = true;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a", "b"]));
    assert_eq!(query_items(&conn, &query).unwrap()[0].rating, 5);
    query.min_rating = 3;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a"]));
}

#[test]
fn favorites_and_pins() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    add(&mut conn, "c", "c.ttf", 3);
    set_favorite(&conn, &s(&["b"]), true).unwrap();
    assert_eq!(ids(query_items(&conn, &q(View::Favorites)).unwrap()), s(&["b"]));
    assert!(query_items(&conn, &q(View::Favorites)).unwrap()[0].favorite);
    set_favorite(&conn, &s(&["b"]), false).unwrap();
    assert!(query_items(&conn, &q(View::Favorites)).unwrap().is_empty());

    // Pinned items lead every list, latest pin first; the rest keep the sort.
    set_pinned(&conn, &s(&["c"]), true).unwrap();
    let first = query_items(&conn, &q(View::Pinned)).unwrap()[0].pinned_at;
    set_pinned(&conn, &s(&["c"]), true).unwrap(); // no-op, keeps its time
    assert_eq!(query_items(&conn, &q(View::Pinned)).unwrap()[0].pinned_at, first);
    conn.execute("UPDATE items SET pinned_at = pinned_at - 10 WHERE id = 'c'", []).unwrap();
    set_pinned(&conn, &s(&["a"]), true).unwrap();
    assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "c", "b"]));
    assert_eq!(ids(query_items(&conn, &q(View::Pinned)).unwrap()), s(&["a", "c"]));
    assert_eq!(counts(&conn).unwrap().pinned, 2);
    set_pinned(&conn, &s(&["a", "c"]), false).unwrap();
    assert_eq!(ids(query_items(&conn, &q(View::All)).unwrap()), s(&["a", "b", "c"]));
    assert_eq!(counts(&conn).unwrap().pinned, 0);
}

#[test]
fn library_settings_round_trip() {
    let conn = mem();
    assert!(library_settings(&conn).unwrap().is_empty());
    set_library_setting(&conn, "layout", Some(&serde_json::json!("specimen"))).unwrap();
    assert_eq!(library_settings(&conn).unwrap()["layout"], "specimen");

    // Overwrite, then remove with null; broken JSON is ignored.
    set_library_setting(&conn, "layout", Some(&serde_json::json!("grid"))).unwrap();
    assert_eq!(library_settings(&conn).unwrap()["layout"], "grid");
    set_library_setting(&conn, "layout", Some(&serde_json::Value::Null)).unwrap();
    conn.execute("INSERT INTO settings VALUES ('broken', '{')", []).unwrap();
    assert!(library_settings(&conn).unwrap().is_empty());
    set_library_setting(&conn, "x", Some(&serde_json::json!(1))).unwrap();
    set_library_setting(&conn, "x", None).unwrap();
    assert!(library_settings(&conn).unwrap().is_empty());
}

#[test]
fn work_tray() {
    let mut conn = mem();
    for (id, at) in [("a", 1), ("b", 2), ("c", 3), ("d", 4)] {
        add(&mut conn, id, id, at);
    }
    let manual = |conn: &Connection| {
        let mut query = q(View::Tray);
        query.sort = SortKey::Manual;
        ids(query_items(conn, &query).unwrap())
    };
    // Added in the given order, after what is already there; no duplicates.
    assert_eq!(add_to_tray(&conn, &s(&["c", "a"])).unwrap(), 2);
    assert_eq!(add_to_tray(&conn, &s(&["a", "b", "zz"])).unwrap(), 1);
    assert_eq!(manual(&conn), s(&["c", "a", "b"]));
    assert_eq!(ids(query_items(&conn, &q(View::Tray)).unwrap()), s(&["a", "b", "c"]));
    assert!(query_items(&conn, &q(View::All)).unwrap().iter().any(|i| i.id == "a" && i.in_tray));
    assert!(!query_items(&conn, &q(View::All)).unwrap().iter().any(|i| i.id == "d" && i.in_tray));
    assert_eq!(counts(&conn).unwrap().tray, 3);

    // The shelf's own order ignores pins (it is the order things are compared in).
    set_pinned(&conn, &s(&["b"]), true).unwrap();
    assert_eq!(manual(&conn), s(&["c", "a", "b"]));
    reorder_tray(&mut conn, &s(&["b"]), Some("c")).unwrap();
    assert_eq!(manual(&conn), s(&["b", "c", "a"]));
    reorder_tray(&mut conn, &s(&["b", "c"]), None).unwrap();
    assert_eq!(manual(&conn), s(&["a", "b", "c"]));

    // Trashed items leave the shelf view but come back when restored.
    trash_items(&conn, &s(&["a"])).unwrap();
    assert_eq!(manual(&conn), s(&["b", "c"]));
    assert_eq!(counts(&conn).unwrap().tray, 2);
    restore_items(&conn, &s(&["a"])).unwrap();

    remove_from_tray(&conn, &s(&["b"])).unwrap();
    assert_eq!(manual(&conn), s(&["a", "c"]));
    assert_eq!(clear_tray(&conn).unwrap(), s(&["a", "c"]));
    assert!(manual(&conn).is_empty());
    assert_eq!(counts(&conn).unwrap().tray, 0);
}

#[test]
fn installed_fonts_share_the_shelf() {
    let mut conn = mem();
    for (id, at) in [("a", 1), ("b", 2)] {
        add(&mut conn, id, id, at);
    }
    let sys = |ids: &[&str]| ids.iter().map(|i| (i.to_string(), format!("{i} name"))).collect::<Vec<_>>();
    // One order across items and installed fonts, each added after what is there.
    add_to_tray(&conn, &s(&["a"])).unwrap();
    assert_eq!(add_system_to_tray(&conn, &sys(&["sys:x", "sys:y"])).unwrap(), 2);
    assert_eq!(add_system_to_tray(&conn, &sys(&["sys:x"])).unwrap(), 0, "no duplicates");
    add_to_tray(&conn, &s(&["b"])).unwrap();
    assert_eq!(tray_order(&conn).unwrap(), s(&["a", "sys:x", "sys:y", "b"]));
    assert_eq!(system_tray(&conn).unwrap(), sys(&["sys:x", "sys:y"]));

    reorder_tray(&mut conn, &s(&["b", "sys:y"]), Some("a")).unwrap();
    assert_eq!(tray_order(&conn).unwrap(), s(&["b", "sys:y", "a", "sys:x"]));
    remove_from_tray(&conn, &s(&["sys:y", "a"])).unwrap();
    assert_eq!(tray_order(&conn).unwrap(), s(&["b", "sys:x"]));
    // The items' count leaves the installed fonts out.
    assert_eq!(counts(&conn).unwrap().tray, 1);
    assert_eq!(clear_tray(&conn).unwrap(), s(&["b", "sys:x"]));
    assert!(tray_order(&conn).unwrap().is_empty() && system_tray(&conn).unwrap().is_empty());
}

#[test]
fn items_carry_folder_and_tags() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    let f = create_folder(&conn, "F", None).unwrap();
    move_to_folder(&conn, &s(&["a"]), &f).unwrap();
    add_tags(&mut conn, &s(&["a"]), &s(&["x", "y"])).unwrap();
    let items = query_items(&conn, &q(View::All)).unwrap();
    assert_eq!(items[0].folder_id.as_deref(), Some(f.as_str()));
    assert_eq!(items[0].tag_ids.len(), 2);
    assert_eq!(items[1].folder_id, None);
    assert!(items[1].tag_ids.is_empty());
}

#[test]
fn search_syntax_end_to_end() {
    let mut conn = mem();
    add(&mut conn, "a", "bold sans.ttf", 1);
    add(&mut conn, "b", "bold serif.ttf", 2);
    add(&mut conn, "c", "light sans.ttf", 3);
    add_tags(&mut conn, &s(&["c"]), &s(&["for signs"])).unwrap();
    let find = |conn: &Connection, text: &str| {
        let mut query = q(View::All);
        query.search = text.into();
        ids(query_items(conn, &query).unwrap())
    };
    assert_eq!(find(&conn, "(sans OR serif) bold"), s(&["a", "b"]));
    assert_eq!(find(&conn, "sans -bold"), s(&["c"]));
    assert_eq!(find(&conn, "serif || light"), s(&["b", "c"]));
    assert_eq!(find(&conn, r#""for signs""#), s(&["c"]));
    assert_eq!(find(&conn, "-sans -serif"), Vec::<String>::new());
}

#[test]
fn subfolders_and_manual_order() {
    let mut conn = mem();
    for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
        add(&mut conn, id, &format!("{id}.ttf"), i as i64);
    }
    let p = create_folder(&conn, "P", None).unwrap();
    let c = create_folder(&conn, "C", Some(&p)).unwrap();
    let g = create_folder(&conn, "G", Some(&c)).unwrap();
    move_to_folder(&conn, &s(&["a", "b", "c"]), &p).unwrap();
    move_to_folder(&conn, &s(&["d"]), &g).unwrap();

    let mut query = q(View::Folder { id: p.clone() });
    query.sort = SortKey::Manual;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c"]));
    query.include_subfolders = true;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b", "c", "d"]));

    query.include_subfolders = false;
    reorder_in_folder(&mut conn, &p, &s(&["c"]), Some("a")).unwrap();
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["c", "a", "b"]));
    reorder_in_folder(&mut conn, &p, &s(&["c", "a"]), None).unwrap();
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c", "a"]));
    // Newly added items go to the end.
    move_to_folder(&conn, &s(&["d"]), &p).unwrap();
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "c", "a", "d"]));
}

#[test]
fn find_or_create_reuses() {
    let conn = mem();
    let a = find_or_create_folder(&conn, None, "Sans").unwrap();
    assert_eq!(find_or_create_folder(&conn, None, "Sans").unwrap(), a);
    let child = find_or_create_folder(&conn, Some(&a), "Sans").unwrap();
    assert_ne!(child, a, "same name under a different parent is a different folder");
    assert_eq!(find_or_create_folder(&conn, Some(&a), "Sans").unwrap(), child);
}

/// 軸 and スタイル数 in the filter row: axes of variable fonts, and the size of a font's family.
#[test]
fn axes_and_family_size_filters() {
    let mut conn = mem();
    // Family "Sans": 300 / 400 / 700 (three styles, light to bold); "Slab": one font; "Var": variable.
    for (id, family, wmin, wmax, axes, at) in [
        ("a", "Sans", 300, 300, "", 1),
        ("b", "Sans", 400, 400, "", 2),
        ("c", "Sans", 700, 700, "", 3),
        ("d", "Slab", 400, 400, "", 4),
        ("e", "Var", 100, 900, "wght,opsz", 5),
    ] {
        add(&mut conn, id, &format!("{id}.ttf"), at);
        conn.execute(
            "UPDATE items SET font_script = 'latin', font_features = '', font_family = ?2,
               font_weight_min = ?3, font_weight_max = ?4, font_axes = ?5 WHERE id = ?1",
            params![id, family, wmin, wmax, axes],
        )
        .unwrap();
    }
    let find = |conn: &Connection, set: fn(&mut Filter)| {
        let mut f = Filter::default();
        set(&mut f);
        let mut query = q(View::All);
        query.filter = f;
        ids(query_items(conn, &query).unwrap())
    };
    assert_eq!(find(&conn, |f| f.font_axes = vec!["wght".into()]), s(&["e"]));
    assert_eq!(find(&conn, |f| f.font_axes = vec!["opsz".into(), "wdth".into()]), s(&["e"]), "any of");
    assert!(find(&conn, |f| f.font_axes = vec!["wdth".into()]).is_empty());
    assert!(find(&conn, |f| f.font_axes = vec!["ws".into()]).is_empty(), "whole words");
    assert_eq!(find(&conn, |f| f.font_styles = vec!["1".into()]), s(&["d", "e"]));
    assert_eq!(find(&conn, |f| f.font_styles = vec!["2-3".into()]), s(&["a", "b", "c"]));
    assert!(find(&conn, |f| f.font_styles = vec!["9+".into()]).is_empty());
    assert_eq!(find(&conn, |f| f.font_styles = vec!["wide".into()]), s(&["a", "b", "c", "e"]), "light to bold");
    assert_eq!(find(&conn, |f| f.font_styles = vec!["1".into(), "2-3".into()]).len(), 5, "any of");
    assert!(find(&conn, |f| f.font_styles = vec!["nonsense".into()]).is_empty());
    // A trashed font doesn't count towards its family.
    conn.execute("UPDATE items SET deleted_at = 1 WHERE id = 'c'", []).unwrap();
    assert_eq!(find(&conn, |f| f.font_styles = vec!["2-3".into()]), s(&["a", "b"]));
    assert_eq!(find(&conn, |f| f.font_styles = vec!["wide".into()]), s(&["e"]));

    // Counts: each value over the matched fonts.
    let facets = facet_counts(&conn, &q(View::All)).unwrap();
    assert_eq!(facets.font_axes, BTreeMap::from([("wght".to_string(), 1), ("opsz".to_string(), 1)]));
    assert_eq!(
        facets.font_styles,
        BTreeMap::from([("1".to_string(), 2), ("2-3".to_string(), 2), ("wide".to_string(), 1)])
    );
}

/// Libraries from before the axes were stored have them NULL: those fonts are read again.
#[test]
fn fonts_without_axes_are_read_again() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    conn.execute("UPDATE items SET font_script = 'latin', font_features = '', font_axes = NULL WHERE id = 'a'", [])
        .unwrap();
    assert_eq!(missing_font_meta(&conn).unwrap().len(), 1);
    let mut m = meta("ps-a");
    m.axes = vec!["wght"];
    set_font_meta(&mut conn, &[("a".to_string(), m)]).unwrap();
    assert!(missing_font_meta(&conn).unwrap().is_empty());
    let axes: String = conn.query_row("SELECT font_axes FROM items WHERE id = 'a'", [], |r| r.get(0)).unwrap();
    assert_eq!(axes, "wght");
}

/// A writing system or a typeface style opened as a place (the sidebar's 言語 / 書体).
#[test]
fn font_places() {
    let mut conn = mem();
    for (id, at) in [("a", 1), ("b", 2), ("c", 3)] {
        add(&mut conn, id, &format!("{id}.ttf"), at);
    }
    conn.execute("UPDATE items SET font_script = 'ja', font_category = 'mincho' WHERE id = 'a'", []).unwrap();
    conn.execute("UPDATE items SET font_script = 'latin', font_category = 'gothic' WHERE id = 'b'", []).unwrap();
    conn.execute("UPDATE items SET font_script = 'latin' WHERE id = 'c'", []).unwrap();
    let open = |view: View| ids(query_items(&conn, &q(view)).unwrap());
    assert_eq!(open(View::FontScript { id: "ja".into() }), s(&["a"]));
    assert_eq!(open(View::FontScript { id: "latin".into() }), s(&["b", "c"]));
    assert_eq!(open(View::FontCategory { id: "gothic".into() }), s(&["b"]));
    assert_eq!(open(View::FontCategory { id: "none".into() }), s(&["c"]), "style unknown");
    // The user's style wins over the guess, as in the filter.
    set_font_category(&conn, &s(&["a"]), Some("gothic")).unwrap();
    assert_eq!(open(View::FontCategory { id: "gothic".into() }), s(&["a", "b"]));
    // A place and a condition together: all of them.
    let mut query = q(View::FontScript { id: "latin".into() });
    query.filter.font_categories = vec!["gothic".into()];
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b"]));
}

/// The sidebar's ＋ on 「タグ」: an empty tag, listed with a count of 0.
#[test]
fn create_tag_makes_an_empty_tag() {
    let mut conn = mem();
    let t = create_tag(&conn, "  案件A ").unwrap().unwrap();
    assert_eq!((t.name.as_str(), t.count), ("案件A", 0));
    assert_eq!(list_tags(&conn).unwrap().len(), 1);
    assert_eq!(create_tag(&conn, "案件A").unwrap().unwrap().id, t.id, "same name: the same tag");
    assert!(create_tag(&conn, "   ").unwrap().is_none());
    add(&mut conn, "a", "a.ttf", 1);
    add_tags(&mut conn, &s(&["a"]), &s(&["案件A"])).unwrap();
    assert_eq!(list_tags(&conn).unwrap()[0].count, 1);
}

#[test]
fn attribute_filters() {
    let mut conn = mem();
    for (id, ext, size, at) in [("a", "OTF", 500_000, 1_000), ("b", "ttf", 50_000, 2_000), ("c", "ttf", 5_000_000, 3_000), ("d", "woff2", 10, 4_000)] {
        add(&mut conn, id, &format!("{id}.{ext}"), at);
        conn.execute("UPDATE items SET ext = ?2, size = ?3 WHERE id = ?1", params![id, ext, size]).unwrap();
    }
    let find = |conn: &Connection, f: Filter| {
        let mut query = q(View::All);
        query.filter = f;
        ids(query_items(conn, &query).unwrap())
    };
    let f = |set: fn(&mut Filter)| {
        let mut f = Filter::default();
        set(&mut f);
        f
    };
    assert_eq!(find(&conn, f(|f| f.exts = vec!["otf".into()])), s(&["a"]), "otf matches .OTF");
    assert_eq!(find(&conn, f(|f| f.exts = vec!["woff2".into(), "ttf".into()])), s(&["b", "c", "d"]));
    assert_eq!(find(&conn, f(|f| { f.imported_after = Some(2_000); f.imported_before = Some(4_000) })), s(&["b", "c"]));
    assert_eq!(find(&conn, f(|f| f.max_size = Some(50_000))), s(&["b", "d"]));
    assert_eq!(find(&conn, f(|f| f.min_size = Some(1_000_000))), s(&["c"]));

    // Writing system and style; the user's style wins over the guess.
    conn.execute("UPDATE items SET font_script = 'ja', font_category = 'gothic' WHERE id = 'd'", []).unwrap();
    assert_eq!(find(&conn, f(|f| f.font_scripts = vec!["ja".into()])), s(&["d"]));
    assert_eq!(find(&conn, f(|f| f.font_scripts = vec!["latin".into()])), s(&["a", "b", "c"]));
    assert_eq!(find(&conn, f(|f| f.font_categories = vec!["gothic".into()])), s(&["d"]));
    assert_eq!(set_font_category(&conn, &s(&["d", "zz"]), Some("mincho")).unwrap(), 1, "unknown ids are skipped");
    assert!(find(&conn, f(|f| f.font_categories = vec!["gothic".into()])).is_empty());
    assert_eq!(find(&conn, f(|f| f.font_categories = vec!["mincho".into()])), s(&["d"]));
    let c = counts(&conn).unwrap();
    assert_eq!(
        (c.font_scripts, c.font_categories),
        (
            BTreeMap::from([("ja".to_string(), 1), ("latin".to_string(), 3)]),
            BTreeMap::from([("mincho".to_string(), 1), ("none".to_string(), 3)])
        )
    );
    set_font_category(&conn, &s(&["d"]), None).unwrap();
    conn.execute("UPDATE items SET font_category = NULL WHERE id = 'd'", []).unwrap();
    assert_eq!(find(&conn, f(|f| f.font_categories = vec!["none".into()])).len(), 4, "unknown style");

    // Weight ranges: a variable font spanning 300-700 is light, regular and bold at once;
    // a font without a range has its one weight.
    conn.execute("DELETE FROM items WHERE id != 'd'", []).unwrap();
    conn.execute(
        "UPDATE items SET font_weight = 400, font_weight_min = 300, font_weight_max = 700, font_features = 'mono,coding' WHERE id = 'd'",
        [],
    )
    .unwrap();
    assert_eq!(find(&conn, f(|f| f.font_weights = vec!["light".into()])), s(&["d"]));
    assert_eq!(find(&conn, f(|f| f.font_weights = vec!["bold".into()])), s(&["d"]));
    assert!(find(&conn, f(|f| f.font_weights = vec!["black".into()])).is_empty());
    assert!(find(&conn, f(|f| f.font_weights = vec!["nope".into()])).is_empty());
    assert_eq!(find(&conn, f(|f| f.font_features = vec!["coding".into()])), s(&["d"]));
    assert_eq!(find(&conn, f(|f| f.font_features = vec!["italic".into(), "mono".into()])), s(&["d"]), "any of");
    assert!(find(&conn, f(|f| f.font_features = vec!["italic".into()])).is_empty());
    assert!(find(&conn, f(|f| f.font_features = vec!["mon".into()])).is_empty(), "whole words");
    let c = counts(&conn).unwrap();
    assert_eq!(c.font_weights, BTreeMap::from([("light".to_string(), 1), ("regular".to_string(), 1), ("bold".to_string(), 1)]));
    assert_eq!(c.font_features, BTreeMap::from([("mono".to_string(), 1), ("coding".to_string(), 1)]));
    let mut query = q(View::All);
    query.filter = f(|f| f.font_features = vec!["mono".into()]);
    assert_eq!(query_items(&conn, &query).unwrap()[0].font_features, vec!["mono", "coding"]);
    conn.execute("UPDATE items SET font_weight_min = NULL, font_weight_max = NULL WHERE id = 'd'", []).unwrap();
    assert_eq!(counts(&conn).unwrap().font_weights, BTreeMap::from([("regular".to_string(), 1)]));
}

#[test]
fn file_types_are_counted_in_lower_case() {
    let mut conn = mem();
    for (id, ext) in [("a", "OTF"), ("b", "otf"), ("c", "ttf")] {
        add(&mut conn, id, id, 1);
        conn.execute("UPDATE items SET ext = ?2 WHERE id = ?1", [id, ext]).unwrap();
    }
    assert_eq!(list_exts(&conn).unwrap(), vec![("otf".to_string(), 2), ("ttf".to_string(), 1)]);
}

#[test]
fn fonts_not_read_yet_are_found_and_left_out_of_the_counts() {
    let mut conn = mem();
    add(&mut conn, "f", "f.ttf", 1);
    assert!(missing_font_meta(&conn).unwrap().is_empty());
    conn.execute("UPDATE items SET font_script = NULL", []).unwrap();
    assert_eq!(missing_font_meta(&conn).unwrap(), [("f".to_string(), "f.ttf".to_string(), "ttf".to_string())]);
    assert!(counts(&conn).unwrap().font_scripts.is_empty());
    set_font_meta(&mut conn, &[("f".into(), meta("F-Regular"))]).unwrap();
    assert!(missing_font_meta(&conn).unwrap().is_empty());
}

#[test]
fn postscript_names_tell_the_library_fonts() {
    let mut conn = mem();
    for (id, at) in [("f1", 1), ("f2", 2), ("f3", 3)] {
        add(&mut conn, id, id, at);
    }
    let metas = [("f1".into(), meta("F-Regular")), ("f2".into(), meta("F-Bold")), ("f3".into(), meta(""))];
    set_font_meta(&mut conn, &metas).unwrap();
    let item = get_items(&conn, &s(&["f1", "f3"])).unwrap();
    assert_eq!(item.iter().find(|i| i.id == "f1").unwrap().font_ps_name.as_deref(), Some("F-Regular"));
    assert_eq!(item.iter().find(|i| i.id == "f3").unwrap().font_ps_name, None, "none is no name");
    // Not the trash's, and no empty names.
    trash_items(&conn, &s(&["f2"])).unwrap();
    assert_eq!(font_ps_names(&conn).unwrap(), s(&["F-Regular"]));
}

#[test]
fn tags_are_places_and_facets_count_with_the_other_conditions() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.otf", 2);
    add(&mut conn, "c", "c.ttf", 3);
    conn.execute("UPDATE items SET ext = 'otf' WHERE id = 'b'", []).unwrap();
    conn.execute("UPDATE items SET font_script = 'ja' WHERE id = 'a'", []).unwrap();
    set_rating(&conn, &s(&["a"]), 5).unwrap();
    set_rating(&conn, &s(&["b"]), 3).unwrap();
    add_tags(&mut conn, &s(&["a", "b"]), &s(&["x"])).unwrap();
    add_tags(&mut conn, &s(&["b", "c"]), &s(&["y"])).unwrap();
    let (x, y) = (tag_id(&conn, "x"), tag_id(&conn, "y"));

    // A tag as a place.
    let mut tag = q(View::Tag { id: x });
    assert_eq!(ids(query_items(&conn, &tag).unwrap()), ["a", "b"]);
    let f = facet_counts(&conn, &tag).unwrap();
    assert_eq!(f.ratings, BTreeMap::from([(5, 1), (3, 1)]));
    assert_eq!(f.tags, BTreeMap::from([(x, 2), (y, 1)]));
    assert_eq!(f.exts, [("otf".to_string(), 1), ("ttf".to_string(), 1)]);
    assert_eq!(f.font_scripts, BTreeMap::from([("ja".to_string(), 1), ("latin".to_string(), 1)]));
    assert_eq!(f.font_weights, BTreeMap::from([("regular".to_string(), 2)]));

    // Another condition narrows the counts.
    tag.filter.exts = vec!["ttf".into()];
    let f = facet_counts(&conn, &tag).unwrap();
    assert_eq!((f.ratings, f.tags), (BTreeMap::from([(5, 1)]), BTreeMap::from([(x, 1)])));
}

#[test]
fn smart_folders() {
    let mut conn = mem();
    add(&mut conn, "a", "sans.ttf", 1);
    add(&mut conn, "b", "serif.ttf", 2);
    add(&mut conn, "c", "sans2.ttf", 3);
    set_rating(&conn, &s(&["a", "b"]), 4).unwrap();
    add_tags(&mut conn, &s(&["a", "c"]), &s(&["ui"])).unwrap();
    let ui = list_tags(&conn).unwrap()[0].id;

    let rule = Rule { min_rating: 3, ..Default::default() };
    let id = create_smart_folder(&conn, "Good", &rule).unwrap();
    let list = list_smart_folders(&conn).unwrap();
    assert_eq!((list[0].name.as_str(), list[0].count), ("Good", 2));
    assert_eq!(list[0].rule, rule);

    // The smart rule is combined with the ad-hoc search.
    let mut query = q(View::Smart { id: id.clone() });
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a", "b"]));
    query.search = "sans".into();
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["a"]));

    let rule = Rule { tag_ids: vec![ui], search: "sans".into(), ..Default::default() };
    update_smart_folder(&conn, &id, Some("UI"), Some(&rule)).unwrap();
    assert_eq!(list_smart_folders(&conn).unwrap()[0].count, 2);
    // Trashed items don't count.
    trash_items(&conn, &s(&["c"])).unwrap();
    assert_eq!(list_smart_folders(&conn).unwrap()[0].count, 1);
    // Merged into another tag: the rule follows it.
    add_tags(&mut conn, &s(&["b"]), &s(&["screen"])).unwrap();
    rename_tag(&mut conn, ui, "screen").unwrap();
    let screen = list_tags(&conn).unwrap()[0].id;
    assert_ne!(screen, ui);
    let sf = &list_smart_folders(&conn).unwrap()[0];
    assert_eq!((sf.rule.tag_ids.as_slice(), sf.count), (&[screen][..], 1));
    // A deleted tag drops out of the rule instead of matching nothing.
    delete_tag(&conn, screen).unwrap();
    let sf = &list_smart_folders(&conn).unwrap()[0];
    assert!(sf.rule.tag_ids.is_empty());
    assert_eq!(sf.count, 1); // just "sans" now (c is trashed)

    delete_smart_folder(&conn, &id).unwrap();
    assert!(list_smart_folders(&conn).unwrap().is_empty());
    let query = q(View::Smart { id });
    assert!(query_items(&conn, &query).unwrap().is_empty(), "deleted smart folder shows nothing");
}

#[test]
fn folder_order() {
    let mut conn = mem();
    let names = |conn: &Connection, parent: Option<&str>| -> Vec<String> {
        list_folders(conn)
            .unwrap()
            .into_iter()
            .filter(|f| f.parent_id.as_deref() == parent)
            .map(|f| f.name)
            .collect()
    };
    let b = create_folder(&conn, "B", None).unwrap();
    let a = create_folder(&conn, "A", None).unwrap();
    let c = create_folder(&conn, "C", None).unwrap();
    assert_eq!(names(&conn, None), ["B", "A", "C"], "new folders go last");

    shift_folder(&mut conn, &c, -1).unwrap();
    assert_eq!(names(&conn, None), ["B", "C", "A"]);
    shift_folder(&mut conn, &a, i32::MIN).unwrap();
    assert_eq!(names(&conn, None), ["A", "B", "C"]);
    shift_folder(&mut conn, &a, i32::MAX).unwrap();
    assert_eq!(names(&conn, None), ["B", "C", "A"]);

    assert!(place_folder(&mut conn, &a, None, Some(&b)).unwrap());
    assert_eq!(names(&conn, None), ["A", "B", "C"]);
    // Into another folder, in front of an existing child.
    let x = create_folder(&conn, "X", Some(&b)).unwrap();
    assert!(place_folder(&mut conn, &c, Some(&b), Some(&x)).unwrap());
    assert_eq!(names(&conn, Some(&b)), ["C", "X"]);
    assert!(!place_folder(&mut conn, &b, Some(&x), None).unwrap(), "no cycles");
    assert!(!place_folder(&mut conn, "gone", None, None).unwrap());

    place_folder(&mut conn, &x, Some(&b), Some(&c)).unwrap();
    assert_eq!(names(&conn, Some(&b)), ["X", "C"]);
    sort_folders_by_name(&mut conn, Some(&b)).unwrap();
    assert_eq!(names(&conn, Some(&b)), ["C", "X"]);
}

/// An older build that opens a newer library lowers `user_version` but keeps
/// what is there. Opening it with this build again must work and must not
/// reset anything the user arranged in the meantime.
#[test]
fn reopening_after_older_build_lowered_the_version() {
    let mut conn = mem();
    add(&mut conn, "a", "a.ttf", 1);
    add(&mut conn, "b", "b.ttf", 2);
    let f = create_folder(&conn, "Zeta", None).unwrap();
    create_folder(&conn, "Alpha", None).unwrap();
    move_to_folder(&conn, &s(&["a", "b"]), &f).unwrap();
    reorder_in_folder(&mut conn, &f, &s(&["b"]), Some("a")).unwrap(); // b before a
    create_smart_folder(&conn, "Saved", &Rule { min_rating: 2, ..Default::default() }).unwrap();
    set_rating(&conn, &s(&["a"]), 5).unwrap();

    conn.pragma_update(None, "user_version", 0).unwrap();
    migrate(&conn).unwrap();
    let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, SCHEMA_VERSION);

    let names: Vec<String> = list_folders(&conn).unwrap().into_iter().map(|x| x.name).collect();
    assert_eq!(names, ["Zeta", "Alpha"]);
    let mut query = q(View::Folder { id: f });
    query.sort = SortKey::Manual;
    assert_eq!(ids(query_items(&conn, &query).unwrap()), s(&["b", "a"]));
    assert_eq!(list_smart_folders(&conn).unwrap().len(), 1);
    assert_eq!(get_items(&conn, &s(&["a"])).unwrap()[0].rating, 5);
}

#[test]
fn never_lowers_a_newer_version() {
    let conn = mem();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5).unwrap();
    migrate(&conn).unwrap();
    let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, SCHEMA_VERSION + 5);
}

#[test]
fn failed_step_leaves_no_open_transaction() {
    // A broken library (a table of the same name made otherwise) makes step 1
    // fail; the connection must not be left inside the half-done transaction.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE item_tags (x TEXT); CREATE VIEW items AS SELECT 1 AS id;").unwrap();
    assert!(migrate(&conn).is_err());
    assert!(conn.is_autocommit(), "transaction was rolled back");
    let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 0, "version not bumped past the failed step");
    let folders: i64 =
        conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'folders'", [], |r| r.get(0)).unwrap();
    assert_eq!(folders, 0, "partial step undone");
}
