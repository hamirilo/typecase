//! Font files (TTF / OTF / WOFF / WOFF2 / TTC / OTC): unpacking to plain
//! OpenType data, names and character lists, and a rendered sample used as
//! the thumbnail. The original file is stored as is.

pub mod commands;
pub mod system;

use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use skrifa::raw::TableProvider;
use skrifa::string::StringId;
use skrifa::{FontRef, MetadataProvider};
use std::io::Read;

/// Thumbnail canvas (4:3).
pub const THUMB_W: u32 = 512;
pub const THUMB_H: u32 = 384;

fn be16(d: &[u8], at: usize) -> Result<u16, String> {
    d.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]])).ok_or_else(|| "フォントが壊れています".into())
}

fn be32(d: &[u8], at: usize) -> Result<u32, String> {
    d.get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| "フォントが壊れています".into())
}

/// The file as plain OpenType / TrueType data (a collection stays a collection).
pub fn to_sfnt(data: &[u8], ext: &str) -> Result<Vec<u8>, String> {
    match ext {
        "woff" => decode_woff(data),
        "woff2" => {
            check_woff2(data)?;
            woff2_patched::convert_woff2_to_ttf(&mut &data[..]).map_err(|e| format!("WOFF2: {e}"))
        }
        _ => Ok(data.to_vec()),
    }
}

/// Upper bound for a font unpacked from WOFF / WOFF2. The sizes in their
/// headers come from the file: without a limit, a small crafted file makes
/// the app reserve gigabytes (or inflate a compression bomb) and abort. The
/// largest real fonts (CJK collections) are around 100 MB.
const MAX_SFNT: u64 = 256 << 20;
/// Real fonts have a few dozen tables; `build_sfnt`'s header fields overflow
/// past 4095.
const MAX_TABLES: usize = 1024;
const TOO_BIG: &str = "フォントが大きすぎます";

/// WOFF 1.0: each table is zlib-compressed unless that wouldn't make it smaller.
fn decode_woff(d: &[u8]) -> Result<Vec<u8>, String> {
    if d.get(..4) != Some(b"wOFF") {
        return Err("WOFF ではありません".into());
    }
    let flavor = be32(d, 4)?;
    let n = be16(d, 12)? as usize;
    if n > MAX_TABLES {
        return Err("WOFF が壊れています".into());
    }
    let mut tables = Vec::with_capacity(n);
    let mut total = 0u64;
    for i in 0..n {
        let e = 44 + i * 20;
        let tag: [u8; 4] = d.get(e..e + 4).ok_or("WOFF が壊れています")?.try_into().unwrap();
        let (off, comp, orig) = (be32(d, e + 4)? as usize, be32(d, e + 8)? as usize, be32(d, e + 12)? as usize);
        let raw = d.get(off..off.saturating_add(comp)).ok_or("WOFF が壊れています")?;
        total += orig as u64;
        if total > MAX_SFNT {
            return Err(TOO_BIG.into());
        }
        let table = if comp < orig {
            let mut out = Vec::with_capacity(orig);
            flate2::read::ZlibDecoder::new(raw)
                .take(orig as u64)
                .read_to_end(&mut out)
                .map_err(|e| format!("WOFF: {e}"))?;
            out
        } else {
            raw.to_vec()
        };
        tables.push((tag, table));
    }
    Ok(build_sfnt(flavor, tables))
}

/// woff2-patched reserves the sizes the WOFF2 header declares and inflates
/// the Brotli stream without a limit, then slices it by the table lengths
/// (a panic, so an abort, when it is shorter). Checks those sizes, and what
/// the stream really inflates to, before handing the file over.
fn check_woff2(d: &[u8]) -> Result<(), String> {
    let bad = || "WOFF2 が壊れています".to_string();
    if d.get(..4) != Some(b"wOF2") {
        return Err("WOFF2 ではありません".into());
    }
    if be32(d, 16)? as u64 > MAX_SFNT {
        return Err(TOO_BIG.into());
    }
    let n = be16(d, 12)? as usize;
    if n > MAX_TABLES {
        return Err(bad());
    }
    // Table directory (https://www.w3.org/TR/WOFF2/#table_dir_format).
    let mut at = 48;
    let mut total = 0u64;
    for _ in 0..n {
        let flags = *d.get(at).ok_or_else(bad)?;
        at += 1;
        let tag = flags & 0x3f;
        if tag == 63 {
            at += 4;
        }
        let orig = base128(d, &mut at).ok_or_else(bad)?;
        // glyf (10) and loca (11) are transformed at version 0, the others at any other.
        let version = flags >> 6;
        let transformed = if matches!(tag, 10 | 11) { version == 0 } else { version != 0 };
        total += if transformed { base128(d, &mut at).ok_or_else(bad)? } else { orig } as u64;
    }
    if total > MAX_SFNT {
        return Err(TOO_BIG.into());
    }
    // Collection directory.
    if be32(d, 4)? == u32::from_be_bytes(*b"ttcf") {
        at += 4;
        for _ in 0..u255(d, &mut at).ok_or_else(bad)? {
            let tables = u255(d, &mut at).ok_or_else(bad)?;
            at += 4;
            for _ in 0..tables {
                u255(d, &mut at).ok_or_else(bad)?;
            }
        }
    }
    let stream = d.get(at..).ok_or_else(bad)?;
    let inflated = std::io::copy(&mut brotli::Decompressor::new(stream, 4096).take(total + 1), &mut std::io::sink())
        .map_err(|e| format!("WOFF2: {e}"))?;
    if inflated != total {
        return Err(bad());
    }
    Ok(())
}

