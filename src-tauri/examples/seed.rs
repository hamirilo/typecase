//! Fills a library with the fonts found in a folder (e.g. the OS's fonts).
//!   cargo run --release --example seed -- <path/to/X.library> <fonts folder>
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use typecase_lib::{db, import, library::Library};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("usage: seed <library> <fonts folder>"));
    let src = PathBuf::from(args.next().expect("usage: seed <library> <fonts folder>"));

    let lib = Mutex::new(Some(Library::create(&root).unwrap()));
    let t = Instant::now();
    let files = import::collect_files(std::slice::from_ref(&src));
    let sum = import::run(&lib, files, None, |_, _| {}).unwrap();
    println!("imported {} (dup {}, failed {}) in {:?}", sum.imported, sum.duplicates, sum.failed.len(), t.elapsed());

    let mut guard = lib.lock().unwrap();
    let l = guard.as_mut().unwrap();
    let all = db::query_items(&l.conn, &db::ItemQuery { desc: true, ..Default::default() }).unwrap();
    // A little structure so the sidebar has something to show.
    let ui = db::create_folder(&l.conn, "UI", None).unwrap();
    let body = db::create_folder(&l.conn, "本文", Some(&ui)).unwrap();
    db::create_folder(&l.conn, "見出し", None).unwrap();
    let ids: Vec<String> = all.iter().map(|i| i.id.clone()).collect();
    db::move_to_folder(&l.conn, &ids[..ids.len() / 4], &ui).unwrap();
    db::move_to_folder(&l.conn, &ids[..ids.len() / 8], &body).unwrap();
    db::add_tags(&mut l.conn, &ids[..ids.len() / 3], &["候補".into()]).unwrap();
    db::add_tags(&mut l.conn, &ids[ids.len() / 6..ids.len() / 2], &["案件A".into(), "ロゴ".into()]).unwrap();

    let t = Instant::now();
    let n = db::query_items(&l.conn, &db::ItemQuery { sort: db::SortKey::Name, ..Default::default() }).unwrap().len();
    println!("query of {n} items sorted by name took {:?}", t.elapsed());
}