/// WOFF2's UIntBase128: up to 5 bytes, 7 bits each, no leading zeros.
fn base128(d: &[u8], at: &mut usize) -> Option<u32> {
    let mut v = 0u32;
    for i in 0..5 {
        let b = *d.get(*at)?;
        *at += 1;
        if (i == 0 && b == 0x80) || v & 0xfe00_0000 != 0 {
            return None;
        }
        v = (v << 7) | (b & 0x7f) as u32;
        if b & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// WOFF2's 255UInt16.
fn u255(d: &[u8], at: &mut usize) -> Option<u16> {
    let b = *d.get(*at)?;
    *at += 1;
    Some(match b {
        253 => {
            let v = u16::from_be_bytes([*d.get(*at)?, *d.get(*at + 1)?]);
            *at += 2;
            v
        }
        254 | 255 => {
            let v = *d.get(*at)? as u16;
            *at += 1;
            v + if b == 255 { 253 } else { 506 }
        }
        b => b as u16,
    })
}

fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |sum, c| {
        let mut w = [0u8; 4];
        w[..c.len()].copy_from_slice(c);
        sum.wrapping_add(u32::from_be_bytes(w))
    })
}

/// Writes a single-font OpenType file from its tables.
fn build_sfnt(flavor: u32, mut tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    tables.sort_by_key(|(tag, _)| *tag);
    let n = tables.len() as u16;
    let pow = if n == 0 { 0 } else { 15 - n.leading_zeros() as u16 }; // floor(log2 n)
    let search = (1u16 << pow) * 16;
    let mut out = Vec::new();
    out.extend(flavor.to_be_bytes());
    out.extend(n.to_be_bytes());
    out.extend(search.to_be_bytes());
    out.extend(pow.to_be_bytes());
    out.extend((n * 16 - search).to_be_bytes());
    let mut offset = 12 + 16 * tables.len();
    for (tag, data) in &tables {
        out.extend(tag);
        out.extend(checksum(data).to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, data) in &tables {
        out.extend(data);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    out
}

fn is_collection(sfnt: &[u8]) -> bool {
    sfnt.get(..4) == Some(b"ttcf")
}

pub fn face_count(sfnt: &[u8]) -> Result<u32, String> {
    if is_collection(sfnt) { be32(sfnt, 8) } else { Ok(1) }
}

/// One font of a collection as a standalone file (what the web view can
/// load); a single font is returned as is.
pub fn extract_face(sfnt: &[u8], index: u32) -> Result<Vec<u8>, String> {
    if !is_collection(sfnt) {
        return Ok(sfnt.to_vec());
    }
    if index >= face_count(sfnt)? {
        return Err("フォントが見つかりません".into());
    }
    let base = be32(sfnt, 12 + 4 * index as usize)? as usize;
    let flavor = be32(sfnt, base)?;
    let n = be16(sfnt, base + 4)? as usize;
    let mut tables = Vec::with_capacity(n);
    for i in 0..n {
        let r = base + 12 + i * 16;
        let tag: [u8; 4] = sfnt.get(r..r + 4).ok_or("フォントが壊れています")?.try_into().unwrap();
        let (off, len) = (be32(sfnt, r + 8)? as usize, be32(sfnt, r + 12)? as usize);
        tables.push((tag, sfnt.get(off..off + len).ok_or("フォントが壊れています")?.to_vec()));
    }
    Ok(build_sfnt(flavor, tables))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceInfo {
    pub family: String,
    /// e.g. "Regular", "Bold Italic", "W3".
    pub style: String,
    pub full_name: String,
    pub weight: f32,
    pub italic: bool,
    pub glyphs: u16,
    /// Characters (code points) the face maps, not counting spaces / controls.
    pub char_count: usize,
    /// e.g. "Version 2.004".
    pub version: String,
    /// Designer, else the foundry.
    pub designer: String,
    /// Variation axes; empty unless it is a variable font.
    pub axes: Vec<AxisInfo>,
    /// Named styles of a variable font ("Thin", "Bold", ...).
    pub instances: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisInfo {
    /// e.g. "wght", "wdth", "ital".
    pub tag: String,
    pub name: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub faces: Vec<FaceInfo>,
    /// Every character of the requested face (code points), in order.
    pub chars: Vec<u32>,
}

/// A name, Japanese if the font has one, else English, else whatever is
/// there. Entries that can't be decoded (old Mac encodings) come out empty
/// and are skipped.
fn name(font: &FontRef, ids: &[StringId]) -> String {
    for &id in ids {
        let all: Vec<(Option<String>, String)> = font
            .localized_strings(id)
            .map(|s| (s.language().map(str::to_string), s.to_string().trim().to_string()))
            .filter(|(_, s)| !s.is_empty())
            .collect();
        let pick = |lang: &str| all.iter().find(|(l, _)| l.as_deref().is_some_and(|l| l.starts_with(lang)));
        if let Some((_, s)) = pick("ja").or_else(|| pick("en")).or(all.first()) {
            return s.clone();
        }
    }
    String::new()
}

fn face_ref(sfnt: &[u8], index: u32) -> Result<FontRef<'_>, String> {
    FontRef::from_index(sfnt, index).map_err(|e| format!("フォントを読めません: {e}"))
}

/// The characters a face maps (code points, sorted), without spaces and controls.
fn chars(font: &FontRef) -> Vec<u32> {
    let mut chars: Vec<u32> = font
        .charmap()
        .mappings()
        .map(|(c, _)| c)
        .filter(|&c| char::from_u32(c).is_some_and(|ch| !ch.is_control() && !ch.is_whitespace()))
        .collect();
    chars.sort_unstable();
    chars.dedup();
    chars
}

fn face_info(font: &FontRef) -> FaceInfo {
    let attrs = font.attributes();
    FaceInfo {
        family: name(font, &[StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME]),
        style: name(font, &[StringId::TYPOGRAPHIC_SUBFAMILY_NAME, StringId::SUBFAMILY_NAME]),
        full_name: name(font, &[StringId::FULL_NAME, StringId::FAMILY_NAME]),
        weight: attrs.weight.value(),
        italic: attrs.style != skrifa::attribute::Style::Normal,
        glyphs: font.maxp().map(|m| m.num_glyphs()).unwrap_or(0),
        char_count: chars(font).len(),
        version: name(font, &[StringId::VERSION_STRING]),
        designer: name(font, &[StringId::DESIGNER, StringId::MANUFACTURER]),
        axes: font
            .axes()
            .iter()
            .map(|a| AxisInfo {
                tag: a.tag().to_string(),
                name: name(font, &[a.name_id()]),
                min: a.min_value(),
                default: a.default_value(),
                max: a.max_value(),
            })
            .collect(),
        instances: font
            .named_instances()
            .iter()
            .map(|i| name(font, &[i.subfamily_name_id()]))
            .filter(|n| !n.is_empty())
            .collect(),
    }
}

/// Names and details of every face in the file.
pub fn faces(sfnt: &[u8]) -> Result<Vec<FaceInfo>, String> {
    (0..face_count(sfnt)?).map(|i| face_ref(sfnt, i).map(|f| face_info(&f))).collect()
}

/// What the library stores about a font (from its first face) to group and
/// filter fonts: see `meta`.
#[derive(Debug, Clone, PartialEq)]
pub struct FontMeta {
    /// Family shared by its styles (e.g. "Noto Sans JP" for Light / Bold).
    pub family: String,
    /// 100 (thin) to 900 (black).
    pub weight: u32,
    /// The weights the font covers: the `wght` axis of a variable font, else
    /// `weight` twice. The sidebar's 太さ counts a variable font under every
    /// range it spans.
    pub weight_min: u32,
    pub weight_max: u32,
    /// Writing system: see `SCRIPTS`.
    pub script: &'static str,
    /// Typeface style (明朝 / ゴシック ...), None when it can't be told: see `CATEGORIES`.
    pub category: Option<&'static str>,
    /// Traits a font has any number of, in `FEATURES` order: see `features`.
    pub features: Vec<&'static str>,
    /// Variation axes of a variable font, in `AXES` order (empty when it isn't one): see `axes`.
    pub axes: Vec<&'static str>,
    /// PostScript name ("" when the font has none): what tells the same font
    /// in the library and installed on this computer (docs/SYSTEM_FONTS.md).
    pub ps_name: String,
}

impl FontMeta {
    /// The features as stored in the DB ("mono,coding"; "" = none).
    pub fn features_text(&self) -> String {
        self.features.join(",")
    }

    /// The axes as stored in the DB ("wght,wdth"; "" = none, so a font read is told from one not read).
    pub fn axes_text(&self) -> String {
        self.axes.join(",")
    }
}

/// Writing systems a font is filed under: 日本語, 欧文, 中国語, 韓国語, その他.
pub const SCRIPTS: &[&str] = &["ja", "latin", "zh", "ko", "other"];
/// Typeface styles: 明朝・セリフ, ゴシック・サンセリフ, 丸ゴシック, スラブセリフ,
/// 筆書体, 手書き, デザイン. Monospace is a feature, not a style (a monospaced
/// font is still a gothic or a mincho).
pub const CATEGORIES: &[&str] = &["mincho", "gothic", "maru", "slab", "brush", "hand", "display"];
/// Features: 等幅, プログラミング向け, 可変フォント, イタリック・斜体, カラーフォント.
pub const FEATURES: &[&str] = &["mono", "coding", "variable", "italic", "color"];
/// Variation axes a filter can pick: 太さ, 幅, 光学サイズ, イタリック, 斜体の角度, and
/// "other" for any other (a font's own, like a decorative one).
pub const AXES: &[&str] = &["wght", "wdth", "opsz", "ital", "slnt", "other"];

pub fn meta(sfnt: &[u8]) -> Result<FontMeta, String> {
    let font = face_ref(sfnt, 0)?;
    // Some fonts leave the weight class 0: regular, as far as anyone can tell.
    let weight = match font.attributes().weight.value().round() as u32 {
        0 => 400,
        w => w,
    };
    let wght = font.axes().iter().find(|a| a.tag() == skrifa::raw::types::Tag::new(b"wght"));
    let (weight_min, weight_max) = match wght {
        Some(a) => (a.min_value().round() as u32, a.max_value().round() as u32),
        None => (weight, weight),
    };
    Ok(FontMeta {
        family: base_family(&font),
        weight,
        weight_min,
        weight_max,
        script: script(&font),
        category: category(&font),
        features: features(&font),
        axes: axes(&font),
        ps_name: name(&font, &[StringId::POSTSCRIPT_NAME]),
    })
}

/// The family, without the style words some fonts put in it ("MOBO-Bold",
/// "ぼくたちのゴシック２ボールド") so their styles still group together. Free
/// fonts do this even in the typographic family name.
fn base_family(font: &FontRef) -> String {
    let family = strip_style(&name(font, &[StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME]));
    let style = name(font, &[StringId::TYPOGRAPHIC_SUBFAMILY_NAME, StringId::SUBFAMILY_NAME]);
    with_width(&family, &style)
}

/// Width words in the order they are looked for (longer first), as spelled in a style name.
const WIDTH_WORDS: &[&str] = &[
    "UltraCondensed", "ExtraCondensed", "SemiCondensed", "Condensed", "Compressed", "Narrow",
    "SemiExpanded", "ExtraExpanded", "UltraExpanded", "Expanded", "Extended", "Wide",
];

/// Adds the width of a style ("Compressed Thin" → "Compressed") to the family, so
/// widths that look nothing alike (ヒカリ角ゴ Compressed / Extended) are families
/// of their own. The normal width, and a family that already names it, stay as they are.
pub fn with_width(family: &str, style: &str) -> String {
    let squeezed: String = style.chars().filter(|c| !matches!(c, ' ' | '-' | '_')).collect();
    let lower_family = family.to_ascii_lowercase();
    match WIDTH_WORDS.iter().find(|w| squeezed.to_ascii_lowercase().contains(&w.to_ascii_lowercase())) {
        Some(w) if !lower_family.contains(&w.to_ascii_lowercase()) => format!("{family} {w}"),
        _ => family.to_string(),
    }
}

const STYLE_WORDS: &[&str] = &[
    "ExtraLight", "UltraLight", "ExtraBold", "UltraBold", "SemiBold", "DemiBold", "Hairline", "Regular",
    "Medium", "Normal", "Italic", "Oblique", "Light", "Black", "Heavy", "Thin", "Bold", "Book",
];

/// Japanese spellings, taken off even without a separator.
const STYLE_WORDS_JA: &[&str] = &[
    "エクストラライト", "ウルトラライト", "エクストラボールド", "セミボールド", "デミボールド", "レギュラー",
    "ミディアム", "ボールド", "ライト", "ヘビー", "ブラック",
];

/// Takes style words off the end of a family name: "MOBO-Bold" → "MOBO",
/// "Noto Sans JP Light" → "Noto Sans JP", "ヒラギノ角ゴ ProN W3" → "ヒラギノ角ゴ ProN",
/// "BokutachinoGothic2Regular" → "BokutachinoGothic2". A name that is only
/// style words is kept.
pub fn strip_style(family: &str) -> String {
    let mut out = family.trim().to_string();
    loop {
        let before = out.len();
        // "Extra Light" and the like, spelled with a space.
        let squeezed: Vec<&str> = out.rsplitn(3, |c: char| c == ' ' || c == '-' || c == '_').collect();
        if squeezed.len() == 3 {
            let pair = format!("{}{}", squeezed[1], squeezed[0]);
            if STYLE_WORDS.iter().any(|w| w.eq_ignore_ascii_case(&pair)) && !squeezed[2].is_empty() {
                out = squeezed[2].trim_end_matches([' ', '-', '_']).to_string();
                continue;
            }
        }
        for w in STYLE_WORDS {
            let Some(head) = out.len().checked_sub(w.len()).and_then(|i| out.get(..i)) else { continue };
            let tail = &out[head.len()..];
            let after_separator = head.ends_with([' ', '-', '_']) && tail.eq_ignore_ascii_case(w);
            // Glued on: "Gothic2Bold" (capitalised word after a lower-case letter or digit).
            let camel = tail == *w && head.chars().last().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            if after_separator || camel {
                out = head.trim_end_matches([' ', '-', '_']).to_string();
                break;
            }
        }
        if out.len() == before {
            if let Some(w) = STYLE_WORDS_JA.iter().find(|w| out.ends_with(*w) && out.len() > w.len()) {
                out = out[..out.len() - w.len()].trim_end_matches([' ', '-', '_', '　']).to_string();
            }
        }
        // Japanese weights: W0 - W9.
        if let Some(head) = out.strip_suffix(|c: char| c.is_ascii_digit()).and_then(|h| h.strip_suffix(['W', 'w'])) {
            if head.ends_with([' ', '-', '_']) {
                out = head.trim_end_matches([' ', '-', '_']).to_string();
            }
        }
        if out.len() == before {
            break;
        }
    }
    if out.is_empty() { family.trim().to_string() } else { out }
}

/// Whether the font has kana (a Japanese font, whatever else it covers).
fn has_kana(font: &FontRef) -> bool {
    let cmap = font.charmap();
    (0x3041..=0x30ff).filter(|&c| char::from_u32(c).is_some_and(|ch| cmap.map(ch).is_some())).count() >= 40
}

/// The writing system the font is made for, from the characters it has and
/// the code pages it claims (fonts for one CJK language often carry the
/// others' kana or hanzi too).
fn script(font: &FontRef) -> &'static str {
    let cmap = font.charmap();
    let count = |from: u32, to: u32| (from..=to).filter(|&c| char::from_u32(c).is_some_and(|ch| cmap.map(ch).is_some())).count();
    let kana = count(0x3041, 0x30ff);
    let hangul = count(0xac00, 0xd7a3);
    let hanzi = count(0x4e00, 0x9fff);
    let pages = font.os2().ok().and_then(|t| t.ul_code_page_range_1()).unwrap_or(0);
    let (jis, chinese) = (pages & (1 << 17) != 0, pages & (1 << 18 | 1 << 20) != 0);
    // Some display faces have capitals only.
    let latin = ('A'..='Z').all(|c| cmap.map(c).is_some());
    if hangul >= 1000 && !jis {
        "ko"
    } else if kana >= 40 && (jis || !chinese) {
        "ja"
    } else if hanzi >= 2000 {
        "zh"
    } else if kana >= 40 {
        "ja"
    } else if latin {
        "latin"
    } else {
        "other"
    }
}

/// Every name of the font (all languages) as lower-case words, splitting
/// "BokutachinoGothic2" into "bokutachino", "gothic", "2".
fn name_words(font: &FontRef) -> (String, Vec<String>) {
    let ids = [StringId::FAMILY_NAME, StringId::FULL_NAME, StringId::POSTSCRIPT_NAME, StringId::TYPOGRAPHIC_FAMILY_NAME];
    let all: String = ids.iter().flat_map(|&id| font.localized_strings(id).map(|s| s.to_string() + " ")).collect();
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut prev: Option<char> = None;
    for c in all.chars() {
        let boundary = !c.is_alphanumeric()
            || prev.is_some_and(|p| (p.is_lowercase() && c.is_uppercase()) || (p.is_ascii_digit() != c.is_ascii_digit()));
        if boundary && !cur.is_empty() {
            words.push(std::mem::take(&mut cur).to_lowercase());
        }
        if c.is_alphanumeric() {
            cur.push(c);
        }
        prev = Some(c);
    }
    if !cur.is_empty() {
        words.push(cur.to_lowercase());
    }
    (all.to_lowercase(), words)
}

/// 明朝 / ゴシック / ... from the name first (Japanese fonts, free fonts in
/// particular, rarely fill in the classification fields), then the font's
/// own classification (OS/2 family class and PANOSE).
fn category(font: &FontRef) -> Option<&'static str> {
    let (text, words) = name_words(font);
    let word = |ws: &[&str]| words.iter().any(|w| ws.contains(&w.as_str()));
    let has = |ss: &[&str]| ss.iter().any(|s| text.contains(s));
    if word(&["maru", "rounded", "round"]) || has(&["丸ゴ", "まる", "ラウンド"]) {
        return Some("maru");
    }
    if word(&["slab", "egyptian", "egyptienne", "clarendon"]) || has(&["スラブ"]) {
        return Some("slab");
    }
    // Brush and formal scripts (calligraphy) before casual handwriting: a
    // "hand-brushed" font is a brush one.
    if word(&["kaisho", "gyosho", "sosho", "reisho", "kyokasho", "fude", "brush", "script", "calligraphy", "calligraphic"])
        || has(&["筆", "楷書", "行書", "草書", "隷書", "教科書", "書道"])
    {
        return Some("brush");
    }
    if word(&["hand", "handwriting", "handwritten", "handwrite", "pen", "marker", "crayon", "chalk", "comic", "tegaki"])
        || has(&["手書", "手描", "てがき", "ペン字", "鉛筆", "クレヨン", "マーカー", "チョーク"])
    {
        return Some("hand");
    }
    if word(&["mincho", "serif", "song", "ming", "antiqua"]) && !word(&["sans"]) || has(&["明朝", "宋"]) {
        return Some("mincho");
    }
    if word(&["gothic", "sans", "kakugo", "grotesk", "grotesque"]) || has(&["ゴシック", "角ゴ", "ゴチ"]) {
        return Some("gothic");
    }
    if word(&["pop", "display"]) || has(&["ポップ", "ぽっぷ"]) {
        return Some("display");
    }

    let (panose, class) = font
        .os2()
        .map(|t| (t.panose_10().to_vec(), (t.s_family_class() >> 8) as u8))
        .unwrap_or_default();
    let (family_kind, serif) = (panose.first().copied(), panose.get(1).copied());
    match (family_kind, class) {
        (_, 10) => return Some("brush"),
        // Hand-written, by tool: flat nib, pressure point, engraved and
        // brushes are calligraphy; ball pens, rough and felt tips are handwriting.
        (Some(3), _) => return Some(if matches!(serif, Some(2..=4 | 6 | 9)) { "brush" } else { "hand" }),
        (Some(4 | 5), _) | (_, 12) => return Some("display"),
        (_, 5) => return Some("slab"),
        _ => {}
    }
    // Fonts that leave the family class empty (most free Japanese fonts) tend
    // to carry leftover PANOSE serif values too: not trusted then, except
    // for fonts without kana (Latin coding fonts fill in PANOSE alone).
    if class == 0 && (family_kind != Some(2) || has_kana(font)) {
        return None;
    }
    if family_kind == Some(2) && serif == Some(15) {
        return Some("maru");
    }
    match class {
        1..=4 | 7 => Some("mincho"),
        8 => Some("gothic"),
        _ => match (family_kind, serif) {
            (Some(2), Some(2..=10)) => Some("mincho"),
            (Some(2), Some(11..=13)) => Some("gothic"),
            _ => None,
        },
    }
}

/// Advance width of `c` in font units, if the font has it.
fn advance(font: &FontRef, c: char) -> Option<u16> {
    let gid = font.charmap().map(c)?;
    font.hmtx().ok()?.advance(gid)
}

/// Monospaced: the font says so (post / PANOSE), or its Latin letters are
/// all as wide as each other. Japanese coding fonts (half-width Latin,
/// full-width kana) rarely set the flag, so the widths are measured too.
fn is_mono(font: &FontRef) -> bool {
    if font.post().is_ok_and(|p| p.is_fixed_pitch() != 0) {
        return true;
    }
    let panose = font.os2().map(|t| t.panose_10().to_vec()).unwrap_or_default();
    if panose.first() == Some(&2) && panose.get(3) == Some(&9) {
        return true;
    }
    let widths: Option<Vec<u16>> = "iMWa.1".chars().map(|c| advance(font, c)).collect();
    widths.is_some_and(|w| w[0] > 0 && w.iter().all(|&x| x == w[0]))
}

const CODING_WORDS: &[&str] = &[
    "code", "coding", "hack", "jetbrains", "cascadia", "consolas", "menlo", "monaco", "inconsolata", "ricty", "plemol",
    "udev", "moralerspace", "sarasa", "cica", "myrica", "bizin", "firge", "iosevka", "monaspace", "commit", "victor",
    "terminal", "console",
];

/// Features: 等幅 (`mono`), プログラミング向け (`coding`: a monospaced font
/// named as one, with the half-to-full width ratio of Japanese coding fonts,
/// or with a slashed / dotted zero on offer), 可変 (`variable`), 斜体 (`italic`).
fn features(font: &FontRef) -> Vec<&'static str> {
    let mut out = Vec::new();
    let mono = is_mono(font);
    if mono {
        out.push("mono");
        let (_, words) = name_words(font);
        let named = words.iter().any(|w| CODING_WORDS.contains(&w.as_str()));
        let half_full = matches!((advance(font, 'a'), advance(font, 'あ')), (Some(h), Some(f)) if h > 0 && f == h * 2);
        let zero = font.gsub().ok().and_then(|g| g.feature_list().ok()).is_some_and(|l| {
            l.feature_records().iter().any(|r| r.feature_tag() == skrifa::raw::types::Tag::new(b"zero"))
        });
        if named || half_full || zero {
            out.push("coding");
        }
    }
    if !font.axes().is_empty() {
        out.push("variable");
    }
    if font.attributes().style != skrifa::attribute::Style::Normal {
        out.push("italic");
    }
    if is_color(font) {
        out.push("color");
    }
    out
}

/// Colour glyphs: COLR (vector, v0 / v1), SVG, or bitmaps in colour (CBDT, sbix).
fn is_color(font: &FontRef) -> bool {
    use skrifa::raw::types::Tag;
    [b"COLR", b"SVG ", b"CBDT", b"sbix"].iter().any(|t| font.data_for_tag(Tag::new(t)).is_some())
}

/// The variation axes of a variable font, in `AXES` order.
fn axes(font: &FontRef) -> Vec<&'static str> {
    let tags: Vec<[u8; 4]> = font.axes().iter().map(|a| a.tag().to_be_bytes()).collect();
    AXES.iter()
        .filter(|k| match **k {
            "other" => tags.iter().any(|t| !AXES[..5].iter().any(|k| k.as_bytes() == t)),
            k => tags.iter().any(|t| k.as_bytes() == t),
        })
        .copied()
        .collect()
}

/// Every face, and the characters of face `index`.
pub fn info(sfnt: &[u8], index: u32) -> Result<FontInfo, String> {
    Ok(FontInfo { faces: faces(sfnt)?, chars: chars(&face_ref(sfnt, index)?) })
}

/// Sample lines for the thumbnail: "Aa" and Japanese / Latin text, using
/// whatever the font actually covers.
fn sample_lines(font: &FontRef) -> (String, String) {
    let cmap = font.charmap();
    let has = |s: &str| s.chars().all(|c| cmap.map(c).is_some());
    let big = if has("Aa") {
        "Aa".to_string()
    } else {
        cmap.mappings()
            .filter_map(|(c, _)| char::from_u32(c))
            .filter(|c| !c.is_whitespace() && !c.is_control())
            .take(2)
            .collect()
    };
    let small = ["あア永", "ABC abc 123", "Abg 123"]
        .into_iter()
        .find(|s| has(&s.replace(' ', "")))
        .map(str::to_string)
        .unwrap_or_default();
    (big, small)
}

/// A line of sample text for the list layout: the first candidate the font
/// fully covers, else whatever characters it has.
pub fn list_sample(sfnt: &[u8]) -> Result<String, String> {
    const CANDIDATES: &[&str] = &[
        "永遠の青い空 いろは アイウ Aa 123",
        "いろはにほへと アイウエオ Aa 123",
        "The quick brown fox jumps over 0123",
        "ABC abc 123",
    ];
    let font = face_ref(sfnt, 0)?;
    let cmap = font.charmap();
    let covered = |s: &str| s.chars().filter(|c| !c.is_whitespace()).all(|c| cmap.map(c).is_some());
    if let Some(s) = CANDIDATES.iter().find(|s| covered(s)) {
        return Ok(s.to_string());
    }
    Ok(chars(&font).into_iter().filter_map(char::from_u32).take(24).collect())
}

/// What the list layout shows for a font: a sample line and the style of the
/// first font in the file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPreview {
    pub sample: String,
    pub style: String,
    /// Fonts in the file (several for TTC / OTC).
    pub faces: u32,
}

pub fn list_preview(sfnt: &[u8]) -> Result<ListPreview, String> {
    let font = face_ref(sfnt, 0)?;
    Ok(ListPreview {
        sample: list_sample(sfnt)?,
        style: name(&font, &[StringId::TYPOGRAPHIC_SUBFAMILY_NAME, StringId::SUBFAMILY_NAME]),
        faces: face_count(sfnt)?,
    })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The thumbnail: a sample of the first face, dark on light.
pub fn render_thumb(sfnt: &[u8]) -> Result<DynamicImage, String> {
    let font = face_ref(sfnt, 0)?;
    let face = face_info(&font);
    let (big, small) = sample_lines(&font);
    let style = if face.italic { "italic" } else { "normal" };
    let family = xml_escape(&face.family);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{THUMB_W}" height="{THUMB_H}">
<rect width="100%" height="100%" fill="#f4f4f5"/>
<g font-family="{family}" font-weight="{w}" font-style="{style}" fill="#18181b" text-anchor="middle">
<text x="256" y="215" font-size="170">{big}</text>
<text x="256" y="320" font-size="52">{small}</text>
</g></svg>"##,
        w = face.weight.round(),
        big = xml_escape(&big),
        small = xml_escape(&small),
    );
    let mut opt = resvg::usvg::Options::default();
    opt.font_family = face.family.clone();
    opt.fontdb_mut().load_font_data(sfnt.to_vec());
    let tree = resvg::usvg::Tree::from_str(&svg, &opt).map_err(|e| format!("フォント: {e}"))?;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(THUMB_W, THUMB_H).ok_or("フォント: 描画エラー")?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let rgba = RgbaImage::from_raw(THUMB_W, THUMB_H, pixmap.take_demultiplied()).ok_or("フォント: 描画エラー")?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;

    /// A font installed with the OS, if there is one at any of `paths`.
    pub fn system_font(paths: &[&str]) -> Option<Vec<u8>> {
        paths.iter().find_map(|p| std::fs::read(p).ok())
    }

    pub const SINGLE: &[&str] = &[
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Geneva.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    /// Another single font than `SINGLE`'s.
    pub const OTHER: &[&str] = &[
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "C:\\Windows\\Fonts\\georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    ];
    pub const VARIABLE: &[&str] = &[
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Skia.ttf",
        "C:\\Windows\\Fonts\\bahnschrift.ttf",
    ];
    pub const COLLECTION: &[&str] = &[
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:\\Windows\\Fonts\\msgothic.ttc",
        "C:\\Windows\\Fonts\\cambria.ttc",
    ];

    /// Packs a single font as WOFF 1.0 (the inverse of `decode_woff`).
    pub fn encode_woff(sfnt: &[u8]) -> Vec<u8> {
        let n = be16(sfnt, 4).unwrap() as usize;
        let mut dir = Vec::new();
        let mut body = Vec::new();
        let start = 44 + 20 * n;
        for i in 0..n {
            let r = 12 + i * 16;
            let (off, len) = (be32(sfnt, r + 8).unwrap() as usize, be32(sfnt, r + 12).unwrap() as usize);
            let table = &sfnt[off..off + len];
            let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            z.write_all(table).unwrap();
            let z = z.finish().unwrap();
            let stored = if z.len() < len { z } else { table.to_vec() };
            dir.extend(&sfnt[r..r + 4]);
            dir.extend(((start + body.len()) as u32).to_be_bytes());
            dir.extend((stored.len() as u32).to_be_bytes());
            dir.extend((len as u32).to_be_bytes());
            dir.extend(sfnt[r + 4..r + 8].to_vec());
            body.extend(&stored);
            body.resize(body.len().div_ceil(4) * 4, 0);
        }
        let mut out = b"wOFF".to_vec();
        out.extend(&sfnt[0..4]);
        out.extend(((start + body.len()) as u32).to_be_bytes());
        out.extend((n as u16).to_be_bytes());
        out.extend([0u8; 2]);
        out.extend((sfnt.len() as u32).to_be_bytes());
        out.extend([0u8; 24]);
        out.extend(dir);
        out.extend(body);
        out
    }

    /// Fraction of thumbnail pixels that are ink (darker than the background).
    pub fn ink(img: &DynamicImage) -> f32 {
        let g = img.to_luma8();
        g.pixels().filter(|p| p[0] < 128).count() as f32 / g.pixels().len() as f32
    }

    #[test]
    fn single_font_and_woff() {
        let Some(ttf) = system_font(SINGLE) else { return };
        let info = info(&ttf, 0).unwrap();
        assert_eq!(info.faces.len(), 1);
        assert!(!info.faces[0].family.is_empty());
        assert!(info.chars.contains(&('A' as u32)));
        assert!(info.faces[0].glyphs > 50);
        assert_eq!(info.faces[0].char_count, info.chars.len());
        let m = meta(&ttf).unwrap();
        assert_eq!((m.family.as_str(), m.weight), (info.faces[0].family.as_str(), info.faces[0].weight.round() as u32));
        assert_eq!(m.script, "latin");
        assert!(!info.faces[0].version.is_empty());

        let woff = encode_woff(&ttf);
        let back = to_sfnt(&woff, "woff").unwrap();
        // Rebuilt with sorted tables, so compare what the font contains.
        let again = super::info(&back, 0).unwrap();
        assert_eq!((again.faces[0].family.as_str(), again.chars.len()), (info.faces[0].family.as_str(), info.chars.len()));
        assert!(ink(&render_thumb(&back).unwrap()) > 0.02, "the sample is drawn");
        // A Latin font gets the Latin line, every character of it covered.
        let p = list_preview(&ttf).unwrap();
        assert_eq!((p.sample.as_str(), p.faces), ("The quick brown fox jumps over 0123", 1));
        assert!(!p.style.is_empty());
    }

    #[test]
    fn collections() {
        let Some(ttc) = system_font(COLLECTION) else { return };
        let n = face_count(&ttc).unwrap();
        assert!(n >= 2);
        let all = info(&ttc, 0).unwrap();
        assert_eq!(all.faces.len(), n as usize);
        let last = extract_face(&ttc, n - 1).unwrap();
        assert_eq!(face_count(&last).unwrap(), 1);
        assert_eq!(info(&last, 0).unwrap().faces[0].full_name, all.faces[n as usize - 1].full_name);
        assert!(extract_face(&ttc, n).is_err());
        assert!(ink(&render_thumb(&ttc).unwrap()) > 0.02);
        let p = list_preview(&ttc).unwrap();
        assert_eq!(p.faces, n);
        assert!(p.sample.chars().filter(|c| !c.is_whitespace()).count() >= 3);
    }

    #[test]
    fn variable_font() {
        let Some(ttf) = system_font(VARIABLE) else { return };
        let face = &faces(&ttf).unwrap()[0];
        let wght = face.axes.iter().find(|a| a.tag == "wght").expect("a weight axis");
        assert!(wght.min < wght.default && wght.default <= wght.max);
        let m = meta(&ttf).unwrap();
        assert!(m.features.contains(&"variable"));
        assert!(m.axes.contains(&"wght"), "axes: {:?}", m.axes);
        assert_eq!((m.weight_min, m.weight_max), (wght.min.round() as u32, wght.max.round() as u32));
        assert!(face.instances.len() >= 2, "named styles: {:?}", face.instances);
        // A plain font has neither.
        let Some(plain) = system_font(SINGLE) else { return };
        assert!(faces(&plain).unwrap()[0].axes.is_empty());
        assert!(meta(&plain).unwrap().axes.is_empty());
    }

    #[test]
    fn strips_style_words_from_families() {
        for (from, to) in [
            ("MOBO-Bold", "MOBO"),
            ("MOBO-ExtraLight", "MOBO"),
            ("BokutachinoGothic2Regular", "BokutachinoGothic2"),
            ("Noto Sans JP Light", "Noto Sans JP"),
            ("Noto Sans JP Extra Light", "Noto Sans JP"),
            ("ヒラギノ角ゴ ProN W3", "ヒラギノ角ゴ ProN"),
            ("Senobi Gothic", "Senobi Gothic"),
            ("Kobold", "Kobold"),
            ("Bold", "Bold"),
            ("Arial Black Italic", "Arial"),
            ("ぼくたちのゴシック２ボールド", "ぼくたちのゴシック２"),
            ("モボ-Bold", "モボ"),
            ("ボールド", "ボールド"),
        ] {
            assert_eq!(strip_style(from), to, "{from}");
        }
    }

    /// The OS's own fonts fill in their classification, so the guesses can be checked.
    #[test]
    fn widths_make_families() {
        for (family, style, to) in [
            ("ヒカリ角ゴ", "Compressed Thin", "ヒカリ角ゴ Compressed"),
            ("ヒカリ角ゴ", "Wide ExtraLight", "ヒカリ角ゴ Wide"),
            ("ヒカリ角ゴ", "Normal Thin", "ヒカリ角ゴ"),
            ("Roboto", "Semi Condensed Bold", "Roboto SemiCondensed"),
            ("Roboto Condensed", "Condensed Bold", "Roboto Condensed"),
            ("Noto Sans JP", "Bold", "Noto Sans JP"),
        ] {
            assert_eq!(with_width(family, style), to, "{family} {style}");
        }
    }

    #[test]
    fn tells_scripts_and_styles() {
        // (paths, script, style, monospaced)
        let cases: &[(&[&str], &str, Option<&str>, bool)] = &[
            (&["/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", "C:\\Windows\\Fonts\\yumin.ttf"], "ja", Some("mincho"), false),
            (&["/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"], "ja", Some("maru"), false),
            (&["/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "C:\\Windows\\Fonts\\msgothic.ttc"], "ja", Some("gothic"), false),
            (&["/System/Library/Fonts/Supplemental/Times New Roman.ttf", "C:\\Windows\\Fonts\\times.ttf"], "latin", Some("mincho"), false),
            (&["/System/Library/Fonts/Supplemental/Arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"], "latin", Some("gothic"), false),
            (&["/System/Library/Fonts/Supplemental/Courier New.ttf", "C:\\Windows\\Fonts\\cour.ttf"], "latin", Some("slab"), true),
            (&["/System/Library/Fonts/Menlo.ttc", "C:\\Windows\\Fonts\\consola.ttf"], "latin", Some("gothic"), true),
            (&["/System/Library/Fonts/Supplemental/Apple Chancery.ttf"], "latin", Some("brush"), false),
            (&["/System/Library/Fonts/AppleSDGothicNeo.ttc", "C:\\Windows\\Fonts\\malgun.ttf"], "ko", Some("gothic"), false),
        ];
        for (paths, script, category, mono) in cases {
            let Some(data) = system_font(paths) else { continue };
            let m = meta(&data).unwrap();
            assert_eq!((m.script, m.category, m.features.contains(&"mono")), (*script, *category, *mono), "{}", paths[0]);
            // A plain (not variable, upright) font spans its one weight.
            if !m.features.contains(&"variable") {
                assert_eq!((m.weight_min, m.weight_max), (m.weight, m.weight), "{}", paths[0]);
            }
        }
        // Menlo and Consolas are coding fonts by name; Courier is a typewriter face.
        for (paths, coding) in [
            (&["/System/Library/Fonts/Menlo.ttc", "C:\\Windows\\Fonts\\consola.ttf"][..], true),
            (&["/System/Library/Fonts/Supplemental/Courier New.ttf", "C:\\Windows\\Fonts\\cour.ttf"][..], false),
        ] {
            let Some(data) = system_font(paths) else { continue };
            assert_eq!(meta(&data).unwrap().features.contains(&"coding"), coding, "{}", paths[0]);
        }
    }


    #[test]
    fn rejects_garbage() {
        assert!(to_sfnt(b"nope", "woff").is_err());
        assert!(to_sfnt(b"nope", "woff2").is_err());
        assert!(render_thumb(b"not a font at all").is_err());
        assert!(extract_face(b"ttcf\0\0\0\0\0\0\0\x05", 0).is_err());
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        z.write_all(data).unwrap();
        z.finish().unwrap()
    }

    /// A WOFF with one table whose header claims `orig` bytes.
    fn woff_claiming(orig: u32, compressed: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; 64];
        d[..4].copy_from_slice(b"wOFF");
        d[4..8].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        d[12..14].copy_from_slice(&1u16.to_be_bytes());
        d[44..48].copy_from_slice(b"cmap");
        d[48..52].copy_from_slice(&64u32.to_be_bytes());
        d[52..56].copy_from_slice(&(compressed.len() as u32).to_be_bytes());
        d[56..60].copy_from_slice(&orig.to_be_bytes());
        d.extend(compressed);
        d
    }

    #[test]
    fn woff_sizes_are_limited() {
        // A 4 GB claim is refused before anything is reserved.
        let err = to_sfnt(&woff_claiming(u32::MAX, &zlib(b"")), "woff").unwrap_err();
        assert_eq!(err, TOO_BIG);
        // A table inflating past its claim (a bomb) stops at the claim.
        let sfnt = to_sfnt(&woff_claiming(1 << 20, &zlib(&vec![0u8; 64 << 20])), "woff").unwrap();
        assert!(sfnt.len() <= (1 << 20) + 64, "{}", sfnt.len());
    }

    /// A WOFF2 with one untransformed table of `declared` bytes, followed by
    /// `content` compressed with Brotli.
    fn woff2_declaring(declared: u32, content: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; 48];
        d[..4].copy_from_slice(b"wOF2");
        d[4..8].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        d[12..14].copy_from_slice(&1u16.to_be_bytes());
        d[16..20].copy_from_slice(&(declared + 28).to_be_bytes());
        d.push(0); // cmap, version 0: not transformed
        let mut v = declared;
        let mut bytes = vec![(v & 0x7f) as u8];
        v >>= 7;
        while v > 0 {
            bytes.push((v & 0x7f) as u8 | 0x80);
            v >>= 7;
        }
        d.extend(bytes.iter().rev());
        let mut compressed = Vec::new();
        {
            use std::io::Write;
            let mut w = brotli::CompressorWriter::new(&mut compressed, 4096, 11, 22);
            w.write_all(content).unwrap();
        }
        d.extend(compressed);
        d
    }

    #[test]
    fn woff2_sizes_are_checked() {
        assert!(check_woff2(&woff2_declaring(16, &[7; 16])).is_ok());
        // Inflating past the declared size (a bomb) or short of it (the
        // unpacker would slice past its end).
        assert!(check_woff2(&woff2_declaring(16, &vec![0; 8 << 20])).is_err());
        assert!(check_woff2(&woff2_declaring(16, &[7; 8])).is_err());
        assert_eq!(check_woff2(&woff2_declaring(0x0fff_ffff, b"")).unwrap_err(), TOO_BIG);
    }

    #[test]
    fn woff2_numbers() {
        let mut at = 0;
        assert_eq!(base128(&[0x3f], &mut at), Some(63));
        at = 0;
        assert_eq!(base128(&[0x81, 0x00], &mut at), Some(128));
        assert_eq!(at, 2);
        at = 0;
        assert_eq!(base128(&[0x80, 0x01], &mut at), None, "leading zero");
        at = 0;
        assert_eq!(base128(&[0xff; 6], &mut at), None, "overflow");
        for (bytes, v) in [(&[17][..], 17), (&[253, 1, 2][..], 258), (&[255, 0][..], 253), (&[254, 3][..], 509)] {
            at = 0;
            assert_eq!(u255(bytes, &mut at), Some(v));
            assert_eq!(at, bytes.len());
        }
    }
}
