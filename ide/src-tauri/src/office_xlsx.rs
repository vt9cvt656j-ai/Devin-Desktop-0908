//! Excel 新建：JSON 规格 → .xlsx（rust_xlsxwriter）。
//!
//! 为什么在 Rust 侧：JS 生态里没有能写原生图表 / 迷你图的开源 xlsx 库（exceljs 写不了），
//! 而 rust_xlsxwriter 覆盖 Excel 的全部写入特性——单元格与公式（含动态数组）、样式、合并、
//! 列宽行高、冻结、筛选、表格、条件格式（14 种）、数据验证、图表（20 余种）、图片、迷你图、
//! 批注、文本框、复选框、页面设置、页眉页脚、保护、分组、定义名称、文档属性。
//! 「改已有文件」和「读」留在 JS（exceljs），规格词汇两侧一致，见 src/agent/office-tool.js。
//!
//! 这一层只回结构化事实（路径 / 字节数 / 表名 / 警告清单），给模型看的话在 JS 拼。
use rust_xlsxwriter::*;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
pub struct XlsxWriteResult {
    pub path: String,
    pub bytes: usize,
    pub sheets: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct Built {
    pub bytes: Vec<u8>,
    pub sheets: Vec<String>,
    pub warnings: Vec<String>,
}

#[tauri::command(async)]
pub fn office_xlsx_write(root: String, dest: String, spec: Value) -> Result<XlsxWriteResult, String> {
    let target = resolve_dest(&root, &dest);
    let built = build_workbook(&spec, Path::new(&root))?;
    let resolved = crate::files::write_workspace_bytes(&target.to_string_lossy(), &built.bytes)?;
    Ok(XlsxWriteResult {
        path: resolved.to_string_lossy().into_owned(),
        bytes: built.bytes.len(),
        sheets: built.sheets,
        warnings: built.warnings,
    })
}

fn resolve_dest(root: &str, dest: &str) -> PathBuf {
    let d = Path::new(dest);
    if d.is_absolute() || dest.starts_with('~') {
        return d.to_path_buf();
    }
    Path::new(root).join(d)
}

// ── JSON 小工具 ──────────────────────────────────────────────────────────────

fn get<'a>(o: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    for k in keys {
        if let Some(v) = o.get(k) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}
fn str_of<'a>(o: &'a Value, keys: &[&str]) -> Option<&'a str> {
    get(o, keys).and_then(|v| v.as_str())
}
fn f64_of(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|t| parse_number(t)))
}
fn num_of(o: &Value, keys: &[&str]) -> Option<f64> {
    get(o, keys).and_then(f64_of)
}
fn bool_of(o: &Value, keys: &[&str]) -> Option<bool> {
    get(o, keys).and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" | "on" => Some(true),
            "false" | "no" | "0" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    })
}
fn arr_of<'a>(o: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    get(o, keys).and_then(|v| v.as_array())
}
fn obj_of<'a>(o: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    get(o, keys).and_then(|v| v.as_object())
}

/// "1,234.5" / "12%" / "¥3,000" / "$1.5" 这类带装饰的数字也认。
fn parse_number(t: &str) -> Option<f64> {
    let s = t.trim();
    if s.is_empty() {
        return None;
    }
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, ',' | '¥' | '$' | '€' | '£' | '%' | ' ' | '_'))
        .collect();
    let v: f64 = cleaned.parse().ok()?;
    Some(if s.ends_with('%') { v / 100.0 } else { v })
}

// ── 地址解析（用户面向 A1 / 1 起；库 0 起）──────────────────────────────────

/// "B3" → (row0, col0)。不认 "$B$3" 里的 $ 以外的杂字。
pub fn parse_cell(a1: &str) -> Option<(RowNum, ColNum)> {
    let s: String = a1.trim().chars().filter(|c| *c != '$').collect();
    let s = s.to_ascii_uppercase();
    let letters: String = s.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let digits: String = s.chars().skip(letters.len()).collect();
    if letters.is_empty() || letters.len() > 3 || digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let row: u64 = digits.parse().ok()?;
    if row == 0 || row > 1_048_576 {
        return None;
    }
    let col = utility::column_name_to_number(&letters);
    if col > 16_383 {
        return None;
    }
    Some(((row - 1) as RowNum, col))
}

/// "A1:C5" / "A1" / "Sheet 1!A1:C5" → (sheet?, r0, c0, r1, c1)。单个单元格＝首尾同格。
pub fn parse_range(r: &str) -> Option<(Option<String>, RowNum, ColNum, RowNum, ColNum)> {
    let (sheet, rest) = match r.trim().rsplit_once('!') {
        Some((s, tail)) => (Some(s.trim().trim_matches('\'').to_string()), tail),
        None => (None, r.trim()),
    };
    let (a, b) = match rest.split_once(':') {
        Some((a, b)) => (a, b),
        None => (rest, rest),
    };
    let (r0, c0) = parse_cell(a)?;
    let (r1, c1) = parse_cell(b)?;
    Some((sheet, r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
}

/// 列引用："C" / 3（1 起） → col0
fn parse_col(v: &Value) -> Option<ColNum> {
    match v {
        Value::Number(n) => {
            let i = n.as_i64()?;
            if i >= 1 && i <= 16_384 { Some((i - 1) as ColNum) } else { None }
        }
        Value::String(s) => {
            let t = s.trim().to_ascii_uppercase();
            if t.chars().all(|c| c.is_ascii_digit()) && !t.is_empty() {
                let i: i64 = t.parse().ok()?;
                if i >= 1 && i <= 16_384 { Some((i - 1) as ColNum) } else { None }
            } else if !t.is_empty() && t.len() <= 3 && t.chars().all(|c| c.is_ascii_alphabetic()) {
                Some(utility::column_name_to_number(&t))
            } else {
                None
            }
        }
        _ => None,
    }
}
/// 行引用：1 起 → row0
fn parse_row(v: &Value) -> Option<RowNum> {
    let i = match v {
        Value::Number(n) => n.as_i64()?,
        Value::String(s) => s.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    if i >= 1 && i <= 1_048_576 { Some((i - 1) as RowNum) } else { None }
}

// ── 颜色 / 数字格式 ──────────────────────────────────────────────────────────

fn color_of(v: &str) -> Option<Color> {
    let t = v.trim();
    let hex = t.trim_start_matches('#');
    if (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        // 8 位按 ARGB 读，丢掉 alpha
        let h = if hex.len() == 8 { &hex[2..] } else { hex };
        return u32::from_str_radix(h, 16).ok().map(Color::RGB);
    }
    if hex.len() == 3 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        let doubled: String = hex.chars().flat_map(|c| [c, c]).collect();
        return u32::from_str_radix(&doubled, 16).ok().map(Color::RGB);
    }
    Some(match t.to_ascii_lowercase().as_str() {
        "black" => Color::Black,
        "blue" => Color::Blue,
        "brown" => Color::Brown,
        "cyan" => Color::Cyan,
        "gray" | "grey" => Color::Gray,
        "green" => Color::Green,
        "lime" => Color::Lime,
        "magenta" => Color::Magenta,
        "navy" => Color::Navy,
        "orange" => Color::Orange,
        "pink" => Color::Pink,
        "purple" => Color::Purple,
        "red" => Color::Red,
        "silver" => Color::Silver,
        "white" => Color::White,
        "yellow" => Color::Yellow,
        _ => return None,
    })
}

/// 友好别名 → Excel 数字格式串；其余原样透传。
fn num_format_of(v: &str) -> String {
    match v.trim() {
        "percent" | "%" => "0.00%".into(),
        "percent0" => "0%".into(),
        "percent1" => "0.0%".into(),
        "int" | "integer" => "0".into(),
        "number" | "num" => "#,##0.00".into(),
        "number0" => "#,##0".into(),
        "number1" => "#,##0.0".into(),
        "decimal" | "0.00" => "0.00".into(),
        "currency" | "cny" | "rmb" | "yuan" => "¥#,##0.00".into(),
        "usd" | "dollar" => "$#,##0.00".into(),
        "eur" | "euro" => "€#,##0.00".into(),
        "accounting" => "_(* #,##0.00_);_(* (#,##0.00);_(* \"-\"??_);_(@_)".into(),
        "date" => "yyyy-mm-dd".into(),
        "date_cn" | "datecn" => "yyyy\"年\"m\"月\"d\"日\"".into(),
        "datetime" => "yyyy-mm-dd hh:mm".into(),
        "datetime_s" | "datetimes" => "yyyy-mm-dd hh:mm:ss".into(),
        "time" => "hh:mm".into(),
        "time_s" | "times" => "hh:mm:ss".into(),
        "month" => "yyyy-mm".into(),
        "text" | "string" | "@" => "@".into(),
        "scientific" => "0.00E+00".into(),
        "fraction" => "# ?/?".into(),
        "thousands" => "#,##0,\"K\"".into(),
        "millions" => "#,##0.0,,\"M\"".into(),
        other => other.to_string(),
    }
}

fn align_h(v: &str) -> Option<FormatAlign> {
    Some(match v.trim().to_ascii_lowercase().as_str() {
        "left" | "start" => FormatAlign::Left,
        "center" | "centre" | "middle" => FormatAlign::Center,
        "right" | "end" => FormatAlign::Right,
        "fill" => FormatAlign::Fill,
        "justify" => FormatAlign::Justify,
        "centeracross" | "center_across" | "across" => FormatAlign::CenterAcross,
        "distributed" => FormatAlign::Distributed,
        "general" => FormatAlign::General,
        _ => return None,
    })
}
fn align_v(v: &str) -> Option<FormatAlign> {
    Some(match v.trim().to_ascii_lowercase().as_str() {
        "top" => FormatAlign::Top,
        "middle" | "center" | "centre" | "vcenter" => FormatAlign::VerticalCenter,
        "bottom" => FormatAlign::Bottom,
        "justify" | "vjustify" => FormatAlign::VerticalJustify,
        "distributed" | "vdistributed" => FormatAlign::VerticalDistributed,
        _ => return None,
    })
}
fn border_of(v: &str) -> Option<FormatBorder> {
    Some(match v.trim().to_ascii_lowercase().replace(['_', '-'], "").as_str() {
        "thin" | "true" | "1" => FormatBorder::Thin,
        "medium" => FormatBorder::Medium,
        "thick" => FormatBorder::Thick,
        "dashed" | "dash" => FormatBorder::Dashed,
        "dotted" | "dot" => FormatBorder::Dotted,
        "double" => FormatBorder::Double,
        "hair" | "hairline" => FormatBorder::Hair,
        "mediumdashed" => FormatBorder::MediumDashed,
        "dashdot" => FormatBorder::DashDot,
        "mediumdashdot" => FormatBorder::MediumDashDot,
        "dashdotdot" => FormatBorder::DashDotDot,
        "mediumdashdotdot" => FormatBorder::MediumDashDotDot,
        "slantdashdot" => FormatBorder::SlantDashDot,
        "none" | "false" | "0" => FormatBorder::None,
        _ => return None,
    })
}

// ── 样式：规格对象（或命名样式）→ Format ──────────────────────────────────────

pub struct Ctx<'a> {
    named: HashMap<String, Value>,
    base: Format,
    root: &'a Path,
    pub warnings: Vec<String>,
    data_ws: Option<Worksheet>,
    data_next_col: ColNum,
}

const STYLE_KEYS: &[&str] = &[
    "bold", "italic", "underline", "strike", "size", "fontSize", "font", "fontName", "color", "fontColor",
    "fill", "bg", "background", "pattern", "align", "halign", "valign", "wrap", "indent", "rotation",
    "shrink", "border", "borderColor", "borderTop", "borderBottom", "borderLeft", "borderRight",
    "numFmt", "format", "locked", "hidden", "superscript", "subscript", "quotePrefix", "style",
];

fn has_style_keys(o: &Map<String, Value>) -> bool {
    STYLE_KEYS.iter().any(|k| o.get(*k).map(|v| !v.is_null()).unwrap_or(false))
}

fn apply_style_keys(mut f: Format, o: &Map<String, Value>, ctx: &mut Ctx) -> Format {
    let v = Value::Object(o.clone());
    if let Some(b) = bool_of(&v, &["bold"]) { f = if b { f.set_bold() } else { f.unset_bold() }; }
    if let Some(b) = bool_of(&v, &["italic"]) { f = if b { f.set_italic() } else { f.unset_italic() }; }
    if let Some(u) = get(&v, &["underline"]) {
        f = match u {
            Value::Bool(true) => f.set_underline(FormatUnderline::Single),
            Value::Bool(false) => f.set_underline(FormatUnderline::None),
            Value::String(s) => f.set_underline(match s.to_ascii_lowercase().as_str() {
                "double" => FormatUnderline::Double,
                "singleaccounting" | "single_accounting" => FormatUnderline::SingleAccounting,
                "doubleaccounting" | "double_accounting" => FormatUnderline::DoubleAccounting,
                "none" => FormatUnderline::None,
                _ => FormatUnderline::Single,
            }),
            _ => f,
        };
    }
    if bool_of(&v, &["strike", "strikethrough"]) == Some(true) { f = f.set_font_strikethrough(); }
    if let Some(n) = num_of(&v, &["size", "fontSize"]) { if n > 0.0 { f = f.set_font_size(n); } }
    if let Some(name) = str_of(&v, &["font", "fontName"]) { f = f.set_font_name(name); }
    if let Some(c) = str_of(&v, &["color", "fontColor"]) {
        match color_of(c) { Some(col) => f = f.set_font_color(col), None => ctx.warnings.push(format!("颜色不认识：{c}")) }
    }
    if let Some(fill) = get(&v, &["fill", "bg", "background"]) {
        let (col, pat) = match fill {
            Value::String(s) => (Some(s.as_str()), None),
            Value::Object(fo) => (fo.get("color").and_then(|x| x.as_str()), fo.get("pattern").and_then(|x| x.as_str())),
            _ => (None, None),
        };
        if let Some(c) = col {
            match color_of(c) {
                Some(cc) => {
                    f = f.set_background_color(cc);
                    if let Some(p) = pat.or_else(|| str_of(&v, &["pattern"])) {
                        f = f.set_pattern(match p.to_ascii_lowercase().as_str() {
                            "solid" => FormatPattern::Solid,
                            "mediumgray" | "gray50" => FormatPattern::MediumGray,
                            "darkgray" | "gray75" => FormatPattern::DarkGray,
                            "lightgray" | "gray25" => FormatPattern::LightGray,
                            "gray125" => FormatPattern::Gray125,
                            "gray0625" => FormatPattern::Gray0625,
                            "darkhorizontal" => FormatPattern::DarkHorizontal,
                            "darkvertical" => FormatPattern::DarkVertical,
                            "darkgrid" => FormatPattern::DarkGrid,
                            "lightgrid" => FormatPattern::LightGrid,
                            "darkdown" => FormatPattern::DarkDown,
                            "darkup" => FormatPattern::DarkUp,
                            "darktrellis" => FormatPattern::DarkTrellis,
                            "lighthorizontal" => FormatPattern::LightHorizontal,
                            "lightvertical" => FormatPattern::LightVertical,
                            "lightdown" => FormatPattern::LightDown,
                            "lightup" => FormatPattern::LightUp,
                            "lighttrellis" => FormatPattern::LightTrellis,
                            _ => FormatPattern::Solid,
                        });
                    }
                }
                None => ctx.warnings.push(format!("填充色不认识：{c}")),
            }
        }
    }
    // 对齐：align 可以是 "center" 或 {h, v, wrap, indent, rotation, shrink}
    match get(&v, &["align", "halign"]) {
        Some(Value::String(s)) => { if let Some(a) = align_h(s) { f = f.set_align(a); } }
        Some(Value::Object(ao)) => {
            let av = Value::Object(ao.clone());
            if let Some(h) = str_of(&av, &["h", "horizontal"]) { if let Some(a) = align_h(h) { f = f.set_align(a); } }
            if let Some(vv) = str_of(&av, &["v", "vertical"]) { if let Some(a) = align_v(vv) { f = f.set_align(a); } }
            if bool_of(&av, &["wrap", "wrapText"]) == Some(true) { f = f.set_text_wrap(); }
            if let Some(i) = num_of(&av, &["indent"]) { f = f.set_indent(i.clamp(0.0, 255.0) as u8); }
            if let Some(r) = num_of(&av, &["rotation", "textRotation"]) { f = f.set_rotation(r.clamp(-90.0, 270.0) as i16); }
            if bool_of(&av, &["shrink", "shrinkToFit"]) == Some(true) { f = f.set_shrink(); }
        }
        _ => {}
    }
    if let Some(vv) = str_of(&v, &["valign"]) { if let Some(a) = align_v(vv) { f = f.set_align(a); } }
    if bool_of(&v, &["wrap", "wrapText"]) == Some(true) { f = f.set_text_wrap(); }
    if let Some(i) = num_of(&v, &["indent"]) { f = f.set_indent(i.clamp(0.0, 255.0) as u8); }
    if let Some(r) = num_of(&v, &["rotation"]) { f = f.set_rotation(r.clamp(-90.0, 270.0) as i16); }
    if bool_of(&v, &["shrink"]) == Some(true) { f = f.set_shrink(); }
    // 边框：true / "thin" / {all|top|bottom|left|right: "thin"|{style,color}, color}
    let border_color = str_of(&v, &["borderColor"]).and_then(color_of);
    let side = |f: Format, which: &str, spec: &Value, ctx: &mut Ctx| -> Format {
        let (style, col) = match spec {
            Value::Bool(true) => (Some(FormatBorder::Thin), None),
            Value::Bool(false) => (Some(FormatBorder::None), None),
            Value::String(s) => (border_of(s), None),
            Value::Object(so) => (
                so.get("style").and_then(|x| x.as_str()).and_then(border_of).or(Some(FormatBorder::Thin)),
                so.get("color").and_then(|x| x.as_str()).and_then(color_of),
            ),
            _ => (None, None),
        };
        let Some(style) = style else { ctx.warnings.push(format!("边框样式不认识：{spec}")); return f; };
        let col = col.or(border_color);
        let mut f = f;
        match which {
            "top" => { f = f.set_border_top(style); if let Some(c) = col { f = f.set_border_top_color(c); } }
            "bottom" => { f = f.set_border_bottom(style); if let Some(c) = col { f = f.set_border_bottom_color(c); } }
            "left" => { f = f.set_border_left(style); if let Some(c) = col { f = f.set_border_left_color(c); } }
            "right" => { f = f.set_border_right(style); if let Some(c) = col { f = f.set_border_right_color(c); } }
            _ => { f = f.set_border(style); if let Some(c) = col { f = f.set_border_color(c); } }
        }
        f
    };
    match get(&v, &["border"]) {
        Some(Value::Object(bo)) => {
            if let Some(all) = bo.get("all") { f = side(f, "all", all, ctx); }
            for k in ["top", "bottom", "left", "right"] {
                if let Some(sv) = bo.get(k) { f = side(f, k, sv, ctx); }
            }
        }
        Some(spec) => f = side(f, "all", spec, ctx),
        None => {}
    }
    for k in ["borderTop", "borderBottom", "borderLeft", "borderRight"] {
        if let Some(sv) = get(&v, &[k]) { f = side(f, &k[6..].to_ascii_lowercase(), sv, ctx); }
    }
    if let Some(nf) = str_of(&v, &["numFmt", "format"]) { f = f.set_num_format(num_format_of(nf)); }
    if bool_of(&v, &["locked"]) == Some(false) { f = f.set_unlocked(); }
    if bool_of(&v, &["hidden"]) == Some(true) { f = f.set_hidden(); }
    if bool_of(&v, &["superscript"]) == Some(true) { f = f.set_font_script(FormatScript::Superscript); }
    if bool_of(&v, &["subscript"]) == Some(true) { f = f.set_font_script(FormatScript::Subscript); }
    if bool_of(&v, &["quotePrefix"]) == Some(true) { f = f.set_quote_prefix(); }
    f
}

/// 规格 → Format：先 base（工作簿默认字体），再 `style`（命名样式名或对象），再本层内联键。
fn format_of(spec: &Value, ctx: &mut Ctx) -> Format {
    let mut f = ctx.base.clone();
    match spec.get("style") {
        Some(Value::String(name)) => match ctx.named.get(name).cloned() {
            Some(Value::Object(o)) => f = apply_style_keys(f, &o, ctx),
            _ => ctx.warnings.push(format!("没有名为 {name} 的样式（styles 里定义）")),
        },
        Some(Value::Object(o)) => { let o = o.clone(); f = apply_style_keys(f, &o, ctx); }
        _ => {}
    }
    if let Value::Object(o) = spec {
        if has_style_keys(o) {
            let mut inline = o.clone();
            inline.remove("style");
            f = apply_style_keys(f, &inline, ctx);
        }
    }
    f
}

/// 只有当规格真的带样式信息时才返回 Format（避免给每个格子都挂空格式）。
fn maybe_format(spec: &Value, ctx: &mut Ctx) -> Option<Format> {
    let styled = match spec {
        Value::Object(o) => has_style_keys(o),
        Value::String(_) => false,
        _ => false,
    };
    if styled { Some(format_of(spec, ctx)) } else { None }
}

// ── 单元格 ──────────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct ColDef {
    key: Option<String>,
    kind: Option<String>,   // date / datetime / time / number / percent / currency / string / bool
    format: Option<Format>,
    has_num_fmt: bool,
}

const DYNAMIC_FNS: &[&str] = &[
    "FILTER(", "UNIQUE(", "SORT(", "SORTBY(", "SEQUENCE(", "RANDARRAY(", "XLOOKUP(", "XMATCH(",
    "LET(", "LAMBDA(", "TEXTSPLIT(", "VSTACK(", "HSTACK(", "TOCOL(", "TOROW(", "BYROW(", "BYCOL(",
    "MAP(", "SCAN(", "REDUCE(", "MAKEARRAY(", "CHOOSECOLS(", "CHOOSEROWS(", "TAKE(", "DROP(",
    "EXPAND(", "WRAPROWS(", "WRAPCOLS(", "ANCHORARRAY(", "GROUPBY(", "PIVOTBY(",
];
fn is_dynamic_formula(f: &str) -> bool {
    let up = f.to_ascii_uppercase();
    DYNAMIC_FNS.iter().any(|n| up.contains(n))
}

fn xerr<T>(r: Result<T, XlsxError>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn write_formula_at(ws: &mut Worksheet, row: RowNum, col: ColNum, f: &str, result: Option<&str>, array: Option<&str>, dynamic: Option<bool>, fmt: Option<&Format>) -> Result<(), String> {
    let mut formula = Formula::new(f);
    if let Some(r) = result { formula = formula.set_result(r); }
    let dynamic = dynamic.unwrap_or_else(|| is_dynamic_formula(f));
    if let Some(range) = array {
        let (_, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("array 范围不合法：{range}"))?;
        return xerr(match (dynamic, fmt) {
            (true, Some(m)) => ws.write_dynamic_array_formula_with_format(r0, c0, r1, c1, formula, m),
            (true, None) => ws.write_dynamic_array_formula(r0, c0, r1, c1, formula),
            (false, Some(m)) => ws.write_array_formula_with_format(r0, c0, r1, c1, formula, m),
            (false, None) => ws.write_array_formula(r0, c0, r1, c1, formula),
        }).map(|_| ());
    }
    xerr(match (dynamic, fmt) {
        (true, Some(m)) => ws.write_dynamic_formula_with_format(row, col, formula, m),
        (true, None) => ws.write_dynamic_formula(row, col, formula),
        (false, Some(m)) => ws.write_formula_with_format(row, col, formula, m),
        (false, None) => ws.write_formula(row, col, formula),
    }).map(|_| ())
}

fn write_datetime_at(ws: &mut Worksheet, row: RowNum, col: ColNum, text: &str, fmt: Option<Format>, has_num_fmt: bool, kind: &str) -> Result<(), String> {
    let dt = ExcelDateTime::parse_from_str(text.trim()).map_err(|e| format!("日期 {text} 解析失败: {e}"))?;
    let default_fmt = match kind {
        "time" => "hh:mm",
        "datetime" => "yyyy-mm-dd hh:mm",
        _ => if text.contains(':') { "yyyy-mm-dd hh:mm" } else { "yyyy-mm-dd" },
    };
    let fmt = fmt.unwrap_or_else(Format::new);
    let fmt = if has_num_fmt { fmt } else { fmt.set_num_format(default_fmt) };
    xerr(ws.write_datetime_with_format(row, col, &dt, &fmt)).map(|_| ())
}

/// 写一个格子。`v` 可以是标量、"=公式"、"'文本" 或对象 {v/f/t/style/link/note/rich/array...}。
fn write_cell(ws: &mut Worksheet, row: RowNum, col: ColNum, v: &Value, coldef: Option<&ColDef>, ctx: &mut Ctx) -> Result<(), String> {
    let kind_of_col = coldef.and_then(|c| c.kind.clone());
    let has_num_fmt = coldef.map(|c| c.has_num_fmt).unwrap_or(false)
        || matches!(v, Value::Object(o) if o.get("numFmt").map(|x| !x.is_null()).unwrap_or(false) || o.get("format").map(|x| !x.is_null()).unwrap_or(false));
    // 格式：列默认格式 + 单元格自己的样式（单元格覆盖列）
    let own = maybe_format(v, ctx);
    let fmt: Option<Format> = match (coldef.and_then(|c| c.format.clone()), own) {
        (Some(cf), Some(own)) => {
            // 合并：把单元格样式键叠在列格式上
            let mut merged = cf;
            if let Value::Object(o) = v {
                let mut inline = o.clone();
                if let Some(Value::String(name)) = o.get("style") {
                    if let Some(Value::Object(named)) = ctx.named.get(name).cloned() { merged = apply_style_keys(merged, &named, ctx); }
                } else if let Some(Value::Object(so)) = o.get("style") {
                    let so = so.clone();
                    merged = apply_style_keys(merged, &so, ctx);
                }
                inline.remove("style");
                merged = apply_style_keys(merged, &inline, ctx);
            }
            let _ = own;
            Some(merged)
        }
        (Some(cf), None) => Some(cf),
        (None, own) => own,
    };
    match v {
        Value::Null => {
            if let Some(m) = &fmt { xerr(ws.write_blank(row, col, m))?; }
            Ok(())
        }
        Value::Bool(b) => xerr(match &fmt { Some(m) => ws.write_boolean_with_format(row, col, *b, m), None => ws.write_boolean(row, col, *b) }).map(|_| ()),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(0.0);
            xerr(match &fmt { Some(m) => ws.write_number_with_format(row, col, x, m), None => ws.write_number(row, col, x) }).map(|_| ())
        }
        Value::String(s) => write_string_value(ws, row, col, s, kind_of_col.as_deref(), fmt, has_num_fmt, ctx),
        Value::Array(items) => {
            let joined = items.iter().map(|x| match x { Value::String(s) => s.clone(), other => other.to_string() }).collect::<Vec<_>>().join(", ");
            xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, &joined, m), None => ws.write_string(row, col, &joined) }).map(|_| ())
        }
        Value::Object(o) => {
            let ov = Value::Object(o.clone());
            let kind = str_of(&ov, &["t", "type"]).map(|s| s.to_ascii_lowercase()).or(kind_of_col);
            let formula = str_of(&ov, &["f", "formula"]);
            let result = get(&ov, &["result", "cached"]).map(|r| match r { Value::String(s) => s.clone(), other => other.to_string() });
            let link = str_of(&ov, &["link", "url", "hyperlink"]);
            let note = str_of(&ov, &["note", "comment"]);
            let rich = arr_of(&ov, &["rich", "richText", "runs"]);
            let value = get(&ov, &["v", "value", "text"]);
            if let Some(f) = formula {
                // 有公式又带 v：v 当缓存结果（没算过的查看器也能显示）
                let cached = result.or_else(|| value.map(|x| match x { Value::String(s) => s.clone(), other => other.to_string() }));
                write_formula_at(ws, row, col, f, cached.as_deref(), str_of(&ov, &["array", "range"]), bool_of(&ov, &["dynamic"]), fmt.as_ref())?;
            } else if let Some(runs) = rich {
                let mut parts: Vec<(Format, String)> = Vec::new();
                for r in runs {
                    match r {
                        Value::String(s) => parts.push((ctx.base.clone(), s.clone())),
                        Value::Object(ro) => {
                            let rv = Value::Object(ro.clone());
                            let text = str_of(&rv, &["text", "t", "v"]).unwrap_or("").to_string();
                            let mut inline = ro.clone();
                            inline.remove("text"); inline.remove("t"); inline.remove("v");
                            let rf = apply_style_keys(ctx.base.clone(), &inline, ctx);
                            parts.push((rf, text));
                        }
                        other => parts.push((ctx.base.clone(), other.to_string())),
                    }
                }
                let refs: Vec<(&Format, &str)> = parts.iter().filter(|(_, t)| !t.is_empty()).map(|(f, t)| (f, t.as_str())).collect();
                if refs.is_empty() {
                    if let Some(m) = &fmt { xerr(ws.write_blank(row, col, m))?; }
                } else {
                    xerr(match &fmt { Some(m) => ws.write_rich_string_with_format(row, col, &refs, m), None => ws.write_rich_string(row, col, &refs) })?;
                }
            } else if let Some(l) = link {
                let text = value.map(|x| match x { Value::String(s) => s.clone(), other => other.to_string() });
                let mut url = Url::new(l);
                if let Some(t) = &text { url = url.set_text(t); }
                if let Some(tip) = str_of(&ov, &["tip", "tooltip"]) { url = url.set_tip(tip); }
                xerr(match &fmt { Some(m) => ws.write_url_with_format(row, col, url, m), None => ws.write_url(row, col, url) })?;
            } else {
                match value {
                    None | Some(Value::Null) => { if let Some(m) = &fmt { xerr(ws.write_blank(row, col, m))?; } }
                    Some(Value::String(s)) => {
                        let k = kind.as_deref();
                        match k {
                            Some("date") | Some("datetime") | Some("time") => write_datetime_at(ws, row, col, s, fmt.clone(), has_num_fmt, k.unwrap())?,
                            Some("number") | Some("percent") | Some("currency") | Some("int") => match parse_number(s) {
                                Some(x) => { xerr(match &fmt { Some(m) => ws.write_number_with_format(row, col, x, m), None => ws.write_number(row, col, x) })?; }
                                None => { xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, s, m), None => ws.write_string(row, col, s) })?; }
                            },
                            Some("bool") | Some("boolean") => {
                                let b = matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "yes" | "1" | "是");
                                xerr(match &fmt { Some(m) => ws.write_boolean_with_format(row, col, b, m), None => ws.write_boolean(row, col, b) })?;
                            }
                            Some("string") | Some("text") => { xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, s, m), None => ws.write_string(row, col, s) })?; }
                            _ => write_string_value(ws, row, col, s, None, fmt.clone(), has_num_fmt, ctx)?,
                        }
                    }
                    Some(Value::Number(n)) => {
                        let x = n.as_f64().unwrap_or(0.0);
                        xerr(match &fmt { Some(m) => ws.write_number_with_format(row, col, x, m), None => ws.write_number(row, col, x) })?;
                    }
                    Some(Value::Bool(b)) => { xerr(match &fmt { Some(m) => ws.write_boolean_with_format(row, col, *b, m), None => ws.write_boolean(row, col, *b) })?; }
                    Some(other) => { let t = other.to_string(); xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, &t, m), None => ws.write_string(row, col, &t) })?; }
                }
            }
            if let Some(n) = note {
                let mut nt = Note::new(n);
                if let Some(a) = str_of(&ov, &["author", "noteAuthor"]) { nt = nt.set_author(a); }
                xerr(ws.insert_note(row, col, &nt))?;
            }
            Ok(())
        }
    }
}

/// 字符串值：`=` 开头是公式，`'` 开头是转义的字面文本，其余按列类型（date/number）尝试转换。
fn write_string_value(ws: &mut Worksheet, row: RowNum, col: ColNum, s: &str, col_kind: Option<&str>, fmt: Option<Format>, has_num_fmt: bool, _ctx: &mut Ctx) -> Result<(), String> {
    if let Some(f) = s.strip_prefix('=') {
        if !f.trim().is_empty() {
            return write_formula_at(ws, row, col, s, None, None, None, fmt.as_ref());
        }
    }
    if let Some(lit) = s.strip_prefix('\'') {
        return xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, lit, m), None => ws.write_string(row, col, lit) }).map(|_| ());
    }
    match col_kind {
        Some(k @ ("date" | "datetime" | "time")) if !s.trim().is_empty() => {
            if ExcelDateTime::parse_from_str(s.trim()).is_ok() { return write_datetime_at(ws, row, col, s, fmt, has_num_fmt, k); }
        }
        Some("number" | "percent" | "currency" | "int") => {
            if let Some(x) = parse_number(s) {
                return xerr(match &fmt { Some(m) => ws.write_number_with_format(row, col, x, m), None => ws.write_number(row, col, x) }).map(|_| ());
            }
        }
        _ => {}
    }
    xerr(match &fmt { Some(m) => ws.write_string_with_format(row, col, s, m), None => ws.write_string(row, col, s) }).map(|_| ())
}

// ── 列 / 行 / 区域 ────────────────────────────────────────────────────────────

/// 表头默认样式：粗体 + 浅灰底 + 灰色下边线。`headerStyle:false` 关掉，对象则整个替换。
fn header_format(sheet: &Value, ctx: &mut Ctx) -> Option<Format> {
    match get(sheet, &["headerStyle"]) {
        Some(Value::Bool(false)) => None,
        Some(spec @ Value::Object(_)) | Some(spec @ Value::String(_)) => {
            let wrapped = match spec { Value::String(name) => serde_json::json!({ "style": name }), other => other.clone() };
            Some(format_of(&wrapped, ctx))
        }
        _ => Some(ctx.base.clone().set_bold().set_background_color(Color::RGB(0xF2F2F2)).set_border_bottom(FormatBorder::Thin).set_border_bottom_color(Color::RGB(0xBFBFBF))),
    }
}

/// 处理 columns：写表头（默认第 1 行）、列宽、列默认格式/类型、隐藏。返回 (列定义, 表头占了几行)。
fn apply_columns(ws: &mut Worksheet, sheet: &Value, cols: &[Value], header_row: RowNum, ctx: &mut Ctx, written: &mut HashMap<(RowNum, ColNum), String>) -> Result<(Vec<ColDef>, RowNum), String> {
    let header_on = bool_of(sheet, &["header"]).unwrap_or(true);
    let hfmt = header_format(sheet, ctx);
    let mut defs = Vec::new();
    for (i, c) in cols.iter().enumerate() {
        let col = i as ColNum;
        let (header, spec) = match c {
            Value::String(s) => (Some(s.clone()), Value::Object(Map::new())),
            Value::Object(_) => (str_of(c, &["header", "title", "name", "label"]).map(|s| s.to_string()), c.clone()),
            other => (Some(other.to_string()), Value::Object(Map::new())),
        };
        let key = str_of(&spec, &["key", "id"]).map(|s| s.to_string()).or_else(|| header.clone());
        let kind = str_of(&spec, &["type", "t", "kind"]).map(|s| s.to_ascii_lowercase());
        // 列默认格式：style/numFmt/… 内联，加上按类型给的默认数字格式
        let mut has_num_fmt = str_of(&spec, &["numFmt", "format"]).is_some();
        let mut colfmt: Option<Format> = {
            let mut inline = spec.as_object().cloned().unwrap_or_default();
            for k in ["header", "title", "name", "label", "key", "id", "type", "t", "kind", "width", "hidden", "headerStyle"] { inline.remove(k); }
            if has_style_keys(&inline) { Some(format_of(&Value::Object(inline), ctx)) } else { None }
        };
        if let Some(k) = &kind {
            let default_nf = match k.as_str() { "date" => Some("yyyy-mm-dd"), "datetime" => Some("yyyy-mm-dd hh:mm"), "time" => Some("hh:mm"), "percent" => Some("0.00%"), "currency" => Some("¥#,##0.00"), "int" => Some("0"), _ => None };
            if let (Some(nf), false) = (default_nf, has_num_fmt) {
                let f = colfmt.take().unwrap_or_else(|| ctx.base.clone());
                colfmt = Some(f.set_num_format(nf));
                has_num_fmt = true;
            }
        }
        if let Some(w) = num_of(&spec, &["width"]) { xerr(ws.set_column_width(col, w))?; }
        if bool_of(&spec, &["hidden"]) == Some(true) { xerr(ws.set_column_hidden(col))?; }
        if let Some(f) = &colfmt { xerr(ws.set_column_format(col, f))?; }
        if header_on {
            if let Some(h) = &header {
                let hf = match get(&spec, &["headerStyle"]) {
                    Some(Value::Bool(false)) => None,
                    Some(hs) => Some(format_of(&match hs { Value::String(n) => serde_json::json!({ "style": n }), o => o.clone() }, ctx)),
                    None => hfmt.clone(),
                };
                xerr(match &hf { Some(m) => ws.write_string_with_format(header_row, col, h, m), None => ws.write_string(header_row, col, h) })?;
                written.insert((header_row, col), h.clone());
            }
        }
        defs.push(ColDef { key, kind, format: colfmt, has_num_fmt });
    }
    Ok((defs, if header_on { 1 } else { 0 }))
}

/// rows：数组行（按位置）或对象行（按列 key）。返回写到的最后一行（0 起，None＝没写）。
fn apply_rows(ws: &mut Worksheet, rows: &[Value], start_row: RowNum, defs: &[ColDef], ctx: &mut Ctx, written: &mut HashMap<(RowNum, ColNum), String>) -> Result<Option<RowNum>, String> {
    let mut r = start_row;
    let mut last = None;
    let key_index: HashMap<String, ColNum> = defs.iter().enumerate().filter_map(|(i, d)| d.key.clone().map(|k| (k, i as ColNum))).collect();
    for row in rows {
        // 行对象：{values|cells, style, height, hidden}
        let (cells, row_spec): (Option<&Value>, Option<&Value>) = match row {
            Value::Object(o) if o.contains_key("values") || o.contains_key("cells") => (get(row, &["values", "cells"]), Some(row)),
            _ => (Some(row), None),
        };
        match cells {
            Some(Value::Array(items)) => {
                for (i, v) in items.iter().enumerate() {
                    let col = i as ColNum;
                    write_cell(ws, r, col, v, defs.get(i), ctx)?;
                    if let Value::String(s) = v { written.insert((r, col), s.clone()); }
                }
            }
            Some(Value::Object(o)) => {
                for (k, v) in o {
                    let Some(&col) = key_index.get(k).or_else(|| key_index.get(&k.to_ascii_lowercase())) else {
                        ctx.warnings.push(format!("行对象的键 {k} 不对应任何列（columns 里定义 key）"));
                        continue;
                    };
                    write_cell(ws, r, col, v, defs.get(col as usize), ctx)?;
                }
            }
            Some(Value::Null) | None => {}
            Some(scalar) => { write_cell(ws, r, 0, scalar, defs.first(), ctx)?; }
        }
        if let Some(rs) = row_spec {
            if let Some(h) = num_of(rs, &["height"]) { xerr(ws.set_row_height(r, h))?; }
            if bool_of(rs, &["hidden"]) == Some(true) { xerr(ws.set_row_hidden(r))?; }
            if let Some(f) = maybe_format(rs, ctx) {
                // 行样式：套在整行已写的格子上（set_row_format 只影响空格子）
                xerr(ws.set_row_format(r, &f))?;
                if let Some(Value::Array(items)) = cells {
                    for i in 0..items.len() {
                        let col = i as ColNum;
                        let cell_fmt = match maybe_format(&items[i], ctx) { Some(own) => { let _ = own; None } None => Some(f.clone()) };
                        if let Some(cf) = cell_fmt { xerr(ws.set_cell_format(r, col, &cf))?; }
                    }
                }
            }
        }
        last = Some(r);
        r += 1;
    }
    Ok(last)
}

// ── 表格 / 条件格式 / 数据验证 ─────────────────────────────────────────────

fn table_style_of(v: &str) -> Option<TableStyle> {
    let t = v.trim().to_ascii_lowercase().replace([' ', '_', '-'], "");
    if t == "none" { return Some(TableStyle::None); }
    let (family, n) = if let Some(n) = t.strip_prefix("light") { ("light", n) } else if let Some(n) = t.strip_prefix("medium") { ("medium", n) } else if let Some(n) = t.strip_prefix("dark") { ("dark", n) } else { return Option::None };
    let n: u8 = n.parse().ok()?;
    use TableStyle::*;
    Some(match (family, n) {
        ("light", 1) => Light1, ("light", 2) => Light2, ("light", 3) => Light3, ("light", 4) => Light4, ("light", 5) => Light5, ("light", 6) => Light6, ("light", 7) => Light7,
        ("light", 8) => Light8, ("light", 9) => Light9, ("light", 10) => Light10, ("light", 11) => Light11, ("light", 12) => Light12, ("light", 13) => Light13, ("light", 14) => Light14,
        ("light", 15) => Light15, ("light", 16) => Light16, ("light", 17) => Light17, ("light", 18) => Light18, ("light", 19) => Light19, ("light", 20) => Light20, ("light", 21) => Light21,
        ("medium", 1) => Medium1, ("medium", 2) => Medium2, ("medium", 3) => Medium3, ("medium", 4) => Medium4, ("medium", 5) => Medium5, ("medium", 6) => Medium6, ("medium", 7) => Medium7,
        ("medium", 8) => Medium8, ("medium", 9) => Medium9, ("medium", 10) => Medium10, ("medium", 11) => Medium11, ("medium", 12) => Medium12, ("medium", 13) => Medium13, ("medium", 14) => Medium14,
        ("medium", 15) => Medium15, ("medium", 16) => Medium16, ("medium", 17) => Medium17, ("medium", 18) => Medium18, ("medium", 19) => Medium19, ("medium", 20) => Medium20, ("medium", 21) => Medium21,
        ("medium", 22) => Medium22, ("medium", 23) => Medium23, ("medium", 24) => Medium24, ("medium", 25) => Medium25, ("medium", 26) => Medium26, ("medium", 27) => Medium27, ("medium", 28) => Medium28,
        ("dark", 1) => Dark1, ("dark", 2) => Dark2, ("dark", 3) => Dark3, ("dark", 4) => Dark4, ("dark", 5) => Dark5, ("dark", 6) => Dark6, ("dark", 7) => Dark7, ("dark", 8) => Dark8, ("dark", 9) => Dark9, ("dark", 10) => Dark10, ("dark", 11) => Dark11,
        _ => return Option::None,
    })
}

fn table_function_of(v: &str) -> Option<TableFunction> {
    Some(match v.trim().to_ascii_lowercase().as_str() {
        "sum" => TableFunction::Sum,
        "average" | "avg" | "mean" => TableFunction::Average,
        "count" => TableFunction::Count,
        "countnums" | "count_numbers" | "countnumbers" => TableFunction::CountNumbers,
        "max" => TableFunction::Max,
        "min" => TableFunction::Min,
        "stddev" | "stdev" => TableFunction::StdDev,
        "var" => TableFunction::Var,
        "none" | "" => TableFunction::None,
        other => {
            if other.starts_with('=') { TableFunction::Custom(Formula::new(v.trim())) } else { return None }
        }
    })
}

fn apply_table(ws: &mut Worksheet, t: &Value, written: &HashMap<(RowNum, ColNum), String>, ctx: &mut Ctx) -> Result<(), String> {
    let range = str_of(t, &["ref", "range"]).ok_or("tables[] 需要 ref（如 \"A1:D10\"）")?;
    let (_, r0, c0, mut r1, c1) = parse_range(range).ok_or_else(|| format!("表格范围不合法：{range}"))?;
    let header = bool_of(t, &["header", "headerRow"]).unwrap_or(true);
    let total = bool_of(t, &["totalRow", "totals"]).unwrap_or(false);
    let mut table = Table::new().set_header_row(header).set_total_row(total);
    if total { r1 += 1; } // 合计行在数据区之下：ref 只写到数据末行，这里自动加一行
    if let Some(n) = str_of(t, &["name"]) { table = table.set_name(n); }
    if let Some(st) = str_of(t, &["style"]) { match table_style_of(st) { Some(s) => table = table.set_style(s), None => ctx.warnings.push(format!("表格样式不认识：{st}（Light1-21 / Medium1-28 / Dark1-11）")) } }
    if let Some(b) = bool_of(t, &["bandedRows", "banded"]) { table = table.set_banded_rows(b); }
    if let Some(b) = bool_of(t, &["bandedColumns"]) { table = table.set_banded_columns(b); }
    if let Some(b) = bool_of(t, &["firstColumn"]) { table = table.set_first_column(b); }
    if let Some(b) = bool_of(t, &["lastColumn"]) { table = table.set_last_column(b); }
    if let Some(b) = bool_of(t, &["autofilter", "autoFilter", "filter"]) { table = table.set_autofilter(b); }
    // 列：规格里给的优先；否则用表头行已写的字符串当列名（Excel 表格要求列名唯一非空）
    let spec_cols = arr_of(t, &["columns"]).cloned().unwrap_or_default();
    let ncols = (c1 - c0 + 1) as usize;
    let mut cols: Vec<TableColumn> = Vec::with_capacity(ncols);
    for i in 0..ncols {
        let col = c0 + i as ColNum;
        let mut tc = TableColumn::new();
        let spec = spec_cols.get(i);
        let header_text = spec.and_then(|s| match s { Value::String(x) => Some(x.clone()), o => str_of(o, &["header", "name", "title"]).map(|x| x.to_string()) })
            .or_else(|| if header { written.get(&(r0, col)).cloned() } else { None });
        if let Some(h) = header_text { tc = tc.set_header(h); }
        if let Some(Value::Object(_)) = spec {
            let s = spec.unwrap();
            if let Some(func) = str_of(s, &["total", "totalFunction", "totals"]) { match table_function_of(func) { Some(f) => tc = tc.set_total_function(f), None => ctx.warnings.push(format!("合计函数不认识：{func}")) } }
            if let Some(l) = str_of(s, &["totalLabel"]) { tc = tc.set_total_label(l); }
            if let Some(f) = str_of(s, &["formula"]) { tc = tc.set_formula(Formula::new(f)); }
            let mut inline = s.as_object().cloned().unwrap_or_default();
            for k in ["header", "name", "title", "total", "totalFunction", "totals", "totalLabel", "formula"] { inline.remove(k); }
            if has_style_keys(&inline) { tc = tc.set_format(format_of(&Value::Object(inline), ctx)); }
        }
        cols.push(tc);
    }
    table = table.set_columns(&cols);
    xerr(ws.add_table(r0, c0, r1, c1, &table)).map(|_| ())
}

/// 条件格式的值：数字 / 文本 / "=公式"
fn cf_value(v: &Value) -> ConditionalFormatValue {
    match v {
        Value::Number(n) => ConditionalFormatValue::from(n.as_f64().unwrap_or(0.0)),
        Value::Bool(b) => ConditionalFormatValue::from(*b),
        Value::String(s) if s.trim_start().starts_with('=') => ConditionalFormatValue::from(Formula::new(s.trim())),
        Value::String(s) => match parse_number(s) { Some(x) if !s.contains(|c: char| c.is_alphabetic()) => ConditionalFormatValue::from(x), _ => ConditionalFormatValue::from(s.clone()) },
        other => ConditionalFormatValue::from(other.to_string()),
    }
}

fn cf_operator<T: IntoConditionalFormatValue>(op: &str, a: T, b: Option<T>) -> Option<ConditionalFormatCellRule<T>> {
    use ConditionalFormatCellRule::*;
    Some(match op.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "equal" | "equalto" | "eq" | "=" | "==" => EqualTo(a),
        "notequal" | "notequalto" | "ne" | "!=" | "<>" => NotEqualTo(a),
        "greaterthan" | "gt" | ">" => GreaterThan(a),
        "greaterthanorequal" | "greaterthanorequalto" | "gte" | "ge" | ">=" => GreaterThanOrEqualTo(a),
        "lessthan" | "lt" | "<" => LessThan(a),
        "lessthanorequal" | "lessthanorequalto" | "lte" | "le" | "<=" => LessThanOrEqualTo(a),
        "between" => Between(a, b?),
        "notbetween" => NotBetween(a, b?),
        _ => return None,
    })
}

fn cf_type_of(v: &str) -> Option<ConditionalFormatType> {
    Some(match v.trim().to_ascii_lowercase().as_str() {
        "num" | "number" => ConditionalFormatType::Number,
        "percent" => ConditionalFormatType::Percent,
        "percentile" => ConditionalFormatType::Percentile,
        "formula" => ConditionalFormatType::Formula,
        "min" | "lowest" => ConditionalFormatType::Lowest,
        "max" | "highest" => ConditionalFormatType::Highest,
        "auto" | "automatic" => ConditionalFormatType::Automatic,
        _ => return None,
    })
}

fn apply_conditional_format(ws: &mut Worksheet, cf: &Value, ctx: &mut Ctx) -> Result<(), String> {
    let range = str_of(cf, &["ref", "range"]).ok_or("conditionalFormats[] 需要 ref")?;
    let (_, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("条件格式范围不合法：{range}"))?;
    let kind = str_of(cf, &["type", "kind"]).unwrap_or("cell").to_ascii_lowercase().replace(['_', ' ', '-'], "");
    // style 可以是命名样式名或对象；先算好再进各分支。
    let style_fmt: Format = match get(cf, &["style", "format"]) {
        Some(Value::String(name)) => format_of(&serde_json::json!({ "style": name }), ctx),
        Some(Value::Object(o)) => format_of(&Value::Object(o.clone()), ctx),
        _ => Format::new(),
    };
    let stop = bool_of(cf, &["stopIfTrue"]).unwrap_or(false);
    let multi = str_of(cf, &["multiRange", "ranges"]).map(|s| s.to_string());
    macro_rules! finish {
        ($cfobj:expr) => {{
            let mut obj = $cfobj;
            if stop { obj = obj.set_stop_if_true(true); }
            if let Some(m) = &multi { obj = obj.set_multi_range(m.as_str()); }
            xerr(ws.add_conditional_format(r0, c0, r1, c1, &obj)).map(|_| ())
        }};
    }
    match kind.as_str() {
        "cell" | "cellis" | "value" | "compare" => {
            let op = str_of(cf, &["operator", "op"]).unwrap_or("greaterThan");
            let values: Vec<Value> = match get(cf, &["values"]) { Some(Value::Array(a)) => a.clone(), _ => {
                let mut v = Vec::new();
                if let Some(x) = get(cf, &["value", "min", "from"]) { v.push(x.clone()); }
                if let Some(x) = get(cf, &["max", "to", "value2"]) { v.push(x.clone()); }
                v
            } };
            let a = values.first().ok_or("cell 条件格式需要 value（或 min/max）")?;
            let rule = cf_operator(op, cf_value(a), values.get(1).map(cf_value)).ok_or_else(|| format!("operator 不认识：{op}"))?;
            finish!(ConditionalFormatCell::new().set_rule(rule).set_format(style_fmt))
        }
        "colorscale" | "scale" => {
            let colors: Vec<String> = arr_of(cf, &["colors"]).map(|a| a.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let parse_pt = |k: &str| -> Option<(ConditionalFormatType, ConditionalFormatValue)> {
                let pt = get(cf, &[k])?;
                let t = str_of(pt, &["type"]).and_then(cf_type_of)?;
                let v = get(pt, &["value"]).map(cf_value).unwrap_or_else(|| ConditionalFormatValue::from(0.0));
                Some((t, v))
            };
            if colors.len() >= 3 {
                let mut c = ConditionalFormat3ColorScale::new();
                if let Some(x) = color_of(&colors[0]) { c = c.set_minimum_color(x); }
                if let Some(x) = color_of(&colors[1]) { c = c.set_midpoint_color(x); }
                if let Some(x) = color_of(&colors[2]) { c = c.set_maximum_color(x); }
                if let Some((t, v)) = parse_pt("min") { c = c.set_minimum(t, v); }
                if let Some((t, v)) = parse_pt("mid") { c = c.set_midpoint(t, v); }
                if let Some((t, v)) = parse_pt("max") { c = c.set_maximum(t, v); }
                finish!(c)
            } else {
                let mut c = ConditionalFormat2ColorScale::new();
                if let Some(x) = colors.first().and_then(|s| color_of(s)) { c = c.set_minimum_color(x); }
                if let Some(x) = colors.get(1).and_then(|s| color_of(s)) { c = c.set_maximum_color(x); }
                if let Some((t, v)) = parse_pt("min") { c = c.set_minimum(t, v); }
                if let Some((t, v)) = parse_pt("max") { c = c.set_maximum(t, v); }
                finish!(c)
            }
        }
        "databar" | "bar" => {
            let mut c = ConditionalFormatDataBar::new();
            if let Some(x) = str_of(cf, &["color", "fill"]).and_then(color_of) { c = c.set_fill_color(x); }
            if let Some(x) = str_of(cf, &["negativeColor"]).and_then(color_of) { c = c.set_negative_fill_color(x); }
            if let Some(x) = str_of(cf, &["borderColor"]).and_then(color_of) { c = c.set_border_color(x); }
            if let Some(x) = str_of(cf, &["axisColor"]).and_then(color_of) { c = c.set_axis_color(x); }
            if let Some(b) = bool_of(cf, &["solid", "solidFill"]) { c = c.set_solid_fill(b); }
            if let Some(b) = bool_of(cf, &["barOnly", "hideValue"]) { c = c.set_bar_only(b); }
            if let Some(d) = str_of(cf, &["direction"]) { c = c.set_direction(match d.to_ascii_lowercase().as_str() { "ltr" | "lefttoright" | "left" => ConditionalFormatDataBarDirection::LeftToRight, "rtl" | "righttoleft" | "right" => ConditionalFormatDataBarDirection::RightToLeft, _ => ConditionalFormatDataBarDirection::Context }); }
            finish!(c)
        }
        "iconset" | "icons" | "icon" => {
            let icons = str_of(cf, &["icons", "iconSet", "set"]).unwrap_or("3TrafficLights").to_ascii_lowercase().replace(['_', ' ', '-'], "");
            use ConditionalFormatIconType::*;
            let t = match icons.as_str() {
                "3arrows" | "threearrows" | "arrows" => ThreeArrows, "3arrowsgray" | "threearrowsgray" => ThreeArrowsGray,
                "3flags" | "threeflags" | "flags" => ThreeFlags, "3trafficlights" | "3trafficlights1" | "threetrafficlights" | "trafficlights" => ThreeTrafficLights,
                "3trafficlights2" | "3trafficlightswithrim" | "threetrafficlightswithrim" => ThreeTrafficLightsWithRim, "3signs" | "threesigns" | "signs" => ThreeSigns,
                "3symbols" | "3symbols2" | "threesymbols" | "symbols" => ThreeSymbols, "3symbolscircled" | "3symbols1" | "threesymbolscircled" => ThreeSymbolsCircled,
                "3stars" | "threestars" | "stars" => ThreeStars, "3triangles" | "threetriangles" | "triangles" => ThreeTriangles,
                "4arrows" | "fourarrows" => FourArrows, "4arrowsgray" | "fourarrowsgray" => FourArrowsGray, "4redtoblack" | "fourredtoblack" => FourRedToBlack,
                "4rating" | "4histograms" | "fourhistograms" => FourHistograms, "4trafficlights" | "fourtrafficlights" => FourTrafficLights,
                "5arrows" | "fivearrows" => FiveArrows, "5arrowsgray" | "fivearrowsgray" => FiveArrowsGray, "5rating" | "5histograms" | "fivehistograms" => FiveHistograms,
                "5quarters" | "5quadrants" | "fivequadrants" => FiveQuadrants, "5boxes" | "fiveboxes" => FiveBoxes,
                other => { ctx.warnings.push(format!("图标集不认识：{other}，用了 3TrafficLights")); ThreeTrafficLights }
            };
            let mut c = ConditionalFormatIconSet::new().set_icon_type(t);
            if bool_of(cf, &["iconsOnly", "hideValue"]) == Some(true) { c = c.show_icons_only(true); }
            finish!(c)
        }
        "top" | "top10" | "bottom" | "rank" => {
            let n = num_of(cf, &["rank", "n", "value"]).unwrap_or(10.0).max(1.0) as u16;
            let percent = bool_of(cf, &["percent"]).unwrap_or(false);
            let bottom = kind == "bottom" || bool_of(cf, &["bottom"]).unwrap_or(false);
            let rule = match (bottom, percent) { (false, false) => ConditionalFormatTopRule::Top(n), (false, true) => ConditionalFormatTopRule::TopPercent(n), (true, false) => ConditionalFormatTopRule::Bottom(n), (true, true) => ConditionalFormatTopRule::BottomPercent(n) };
            finish!(ConditionalFormatTop::new().set_rule(rule).set_format(style_fmt))
        }
        "aboveaverage" | "average" | "belowaverage" => {
            let rule_s = str_of(cf, &["rule"]).map(|s| s.to_ascii_lowercase().replace(['_', ' ', '-'], "")).unwrap_or_else(|| if kind == "belowaverage" || bool_of(cf, &["above"]) == Some(false) { "below".into() } else { "above".into() });
            use ConditionalFormatAverageRule::*;
            let rule = match rule_s.as_str() {
                "above" | "aboveaverage" => AboveAverage, "below" | "belowaverage" => BelowAverage,
                "equalorabove" | "aboveorequal" => EqualOrAboveAverage, "equalorbelow" | "beloworequal" => EqualOrBelowAverage,
                "1stdabove" | "onestddevabove" => OneStandardDeviationAbove, "1stdbelow" | "onestddevbelow" => OneStandardDeviationBelow,
                "2stdabove" => TwoStandardDeviationsAbove, "2stdbelow" => TwoStandardDeviationsBelow, "3stdabove" => ThreeStandardDeviationsAbove, "3stdbelow" => ThreeStandardDeviationsBelow,
                _ => AboveAverage,
            };
            finish!(ConditionalFormatAverage::new().set_rule(rule).set_format(style_fmt))
        }
        "duplicate" | "duplicates" => finish!(ConditionalFormatDuplicate::new().set_format(style_fmt)),
        "unique" => finish!(ConditionalFormatDuplicate::new().invert().set_format(style_fmt)),
        "text" | "contains" | "containstext" => {
            let text = str_of(cf, &["text", "value"]).ok_or("text 条件格式需要 text")?.to_string();
            let op = str_of(cf, &["operator", "op"]).unwrap_or("contains").to_ascii_lowercase().replace(['_', ' ', '-'], "");
            let rule = match op.as_str() { "notcontains" | "doesnotcontain" | "notcontain" => ConditionalFormatTextRule::DoesNotContain(text), "beginswith" | "startswith" => ConditionalFormatTextRule::BeginsWith(text), "endswith" => ConditionalFormatTextRule::EndsWith(text), _ => ConditionalFormatTextRule::Contains(text) };
            finish!(ConditionalFormatText::new().set_rule(rule).set_format(style_fmt))
        }
        "date" | "timeperiod" => {
            let p = str_of(cf, &["period", "timePeriod", "rule"]).unwrap_or("today").to_ascii_lowercase().replace(['_', ' ', '-'], "");
            use ConditionalFormatDateRule::*;
            let rule = match p.as_str() { "yesterday" => Yesterday, "tomorrow" => Tomorrow, "last7days" => Last7Days, "lastweek" => LastWeek, "thisweek" => ThisWeek, "nextweek" => NextWeek, "lastmonth" => LastMonth, "thismonth" => ThisMonth, "nextmonth" => NextMonth, _ => Today };
            finish!(ConditionalFormatDate::new().set_rule(rule).set_format(style_fmt))
        }
        "blank" | "blanks" | "empty" => finish!(ConditionalFormatBlank::new().set_format(style_fmt)),
        "notblank" | "noblanks" | "nonempty" | "notempty" => finish!(ConditionalFormatBlank::new().invert().set_format(style_fmt)),
        "error" | "errors" => finish!(ConditionalFormatError::new().set_format(style_fmt)),
        "noterror" | "noerrors" => finish!(ConditionalFormatError::new().invert().set_format(style_fmt)),
        "formula" | "expression" | "custom" => {
            let f = str_of(cf, &["formula", "expression", "value"]).ok_or("formula 条件格式需要 formula")?;
            finish!(ConditionalFormatFormula::new().set_rule(Formula::new(f)).set_format(style_fmt))
        }
        other => Err(format!("条件格式 type 不认识：{other}（cell/colorScale/dataBar/iconSet/top/bottom/aboveAverage/duplicate/unique/text/date/blank/notBlank/error/notError/formula）")),
    }
}

fn dv_rule<T: IntoDataValidationValue>(op: &str, a: T, b: Option<T>) -> Option<DataValidationRule<T>> {
    use DataValidationRule::*;
    Some(match op.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "equal" | "equalto" | "eq" | "=" | "==" => EqualTo(a),
        "notequal" | "notequalto" | "ne" | "!=" | "<>" => NotEqualTo(a),
        "greaterthan" | "gt" | ">" => GreaterThan(a),
        "greaterthanorequal" | "greaterthanorequalto" | "gte" | ">=" => GreaterThanOrEqualTo(a),
        "lessthan" | "lt" | "<" => LessThan(a),
        "lessthanorequal" | "lessthanorequalto" | "lte" | "<=" => LessThanOrEqualTo(a),
        "between" => Between(a, b?),
        "notbetween" => NotBetween(a, b?),
        _ => return None,
    })
}

fn apply_validation(ws: &mut Worksheet, v: &Value, ctx: &mut Ctx) -> Result<(), String> {
    let range = str_of(v, &["ref", "range"]).ok_or("validations[] 需要 ref")?;
    let (_, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("数据验证范围不合法：{range}"))?;
    let kind = str_of(v, &["type", "kind"]).unwrap_or("list").to_ascii_lowercase().replace(['_', ' ', '-'], "");
    let op = str_of(v, &["operator", "op"]).unwrap_or("between");
    // 数值区间：values:[a,b] 或 min/max 或 value
    let nums: Vec<f64> = match get(v, &["values"]) {
        Some(Value::Array(a)) if kind != "list" => a.iter().filter_map(f64_of).collect(),
        _ => [get(v, &["value", "min", "from"]), get(v, &["max", "to", "value2"])].iter().flatten().filter_map(|x| f64_of(x)).collect(),
    };
    let strs: Vec<String> = [get(v, &["value", "min", "from"]), get(v, &["max", "to", "value2"])].iter().flatten().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
    let mut dv = DataValidation::new();
    dv = match kind.as_str() {
        "list" | "dropdown" | "select" => {
            if let Some(f) = str_of(v, &["formula", "source", "range"]).filter(|s| s.trim_start().starts_with('=') || s.contains('!') || s.contains(':')) {
                dv.allow_list_formula(Formula::new(if f.starts_with('=') { f.to_string() } else { format!("={f}") }))
            } else {
                let items: Vec<String> = match get(v, &["values", "list", "options", "items"]) {
                    Some(Value::Array(a)) => a.iter().map(|x| match x { Value::String(s) => s.clone(), o => o.to_string() }).collect(),
                    Some(Value::String(s)) => s.split(',').map(|x| x.trim().to_string()).collect(),
                    _ => return Err("list 验证需要 values（数组）或 formula（如 \"=$H$1:$H$5\"）".into()),
                };
                dv.allow_list_strings(&items).map_err(|e| e.to_string())?
            }
        }
        "whole" | "wholenumber" | "integer" | "int" => {
            let a = nums.first().copied().ok_or("whole 验证需要 value（或 min/max）")? as i32;
            dv.allow_whole_number(dv_rule(op, a, nums.get(1).map(|x| *x as i32)).ok_or_else(|| format!("operator 不认识：{op}"))?)
        }
        "decimal" | "number" | "float" => {
            let a = nums.first().copied().ok_or("decimal 验证需要 value（或 min/max）")?;
            dv.allow_decimal_number(dv_rule(op, a, nums.get(1).copied()).ok_or_else(|| format!("operator 不认识：{op}"))?)
        }
        "length" | "textlength" => {
            let a = nums.first().copied().ok_or("length 验证需要 value（或 min/max）")?.max(0.0) as u32;
            dv.allow_text_length(dv_rule(op, a, nums.get(1).map(|x| x.max(0.0) as u32)).ok_or_else(|| format!("operator 不认识：{op}"))?)
        }
        "date" | "time" => {
            let parse = |s: &str| ExcelDateTime::parse_from_str(s.trim()).map_err(|e| format!("日期 {s} 解析失败: {e}"));
            let a = parse(strs.first().ok_or("date/time 验证需要 value（或 min/max，如 \"2024-01-01\"）")?)?;
            let b = match strs.get(1) { Some(s) => Some(parse(s)?), None => None };
            let rule = dv_rule(op, a, b).ok_or_else(|| format!("operator 不认识：{op}"))?;
            if kind == "date" { dv.allow_date(rule) } else { dv.allow_time(rule) }
        }
        "custom" | "formula" => dv.allow_custom(Formula::new(str_of(v, &["formula", "value"]).ok_or("custom 验证需要 formula")?)),
        "any" => dv.allow_any_value(),
        other => return Err(format!("验证 type 不认识：{other}（list/whole/decimal/length/date/time/custom/any）")),
    };
    if let Some(b) = bool_of(v, &["allowBlank", "ignoreBlank"]) { dv = dv.ignore_blank(b); }
    if let Some(b) = bool_of(v, &["dropdown", "showDropdown"]) { dv = dv.show_dropdown(b); }
    if let Some(t) = str_of(v, &["promptTitle", "inputTitle"]) { dv = dv.set_input_title(t).map_err(|e| e.to_string())?; }
    if let Some(t) = str_of(v, &["prompt", "inputMessage"]) { dv = dv.set_input_message(t).map_err(|e| e.to_string())?; }
    if let Some(t) = str_of(v, &["errorTitle"]) { dv = dv.set_error_title(t).map_err(|e| e.to_string())?; }
    if let Some(t) = str_of(v, &["error", "errorMessage"]) { dv = dv.set_error_message(t).map_err(|e| e.to_string())?; }
    if let Some(s) = str_of(v, &["errorStyle"]) { dv = dv.set_error_style(match s.to_ascii_lowercase().as_str() { "warning" | "warn" => DataValidationErrorStyle::Warning, "info" | "information" => DataValidationErrorStyle::Information, _ => DataValidationErrorStyle::Stop }); }
    if bool_of(v, &["showError", "showErrorMessage"]) == Some(false) { dv = dv.show_error_message(false); }
    if let Some(m) = str_of(v, &["multiRange", "ranges"]) { dv = dv.set_multi_range(m); }
    let _ = &mut ctx.warnings;
    xerr(ws.add_data_validation(r0, c0, r1, c1, &dv)).map(|_| ())
}

// ── 图表 ────────────────────────────────────────────────────────────────────

fn chart_type_of(v: &str) -> Option<ChartType> {
    use ChartType::*;
    Some(match v.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "column" | "col" | "vbar" | "verticalbar" => Column,
        "columnstacked" | "stackedcolumn" | "stacked" => ColumnStacked,
        "columnpercentstacked" | "percentstackedcolumn" | "column100" => ColumnPercentStacked,
        "bar" | "hbar" | "horizontalbar" => Bar,
        "barstacked" | "stackedbar" => BarStacked,
        "barpercentstacked" | "percentstackedbar" | "bar100" => BarPercentStacked,
        "line" => Line,
        "linestacked" | "stackedline" => LineStacked,
        "linepercentstacked" | "percentstackedline" => LinePercentStacked,
        "area" => Area,
        "areastacked" | "stackedarea" => AreaStacked,
        "areapercentstacked" | "percentstackedarea" => AreaPercentStacked,
        "pie" => Pie,
        "doughnut" | "donut" | "ring" => Doughnut,
        "scatter" | "xy" | "points" => Scatter,
        "scatterstraight" | "scatterline" | "scatterlines" => ScatterStraight,
        "scatterstraightwithmarkers" | "scatterlinemarkers" | "scatterlinesmarkers" => ScatterStraightWithMarkers,
        "scattersmooth" | "scattercurve" => ScatterSmooth,
        "scattersmoothwithmarkers" | "scattercurvemarkers" => ScatterSmoothWithMarkers,
        "radar" | "spider" => Radar,
        "radarwithmarkers" | "radarmarkers" => RadarWithMarkers,
        "radarfilled" | "filledradar" => RadarFilled,
        "stock" | "candlestick" | "ohlc" => Stock,
        _ => return None,
    })
}

/// 系列数据来源：`"Sheet1!A2:A7"` / `"A2:A7"`（默认当前表）/ {sheet, range} / 字面量数组（写进隐藏表 _data）。
fn chart_range(v: &Value, sheet_name: &str, ctx: &mut Ctx) -> Result<ChartRange, String> {
    match v {
        Value::String(s) => {
            let (sheet, r0, c0, r1, c1) = parse_range(s).ok_or_else(|| format!("图表范围不合法：{s}"))?;
            Ok(ChartRange::new_from_range(sheet.as_deref().unwrap_or(sheet_name), r0, c0, r1, c1))
        }
        Value::Object(_) => {
            let range = str_of(v, &["range", "ref"]).ok_or("系列数据对象需要 range")?;
            let (sheet, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("图表范围不合法：{range}"))?;
            let sheet = str_of(v, &["sheet"]).map(|s| s.to_string()).or(sheet).unwrap_or_else(|| sheet_name.to_string());
            Ok(ChartRange::new_from_range(&sheet, r0, c0, r1, c1))
        }
        Value::Array(items) => {
            // 字面量：写进隐藏数据表的下一列
            if ctx.data_ws.is_none() {
                let mut ws = Worksheet::new();
                xerr(ws.set_name("_data"))?;
                ws.set_hidden(true);
                ctx.data_ws = Some(ws);
            }
            let col = ctx.data_next_col;
            ctx.data_next_col += 1;
            let ws = ctx.data_ws.as_mut().unwrap();
            for (i, it) in items.iter().enumerate() {
                let row = i as RowNum;
                match it {
                    Value::Number(n) => { xerr(ws.write_number(row, col, n.as_f64().unwrap_or(0.0)))?; }
                    Value::String(s) => match parse_number(s) { Some(x) if !s.chars().any(|c| c.is_alphabetic()) => { xerr(ws.write_number(row, col, x))?; } _ => { xerr(ws.write_string(row, col, s))?; } },
                    Value::Bool(b) => { xerr(ws.write_boolean(row, col, *b))?; }
                    Value::Null => {}
                    other => { xerr(ws.write_string(row, col, &other.to_string()))?; }
                }
            }
            let last = items.len().saturating_sub(1) as RowNum;
            Ok(ChartRange::new_from_range("_data", 0, col, last, col))
        }
        other => Err(format!("系列数据形状不认识：{other}")),
    }
}

fn chart_font_of(v: &Value) -> ChartFont {
    let mut f = ChartFont::new();
    if let Some(n) = num_of(v, &["size", "fontSize"]) { f.set_size(n); }
    if bool_of(v, &["bold"]) == Some(true) { f.set_bold(); }
    if bool_of(v, &["italic"]) == Some(true) { f.set_italic(); }
    if let Some(c) = str_of(v, &["color"]).and_then(color_of) { f.set_color(c); }
    if let Some(n) = str_of(v, &["font", "name", "fontName"]) { f.set_name(n); }
    if let Some(r) = num_of(v, &["rotation"]) { f.set_rotation(r as i16); }
    f
}

fn dash_of(v: &str) -> ChartLineDashType {
    match v.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "dash" | "dashed" => ChartLineDashType::Dash, "dot" | "dotted" | "rounddot" => ChartLineDashType::RoundDot, "squaredot" => ChartLineDashType::SquareDot,
        "dashdot" => ChartLineDashType::DashDot, "longdash" => ChartLineDashType::LongDash, "longdashdot" => ChartLineDashType::LongDashDot, "longdashdotdot" => ChartLineDashType::LongDashDotDot,
        _ => ChartLineDashType::Solid,
    }
}

/// {color|fill, line:{color,width,dash}, noFill, noLine, transparency, gradient:[c1,c2]} → ChartFormat
fn chart_format_of(v: &Value, ctx: &mut Ctx) -> Option<ChartFormat> {
    let mut fmt = ChartFormat::new();
    let mut any = false;
    let fill = str_of(v, &["fill", "color", "background"]);
    if let Some(c) = fill {
        match color_of(c) {
            Some(col) => { let mut sf = ChartSolidFill::new(); sf.set_color(col); if let Some(t) = num_of(v, &["transparency", "fillTransparency"]) { sf.set_transparency(t.clamp(0.0, 100.0) as u8); } fmt.set_solid_fill(&sf); any = true; }
            None => ctx.warnings.push(format!("图表颜色不认识：{c}")),
        }
    }
    if let Some(stops) = arr_of(v, &["gradient"]) {
        let cols: Vec<Color> = stops.iter().filter_map(|s| s.as_str().and_then(color_of)).collect();
        if cols.len() >= 2 {
            let n = cols.len();
            let gs: Vec<ChartGradientStop> = cols.iter().enumerate().map(|(i, c)| ChartGradientStop::new(*c, (i * 100 / (n - 1)) as u8)).collect();
            let mut g = ChartGradientFill::new();
            g.set_gradient_stops(&gs);
            if let Some(a) = num_of(v, &["gradientAngle", "angle"]) { g.set_angle(a.clamp(0.0, 359.9) as u16); }
            fmt.set_gradient_fill(&g); any = true;
        }
    }
    match get(v, &["line", "border", "stroke"]) {
        Some(Value::String(c)) => { if let Some(col) = color_of(c) { let mut l = ChartLine::new(); l.set_color(col); fmt.set_line(&l); any = true; } }
        Some(lo @ Value::Object(_)) => {
            let mut l = ChartLine::new();
            if let Some(col) = str_of(lo, &["color"]).and_then(color_of) { l.set_color(col); }
            if let Some(w) = num_of(lo, &["width"]) { l.set_width(w); }
            if let Some(d) = str_of(lo, &["dash", "dashType", "style"]) { l.set_dash_type(dash_of(d)); }
            if let Some(t) = num_of(lo, &["transparency"]) { l.set_transparency(t.clamp(0.0, 100.0) as u8); }
            if bool_of(lo, &["hidden", "none"]) == Some(true) { l.set_hidden(true); }
            fmt.set_line(&l); any = true;
        }
        _ => {}
    }
    if bool_of(v, &["noFill"]) == Some(true) { fmt.set_no_fill(); any = true; }
    if bool_of(v, &["noLine", "noBorder"]) == Some(true) { fmt.set_no_line(); any = true; }
    if any { Some(fmt) } else { None }
}

fn apply_axis(axis: &mut ChartAxis, v: &Value, ctx: &mut Ctx) {
    if let Some(t) = str_of(v, &["title", "name"]) { axis.set_name(t); }
    if let Some(f) = get(v, &["titleFont", "nameFont"]) { axis.set_name_font(&chart_font_of(f)); }
    if let Some(f) = get(v, &["font", "labelFont"]) { axis.set_font(&chart_font_of(f)); }
    if let Some(nf) = str_of(v, &["numFmt", "format"]) { axis.set_num_format(num_format_of(nf)); }
    if let Some(x) = num_of(v, &["min"]) { axis.set_min(x); }
    if let Some(x) = num_of(v, &["max"]) { axis.set_max(x); }
    if let Some(x) = num_of(v, &["majorUnit", "step"]) { axis.set_major_unit(x); }
    if let Some(x) = num_of(v, &["minorUnit"]) { axis.set_minor_unit(x); }
    if let Some(b) = bool_of(v, &["majorGridlines", "gridlines", "grid"]) { axis.set_major_gridlines(b); }
    if let Some(b) = bool_of(v, &["minorGridlines"]) { axis.set_minor_gridlines(b); }
    if let Some(g) = get(v, &["gridlineStyle", "majorGridlineStyle"]) { if let Some(f) = chart_format_of(g, ctx) { let _ = f; } if let Some(c) = str_of(g, &["color"]).and_then(color_of) { let mut l = ChartLine::new(); l.set_color(c); if let Some(w) = num_of(g, &["width"]) { l.set_width(w); } if let Some(d) = str_of(g, &["dash"]) { l.set_dash_type(dash_of(d)); } axis.set_major_gridlines_line(&l); } }
    if bool_of(v, &["reverse", "reversed"]) == Some(true) { axis.set_reverse(); }
    if let Some(b) = num_of(v, &["logBase", "log"]) { if b >= 2.0 { axis.set_log_base(b as u16); } }
    if let Some(b) = bool_of(v, &["hidden", "hide"]) { axis.set_hidden(b); }
    if bool_of(v, &["visible"]) == Some(false) { axis.set_hidden(true); }
    if let Some(p) = str_of(v, &["labelPosition", "labels"]) { axis.set_label_position(match p.to_ascii_lowercase().as_str() { "high" => ChartAxisLabelPosition::High, "low" => ChartAxisLabelPosition::Low, "none" => ChartAxisLabelPosition::None, _ => ChartAxisLabelPosition::NextTo }); }
    if let Some(b) = bool_of(v, &["dateAxis", "date"]) { axis.set_date_axis(b); }
    if let Some(b) = bool_of(v, &["textAxis", "text"]) { axis.set_text_axis(b); }
    if let Some(b) = bool_of(v, &["betweenTicks", "positionBetweenTicks"]) { axis.set_position_between_ticks(b); }
    if let Some(f) = get(v, &["style", "line"]) { if let Some(mut cf) = chart_format_of(f, ctx) { axis.set_format(&mut cf); } }
}

fn apply_series(chart: &mut Chart, sv: &Value, sheet_name: &str, ctx: &mut Ctx) -> Result<(), String> {
    let values = get(sv, &["values", "data", "y"]).ok_or("series[] 需要 values")?;
    let values_range = chart_range(values, sheet_name, ctx)?;
    let cats = match get(sv, &["categories", "labels", "x"]) { Some(c) => Some(chart_range(c, sheet_name, ctx)?), None => None };
    let series = chart.add_series();
    series.set_values(&values_range);
    if let Some(c) = &cats { series.set_categories(c); }
    match get(sv, &["name", "title"]) {
        Some(Value::String(n)) => { if n.contains('!') { let (s, r0, c0, _, _) = parse_range(n).map(|x| (x.0, x.1, x.2, x.3, x.4)).ok_or_else(|| format!("系列名引用不合法：{n}"))?; series.set_name((s.as_deref().unwrap_or(sheet_name), r0, c0)); } else { series.set_name(n.as_str()); } }
        Some(other) => { series.set_name(other.to_string().as_str()); }
        None => {}
    }
    // 外观：color / fill / line / gradient / noFill
    if let Some(mut f) = chart_format_of(sv, ctx) { series.set_format(&mut f); }
    if let Some(cols) = arr_of(sv, &["pointColors", "colors"]) {
        let list: Vec<Color> = cols.iter().filter_map(|c| c.as_str().and_then(color_of)).collect();
        if !list.is_empty() { series.set_point_colors(&list); }
    }
    if let Some(pts) = arr_of(sv, &["points"]) {
        let points: Vec<ChartPoint> = pts.iter().map(|p| match chart_format_of(p, ctx) { Some(mut f) => ChartPoint::new().set_format(&mut f), None => ChartPoint::new() }).collect();
        series.set_points(&points);
    }
    match get(sv, &["marker", "markers"]) {
        Some(Value::Bool(false)) => { let mut m = ChartMarker::new(); m.set_none(); series.set_marker(&m); }
        Some(Value::Bool(true)) => { let mut m = ChartMarker::new(); m.set_automatic(); series.set_marker(&m); }
        Some(Value::String(t)) => { let mut m = ChartMarker::new(); m.set_type(marker_type_of(t)); series.set_marker(&m); }
        Some(mo @ Value::Object(_)) => {
            let mut m = ChartMarker::new();
            if let Some(t) = str_of(mo, &["type", "shape"]) { m.set_type(marker_type_of(t)); }
            if let Some(s) = num_of(mo, &["size"]) { m.set_size(s.clamp(2.0, 72.0) as u8); }
            if let Some(mut f) = chart_format_of(mo, ctx) { m.set_format(&mut f); }
            series.set_marker(&m);
        }
        _ => {}
    }
    match get(sv, &["labels", "dataLabels", "showValues"]) {
        Some(Value::Bool(true)) => { let mut d = ChartDataLabel::new(); d.show_value(); series.set_data_label(&d); }
        Some(lo @ Value::Object(_)) => {
            let mut d = ChartDataLabel::new();
            if bool_of(lo, &["value", "values", "show"]).unwrap_or(true) { d.show_value(); }
            if bool_of(lo, &["category", "categoryName"]) == Some(true) { d.show_category_name(); }
            if bool_of(lo, &["series", "seriesName"]) == Some(true) { d.show_series_name(); }
            if bool_of(lo, &["percent", "percentage"]) == Some(true) { d.show_percentage(); }
            if let Some(nf) = str_of(lo, &["numFmt", "format"]) { d.set_num_format(num_format_of(nf)); }
            if let Some(f) = get(lo, &["font"]) { d.set_font(&chart_font_of(f)); }
            if let Some(p) = str_of(lo, &["position"]) {
                use ChartDataLabelPosition::*;
                d.set_position(match p.to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() { "center" => Center, "right" => Right, "left" => Left, "above" | "top" => Above, "below" | "bottom" => Below, "insidebase" => InsideBase, "insideend" => InsideEnd, "outsideend" => OutsideEnd, "bestfit" => BestFit, _ => Default });
            }
            series.set_data_label(&d);
        }
        _ => {}
    }
    match get(sv, &["trendline", "trend"]) {
        Some(Value::String(t)) => { let mut tl = ChartTrendline::new(); tl.set_type(trendline_type_of(t, None)); series.set_trendline(&tl); }
        Some(Value::Bool(true)) => { let mut tl = ChartTrendline::new(); tl.set_type(ChartTrendlineType::Linear); series.set_trendline(&tl); }
        Some(to @ Value::Object(_)) => {
            let mut tl = ChartTrendline::new();
            tl.set_type(trendline_type_of(str_of(to, &["type"]).unwrap_or("linear"), num_of(to, &["order", "period"]).map(|x| x as u8)));
            if let Some(n) = str_of(to, &["name"]) { tl.set_name(n); }
            if bool_of(to, &["equation", "displayEquation"]) == Some(true) { tl.display_equation(true); }
            if bool_of(to, &["r2", "rSquared", "displayR2"]) == Some(true) { tl.display_r_squared(true); }
            if let Some(x) = num_of(to, &["forward"]) { tl.set_forward_period(x); }
            if let Some(x) = num_of(to, &["backward"]) { tl.set_backward_period(x); }
            if let Some(mut f) = chart_format_of(to, ctx) { tl.set_format(&mut f); }
            series.set_trendline(&tl);
        }
        _ => {}
    }
    if bool_of(sv, &["secondaryAxis", "y2", "secondary"]) == Some(true) { series.set_secondary_axis(true); }
    if let Some(b) = bool_of(sv, &["smooth"]) { series.set_smooth(b); }
    if let Some(g) = num_of(sv, &["gap"]) { series.set_gap(g.clamp(0.0, 500.0) as u16); }
    if let Some(o) = num_of(sv, &["overlap"]) { series.set_overlap(o.clamp(-100.0, 100.0) as i8); }
    if bool_of(sv, &["invertIfNegative"]) == Some(true) { series.set_invert_if_negative(); }
    Ok(())
}

fn marker_type_of(t: &str) -> ChartMarkerType {
    match t.trim().to_ascii_lowercase().as_str() {
        "square" => ChartMarkerType::Square, "diamond" => ChartMarkerType::Diamond, "triangle" => ChartMarkerType::Triangle, "x" | "cross" => ChartMarkerType::X,
        "star" => ChartMarkerType::Star, "dash" | "shortdash" => ChartMarkerType::ShortDash, "longdash" => ChartMarkerType::LongDash, "plus" | "plussign" => ChartMarkerType::PlusSign,
        _ => ChartMarkerType::Circle,
    }
}
fn trendline_type_of(t: &str, order: Option<u8>) -> ChartTrendlineType {
    match t.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "exponential" | "exp" => ChartTrendlineType::Exponential, "log" | "logarithmic" => ChartTrendlineType::Logarithmic,
        "poly" | "polynomial" => ChartTrendlineType::Polynomial(order.unwrap_or(2).clamp(2, 6)), "power" => ChartTrendlineType::Power,
        "movingaverage" | "moving" | "ma" => ChartTrendlineType::MovingAverage(order.unwrap_or(2).max(2)), "none" => ChartTrendlineType::None,
        _ => ChartTrendlineType::Linear,
    }
}

/// 一份图表规格 → Chart（不含插入位置）。
fn build_chart(cv: &Value, sheet_name: &str, ctx: &mut Ctx) -> Result<Chart, String> {
    let kind = str_of(cv, &["type", "kind"]).unwrap_or("column");
    let ct = chart_type_of(kind).ok_or_else(|| format!("图表 type 不认识：{kind}（column/bar/line/area/pie/doughnut/scatter/radar/stock 及其 stacked / percentStacked 变体）"))?;
    let mut chart = Chart::new(ct);
    let series = arr_of(cv, &["series"]).cloned().unwrap_or_default();
    if series.is_empty() { return Err("图表需要 series[]（每个含 values，可选 categories/name）".into()); }
    for sv in &series { apply_series(&mut chart, sv, sheet_name, ctx)?; }
    match get(cv, &["title"]) {
        Some(Value::String(t)) => { chart.title().set_name(t); }
        Some(Value::Bool(false)) => { chart.title().set_hidden(); }
        Some(to @ Value::Object(_)) => { if let Some(t) = str_of(to, &["text", "name"]) { chart.title().set_name(t); } if let Some(f) = get(to, &["font"]) { chart.title().set_font(&chart_font_of(f)); } if bool_of(to, &["overlay"]) == Some(true) { chart.title().set_overlay(true); } }
        _ => { chart.title().set_hidden(); }
    }
    if let Some(a) = get(cv, &["xAxis", "x", "categoryAxis"]) { apply_axis(chart.x_axis(), a, ctx); }
    if let Some(a) = get(cv, &["yAxis", "y", "valueAxis"]) { apply_axis(chart.y_axis(), a, ctx); }
    if let Some(a) = get(cv, &["y2Axis", "y2", "secondaryAxis"]) { apply_axis(chart.y2_axis(), a, ctx); }
    match get(cv, &["legend"]) {
        Some(Value::Bool(false)) => { chart.legend().set_hidden(); }
        Some(Value::String(p)) if p.eq_ignore_ascii_case("none") => { chart.legend().set_hidden(); }
        Some(Value::String(p)) => { chart.legend().set_position(legend_pos_of(p)); }
        Some(lo @ Value::Object(_)) => { if let Some(p) = str_of(lo, &["position"]) { if p.eq_ignore_ascii_case("none") { chart.legend().set_hidden(); } else { chart.legend().set_position(legend_pos_of(p)); } } if let Some(f) = get(lo, &["font"]) { chart.legend().set_font(&chart_font_of(f)); } if bool_of(lo, &["overlay"]) == Some(true) { chart.legend().set_overlay(true); } if let Some(del) = arr_of(lo, &["delete", "hide"]) { let idx: Vec<usize> = del.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect(); chart.legend().delete_entries(&idx); } }
        _ => {}
    }
    if let Some(s) = num_of(cv, &["style"]) { chart.set_style(s.clamp(1.0, 48.0) as u8); }
    if let Some(h) = num_of(cv, &["holeSize", "hole"]) { chart.set_hole_size(h.clamp(10.0, 90.0) as u8); }
    if let Some(r) = num_of(cv, &["rotation", "startAngle"]) { chart.set_rotation(r.clamp(0.0, 360.0) as u16); }
    if let Some(w) = num_of(cv, &["width", "w"]) { chart.set_width(w.max(50.0) as u32); }
    if let Some(h) = num_of(cv, &["height", "h"]) { chart.set_height(h.max(50.0) as u32); }
    if bool_of(cv, &["dataTable", "table"]) == Some(true) { chart.set_data_table(&ChartDataTable::new()); }
    if let Some(f) = get(cv, &["chartArea", "background"]) { if let Some(mut cf) = chart_format_of(f, ctx) { chart.chart_area().set_format(&mut cf); } }
    if let Some(f) = get(cv, &["plotArea"]) { if let Some(mut cf) = chart_format_of(f, ctx) { chart.plot_area().set_format(&mut cf); } }
    if bool_of(cv, &["upDownBars"]) == Some(true) { chart.set_up_down_bars(true); }
    if bool_of(cv, &["highLowLines"]) == Some(true) { chart.set_high_low_lines(true); }
    if bool_of(cv, &["dropLines"]) == Some(true) { chart.set_drop_lines(true); }
    if let Some(alt) = str_of(cv, &["alt", "altText"]) { chart.set_alt_text(alt); }
    // 组合图：combine:{type, series:[...]}（第二张图叠在同一坐标系；系列可挂 secondaryAxis）
    if let Some(combo) = get(cv, &["combine", "combo", "overlay"]) {
        let mut second = build_chart(combo, sheet_name, ctx)?;
        if get(combo, &["title"]).is_none() { second.title().set_hidden(); }
        chart.combine(&second);
    }
    Ok(chart)
}

fn legend_pos_of(p: &str) -> ChartLegendPosition {
    match p.trim().to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() {
        "left" => ChartLegendPosition::Left, "top" => ChartLegendPosition::Top, "bottom" => ChartLegendPosition::Bottom, "topright" => ChartLegendPosition::TopRight, _ => ChartLegendPosition::Right,
    }
}

fn apply_chart(ws: &mut Worksheet, cv: &Value, sheet_name: &str, ctx: &mut Ctx) -> Result<(), String> {
    let chart = build_chart(cv, sheet_name, ctx)?;
    let (row, col) = anchor_of(cv).unwrap_or((1, 6));
    match get(cv, &["offset"]) {
        Some(o) => { let x = num_of(o, &["x"]).unwrap_or(0.0).max(0.0) as u32; let y = num_of(o, &["y"]).unwrap_or(0.0).max(0.0) as u32; xerr(ws.insert_chart_with_offset(row, col, &chart, x, y))?; }
        None => { xerr(ws.insert_chart(row, col, &chart))?; }
    }
    Ok(())
}

/// 锚点：at:"H2" 或 row/col（1 起）
fn anchor_of(v: &Value) -> Option<(RowNum, ColNum)> {
    if let Some(a) = str_of(v, &["at", "anchor", "cell", "position"]) { return parse_cell(a); }
    let row = get(v, &["row"]).and_then(parse_row)?;
    let col = get(v, &["col", "column"]).and_then(parse_col)?;
    Some((row, col))
}

// ── 图片 / 迷你图 / 批注 / 文本框 / 复选框 ────────────────────────────────

fn load_image(src: &str, ctx: &mut Ctx) -> Result<Image, String> {
    use base64::Engine as _;
    let s = src.trim();
    let bytes: Vec<u8> = if let Some(rest) = s.strip_prefix("data:") {
        let b64 = rest.split_once(",").map(|x| x.1).ok_or("data URL 缺少逗号")?;
        base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("图片 base64 解码失败: {e}"))?
    } else if s.len() > 200 && !s.contains('/') && !s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '=' || c == '\n') {
        base64::engine::general_purpose::STANDARD.decode(s.replace('\n', "")).map_err(|e| format!("图片 base64 解码失败: {e}"))?
    } else if s.starts_with("http://") || s.starts_with("https://") {
        return Err(format!("图片 {s} 是网址：先用 download_file 存进工作区再引用"));
    } else {
        let p = Path::new(s);
        let abs = if p.is_absolute() { p.to_path_buf() } else { ctx.root.join(p) };
        let resolved = crate::files::require_inside_workspace(&abs.to_string_lossy(), false)?;
        std::fs::read(&resolved).map_err(|e| format!("读不到图片 {}: {e}", resolved.display()))?
    };
    Image::new_from_buffer(&bytes).map_err(|e| format!("图片 {} 无法识别: {e}", s.chars().take(60).collect::<String>()))
}

fn apply_image(ws: &mut Worksheet, iv: &Value, ctx: &mut Ctx) -> Result<(), String> {
    let src = str_of(iv, &["src", "path", "file", "image"]).ok_or("images[] 需要 src（工作区路径或 data URL）")?;
    let mut img = load_image(src, ctx)?;
    let (w, h) = (num_of(iv, &["width", "w"]), num_of(iv, &["height", "h"]));
    match (w, h) {
        (Some(w), Some(h)) => img = img.set_scale_to_size(w, h, bool_of(iv, &["keepAspect", "keepAspectRatio"]).unwrap_or(true)),
        (Some(w), None) => { let s = w / img.width().max(1.0); img = img.set_scale_width(s).set_scale_height(s); }
        (None, Some(h)) => { let s = h / img.height().max(1.0); img = img.set_scale_width(s).set_scale_height(s); }
        (None, None) => { if let Some(s) = num_of(iv, &["scale"]) { img = img.set_scale_width(s).set_scale_height(s); } }
    }
    if let Some(alt) = str_of(iv, &["alt", "altText", "description"]) { img = img.set_alt_text(alt); }
    let (row, col) = anchor_of(iv).unwrap_or((0, 0));
    if bool_of(iv, &["embed", "inCell"]) == Some(true) { return xerr(ws.embed_image(row, col, &img)).map(|_| ()); }
    if bool_of(iv, &["fitToCell", "fit"]) == Some(true) { return xerr(ws.insert_image_fit_to_cell(row, col, &img, bool_of(iv, &["keepAspect", "keepAspectRatio"]).unwrap_or(true))).map(|_| ()); }
    match get(iv, &["offset"]) {
        Some(o) => xerr(ws.insert_image_with_offset(row, col, &img, num_of(o, &["x"]).unwrap_or(0.0).max(0.0) as u32, num_of(o, &["y"]).unwrap_or(0.0).max(0.0) as u32)).map(|_| ()),
        None => xerr(ws.insert_image(row, col, &img)).map(|_| ()),
    }
}

fn apply_sparkline(ws: &mut Worksheet, sv: &Value, sheet_name: &str, ctx: &mut Ctx) -> Result<(), String> {
    let (row, col) = anchor_of(sv).ok_or("sparklines[] 需要 at（放在哪个格子）")?;
    let range = get(sv, &["range", "data", "values"]).ok_or("sparklines[] 需要 range（数据区，如 \"B2:G2\"）")?;
    let cr = chart_range(range, sheet_name, ctx)?;
    let mut sp = Sparkline::new().set_range(&cr);
    if let Some(t) = str_of(sv, &["type", "kind"]) { sp = sp.set_type(match t.to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() { "column" | "bar" => SparklineType::Column, "winlose" | "winloss" => SparklineType::WinLose, _ => SparklineType::Line }); }
    if let Some(c) = str_of(sv, &["color"]).and_then(color_of) { sp = sp.set_sparkline_color(c); }
    for (key, on) in [("high", 0), ("low", 1), ("first", 2), ("last", 3), ("negative", 4), ("markers", 5), ("axis", 6)] {
        if bool_of(sv, &[key]) == Some(true) {
            sp = match on { 0 => sp.show_high_point(true), 1 => sp.show_low_point(true), 2 => sp.show_first_point(true), 3 => sp.show_last_point(true), 4 => sp.show_negative_points(true), 5 => sp.show_markers(true), _ => sp.show_axis(true) };
        }
    }
    if let Some(c) = str_of(sv, &["highColor"]).and_then(color_of) { sp = sp.set_high_point_color(c); }
    if let Some(c) = str_of(sv, &["lowColor"]).and_then(color_of) { sp = sp.set_low_point_color(c); }
    if let Some(c) = str_of(sv, &["negativeColor"]).and_then(color_of) { sp = sp.set_negative_points_color(c); }
    if let Some(c) = str_of(sv, &["markersColor"]).and_then(color_of) { sp = sp.set_markers_color(c); }
    if let Some(w) = num_of(sv, &["lineWeight", "weight"]) { sp = sp.set_line_weight(w); }
    if let Some(s) = num_of(sv, &["style"]) { sp = sp.set_style(s.clamp(1.0, 36.0) as u8); }
    if let Some(x) = num_of(sv, &["max"]) { sp = sp.set_custom_max(x); }
    if let Some(x) = num_of(sv, &["min"]) { sp = sp.set_custom_min(x); }
    if bool_of(sv, &["rtl", "rightToLeft"]) == Some(true) { sp = sp.set_right_to_left(true); }
    xerr(ws.add_sparkline(row, col, &sp)).map(|_| ())
}

fn apply_note(ws: &mut Worksheet, nv: &Value) -> Result<(), String> {
    let (row, col) = anchor_of(nv).ok_or("notes[] 需要 at")?;
    let text = str_of(nv, &["text", "note", "comment"]).ok_or("notes[] 需要 text")?;
    let mut n = Note::new(text);
    if let Some(a) = str_of(nv, &["author"]) { n = n.set_author(a); }
    if bool_of(nv, &["visible", "show"]) == Some(true) { n = n.set_visible(true); }
    if let Some(w) = num_of(nv, &["width"]) { n = n.set_width(w.max(20.0) as u32); }
    if let Some(h) = num_of(nv, &["height"]) { n = n.set_height(h.max(20.0) as u32); }
    if let Some(c) = str_of(nv, &["background", "fill"]).and_then(color_of) { n = n.set_background_color(c); }
    if let Some(f) = str_of(nv, &["font"]) { n = n.set_font_name(f); }
    if let Some(s) = num_of(nv, &["size", "fontSize"]) { n = n.set_font_size(s); }
    xerr(ws.insert_note(row, col, &n)).map(|_| ())
}

fn apply_shape(ws: &mut Worksheet, sv: &Value, ctx: &mut Ctx) -> Result<(), String> {
    let (row, col) = anchor_of(sv).ok_or("shapes[] 需要 at")?;
    let mut shape = Shape::textbox();
    if let Some(t) = str_of(sv, &["text"]) { shape = shape.set_text(t); }
    if let Some(l) = str_of(sv, &["textLink", "link"]) { if l.starts_with('=') { shape = shape.set_text_link(Formula::new(l)); } }
    if let Some(w) = num_of(sv, &["width", "w"]) { shape = shape.set_width(w.max(10.0) as u32); }
    if let Some(h) = num_of(sv, &["height", "h"]) { shape = shape.set_height(h.max(10.0) as u32); }
    let mut sf = ShapeFormat::new();
    let mut any = false;
    if let Some(c) = str_of(sv, &["fill", "background"]) { match color_of(c) { Some(col) => { let mut f = ShapeSolidFill::new().set_color(col); if let Some(t) = num_of(sv, &["transparency"]) { f = f.set_transparency(t.clamp(0.0, 100.0) as u8); } sf = sf.set_solid_fill(&f); any = true; } None => ctx.warnings.push(format!("文本框填充色不认识：{c}")) } }
    if bool_of(sv, &["noFill"]) == Some(true) { sf = sf.set_no_fill(); any = true; }
    match get(sv, &["line", "border"]) {
        Some(Value::String(c)) => { if let Some(col) = color_of(c) { sf = sf.set_line(&ShapeLine::new().set_color(col)); any = true; } }
        Some(lo @ Value::Object(_)) => { let mut l = ShapeLine::new(); if let Some(col) = str_of(lo, &["color"]).and_then(color_of) { l = l.set_color(col); } if let Some(w) = num_of(lo, &["width"]) { l = l.set_width(w); } sf = sf.set_line(&l); any = true; }
        Some(Value::Bool(false)) => { sf = sf.set_no_line(); any = true; }
        _ => {}
    }
    if any { shape = shape.set_format(&sf); }
    if let Some(fv) = get(sv, &["font"]) {
        let mut font = ShapeFont::new();
        if bool_of(fv, &["bold"]) == Some(true) { font = font.set_bold(); }
        if bool_of(fv, &["italic"]) == Some(true) { font = font.set_italic(); }
        if let Some(c) = str_of(fv, &["color"]).and_then(color_of) { font = font.set_color(c); }
        if let Some(n) = str_of(fv, &["name", "font"]) { font = font.set_name(n); }
        if let Some(s) = num_of(fv, &["size"]) { font = font.set_size(s); }
        shape = shape.set_font(&font);
    } else if let Some(s) = num_of(sv, &["fontSize", "size"]) {
        let mut font = ShapeFont::new().set_size(s);
        if bool_of(sv, &["bold"]) == Some(true) { font = font.set_bold(); }
        if let Some(c) = str_of(sv, &["color"]).and_then(color_of) { font = font.set_color(c); }
        shape = shape.set_font(&font);
    }
    let (h, v) = (str_of(sv, &["align"]), str_of(sv, &["valign"]));
    if h.is_some() || v.is_some() {
        let mut t = ShapeText::new();
        if let Some(h) = h { t = t.set_horizontal_alignment(match h.to_ascii_lowercase().as_str() { "left" => ShapeTextHorizontalAlignment::Left, "center" | "middle" => ShapeTextHorizontalAlignment::Center, "right" => ShapeTextHorizontalAlignment::Right, _ => ShapeTextHorizontalAlignment::Default }); }
        if let Some(v) = v { t = t.set_vertical_alignment(match v.to_ascii_lowercase().as_str() { "middle" | "center" => ShapeTextVerticalAlignment::Middle, "bottom" => ShapeTextVerticalAlignment::Bottom, _ => ShapeTextVerticalAlignment::Top }); }
        shape = shape.set_text_options(&t);
    }
    if let Some(u) = str_of(sv, &["url"]) { shape = shape.set_url(Url::new(u)).map_err(|e| e.to_string())?; }
    xerr(ws.insert_shape(row, col, &shape)).map(|_| ())
}

// ── 页面设置 / 页眉页脚 / 保护 ──────────────────────────────────────────────

fn paper_size_of(v: &Value) -> Option<u8> {
    match v {
        Value::Number(n) => n.as_u64().map(|x| x.min(255) as u8),
        Value::String(s) => Some(match s.trim().to_ascii_lowercase().as_str() { "letter" => 1, "tabloid" => 3, "legal" => 5, "a3" => 8, "a4" => 9, "a5" => 11, "b4" => 12, "b5" => 13, "executive" => 7, other => other.parse::<u8>().ok()? }),
        _ => None,
    }
}

/// {PAGE} {PAGES} {DATE} {TIME} {FILE} {SHEET} {PATH} → Excel 控制码；{left,center,right} 三段拼成一串。
fn header_footer_text(v: &Value) -> Option<String> {
    let tok = |s: &str| s.replace("{PAGE}", "&P").replace("{PAGES}", "&N").replace("{DATE}", "&D").replace("{TIME}", "&T").replace("{FILE}", "&F").replace("{SHEET}", "&A").replace("{PATH}", "&Z");
    match v {
        Value::String(s) => Some(tok(s)),
        Value::Object(_) => {
            let mut out = String::new();
            if let Some(l) = str_of(v, &["left", "l"]) { out.push_str("&L"); out.push_str(&tok(l)); }
            if let Some(c) = str_of(v, &["center", "c", "middle"]) { out.push_str("&C"); out.push_str(&tok(c)); }
            if let Some(r) = str_of(v, &["right", "r"]) { out.push_str("&R"); out.push_str(&tok(r)); }
            if out.is_empty() { None } else { Some(out) }
        }
        _ => None,
    }
}

fn apply_page_setup(ws: &mut Worksheet, ps: &Value, ctx: &mut Ctx) -> Result<(), String> {
    if let Some(o) = str_of(ps, &["orientation"]) { if o.eq_ignore_ascii_case("landscape") { ws.set_landscape(); } else { ws.set_portrait(); } }
    if bool_of(ps, &["landscape"]) == Some(true) { ws.set_landscape(); }
    if let Some(p) = get(ps, &["paper", "paperSize"]) { match paper_size_of(p) { Some(n) => { ws.set_paper_size(n); } None => ctx.warnings.push(format!("纸张不认识：{p}")) } }
    if let Some(m) = get(ps, &["margins"]) {
        let g = |k: &[&str], d: f64| num_of(m, k).unwrap_or(d);
        ws.set_margins(g(&["left"], 0.7), g(&["right"], 0.7), g(&["top"], 0.75), g(&["bottom"], 0.75), g(&["header"], 0.3), g(&["footer"], 0.3));
    }
    match get(ps, &["fitToPages", "fitTo"]) {
        Some(Value::Array(a)) => { ws.set_print_fit_to_pages(a.first().and_then(f64_of).unwrap_or(1.0) as u16, a.get(1).and_then(f64_of).unwrap_or(0.0) as u16); }
        Some(o @ Value::Object(_)) => { ws.set_print_fit_to_pages(num_of(o, &["width", "w"]).unwrap_or(1.0) as u16, num_of(o, &["height", "h"]).unwrap_or(0.0) as u16); }
        Some(Value::Bool(true)) => { ws.set_print_fit_to_pages(1, 0); }
        Some(Value::Number(n)) => { ws.set_print_fit_to_pages(n.as_f64().unwrap_or(1.0) as u16, 0); }
        _ => {}
    }
    if let Some(s) = num_of(ps, &["scale"]) { ws.set_print_scale(s.clamp(10.0, 400.0) as u16); }
    if let Some(b) = bool_of(ps, &["centerH", "centerHorizontally"]) { ws.set_print_center_horizontally(b); }
    if let Some(b) = bool_of(ps, &["centerV", "centerVertically"]) { ws.set_print_center_vertically(b); }
    if let Some(b) = bool_of(ps, &["printGridlines", "gridlines"]) { ws.set_print_gridlines(b); }
    if let Some(b) = bool_of(ps, &["printHeadings", "headings"]) { ws.set_print_headings(b); }
    if let Some(b) = bool_of(ps, &["blackAndWhite"]) { ws.set_print_black_and_white(b); }
    if let Some(b) = bool_of(ps, &["draft"]) { ws.set_print_draft(b); }
    if let Some(n) = num_of(ps, &["firstPageNumber"]) { ws.set_print_first_page_number(n.max(0.0) as u16); }
    if let Some(a) = str_of(ps, &["printArea", "area"]) { let (_, r0, c0, r1, c1) = parse_range(a).ok_or_else(|| format!("打印区域不合法：{a}"))?; xerr(ws.set_print_area(r0, c0, r1, c1))?; }
    match get(ps, &["repeatRows", "titleRows"]) {
        Some(Value::Array(a)) if !a.is_empty() => { let r0 = parse_row(&a[0]).ok_or("repeatRows 行号不合法")?; let r1 = a.get(1).and_then(parse_row).unwrap_or(r0); xerr(ws.set_repeat_rows(r0, r1))?; }
        Some(v @ Value::Number(_)) => { let r = parse_row(v).ok_or("repeatRows 行号不合法")?; xerr(ws.set_repeat_rows(r, r))?; }
        Some(Value::String(s)) => { let parts: Vec<&str> = s.split([':', '-']).collect(); let r0 = parse_row(&Value::String(parts[0].to_string())).ok_or("repeatRows 不合法")?; let r1 = parts.get(1).and_then(|x| parse_row(&Value::String(x.to_string()))).unwrap_or(r0); xerr(ws.set_repeat_rows(r0, r1))?; }
        _ => {}
    }
    if let Some(s) = str_of(ps, &["repeatColumns", "titleColumns"]) { let parts: Vec<&str> = s.split([':', '-']).collect(); let c0 = parse_col(&Value::String(parts[0].to_string())).ok_or("repeatColumns 不合法")?; let c1 = parts.get(1).and_then(|x| parse_col(&Value::String(x.to_string()))).unwrap_or(c0); xerr(ws.set_repeat_columns(c0, c1))?; }
    if let Some(a) = arr_of(ps, &["pageBreaks", "breaks"]) { let rows: Vec<RowNum> = a.iter().filter_map(parse_row).collect(); if !rows.is_empty() { xerr(ws.set_page_breaks(&rows))?; } }
    if let Some(v) = str_of(ps, &["view"]) { match v.to_ascii_lowercase().as_str() { "pagelayout" | "layout" => { ws.set_view_page_layout(); } "pagebreak" | "pagebreakpreview" => { ws.set_view_page_break_preview(); } _ => {} } }
    Ok(())
}

fn apply_protection(ws: &mut Worksheet, pv: &Value) -> Result<(), String> {
    let (password, opts) = match pv {
        Value::Bool(true) => (None, None),
        Value::String(pw) => (Some(pw.as_str()), None),
        Value::Object(_) => (str_of(pv, &["password"]), get(pv, &["options", "allow"]).or(Some(pv))),
        _ => return Ok(()),
    };
    if let Some(o) = opts {
        let b = |k: &[&str], d: bool| bool_of(o, k).unwrap_or(d);
        let options = ProtectionOptions {
            select_locked_cells: b(&["selectLockedCells"], true),
            select_unlocked_cells: b(&["selectUnlockedCells"], true),
            format_cells: b(&["formatCells"], false),
            format_columns: b(&["formatColumns"], false),
            format_rows: b(&["formatRows"], false),
            insert_columns: b(&["insertColumns"], false),
            insert_rows: b(&["insertRows"], false),
            insert_links: b(&["insertLinks", "insertHyperlinks"], false),
            delete_columns: b(&["deleteColumns"], false),
            delete_rows: b(&["deleteRows"], false),
            sort: b(&["sort"], false),
            use_autofilter: b(&["autofilter", "useAutofilter", "filter"], false),
            use_pivot_tables: b(&["pivotTables", "usePivotTables"], false),
            edit_scenarios: b(&["editScenarios"], false),
            edit_objects: b(&["editObjects", "objects"], false),
            contents: b(&["contents"], true),
            ..Default::default()
        };
        ws.protect_with_options(&options);
    } else {
        ws.protect();
    }
    if let Some(pw) = password { ws.protect_with_password(pw); }
    if let Some(a) = arr_of(pv, &["unprotectRanges", "unlockedRanges"]) {
        for r in a { if let Some(s) = r.as_str() { let (_, r0, c0, r1, c1) = parse_range(s).ok_or_else(|| format!("unprotectRanges 范围不合法：{s}"))?; xerr(ws.unprotect_range(r0, c0, r1, c1))?; } }
    }
    Ok(())
}

// ── 工作表 / 工作簿 装配 ─────────────────────────────────────────────────────

const SHEET_KEYS: &[&str] = &[
    "name", "columns", "header", "headerStyle", "rows", "startRow", "cells", "styleRanges", "merges", "widths", "heights",
    "defaultRowHeight", "hiddenCols", "hiddenRows", "groupRows", "groupCols", "freeze", "autoFilter", "autofilter", "filters",
    "tables", "conditionalFormats", "validations", "charts", "images", "sparklines", "notes", "shapes", "checkboxes",
    "pageSetup", "header_footer", "headerFooter", "protect", "tabColor", "zoom", "gridlines", "rtl", "active", "hidden",
    "selection", "autofit", "unprotectRanges", "style", "hyperlinks", "outlineSymbols",
];

fn sanitize_sheet_name(raw: &str, idx: usize, taken: &[String]) -> String {
    let mut name: String = raw.chars().filter(|c| !matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\')).collect::<String>().trim().trim_matches('\'').to_string();
    if name.is_empty() { name = format!("Sheet{}", idx + 1); }
    if name.chars().count() > 31 { name = name.chars().take(31).collect(); }
    let base = name.clone();
    let mut n = 2;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&name)) {
        let suffix = format!(" ({n})");
        let keep = 31usize.saturating_sub(suffix.chars().count());
        name = format!("{}{}", base.chars().take(keep).collect::<String>(), suffix);
        n += 1;
    }
    name
}

fn build_sheet(sheet: &Value, idx: usize, name: &str, ctx: &mut Ctx) -> Result<Worksheet, String> {
    let mut ws = Worksheet::new();
    xerr(ws.set_name(name))?;
    if let Value::Object(o) = sheet {
        for k in o.keys() { if !SHEET_KEYS.contains(&k.as_str()) { ctx.warnings.push(format!("工作表「{name}」里不认识的字段被忽略：{k}")); } }
    }
    let mut written: HashMap<(RowNum, ColNum), String> = HashMap::new();
    // 1. 合并（先合并，后面的 rows/cells 可以覆盖左上角的值）
    if let Some(ms) = arr_of(sheet, &["merges"]) {
        for m in ms {
            let (range, text, fmt) = match m {
                Value::String(r) => (r.as_str(), "", None),
                Value::Object(_) => (str_of(m, &["range", "ref"]).ok_or("merges[] 对象需要 range")?, str_of(m, &["text", "value"]).unwrap_or(""), maybe_format(m, ctx)),
                other => return Err(format!("merges[] 形状不认识：{other}")),
            };
            let (_, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("合并范围不合法：{range}"))?;
            if r0 == r1 && c0 == c1 { ctx.warnings.push(format!("合并范围只有一个格子，跳过：{range}")); continue; }
            xerr(ws.merge_range(r0, c0, r1, c1, text, &fmt.unwrap_or_else(|| ctx.base.clone())))?;
            if !text.is_empty() { written.insert((r0, c0), text.to_string()); }
        }
    }
    // 2. 列 + 表头
    let start_row_spec = get(sheet, &["startRow"]).and_then(parse_row);
    let header_row = start_row_spec.unwrap_or(0);
    let mut defs: Vec<ColDef> = Vec::new();
    let mut data_start = header_row;
    let mut cols_spec: Vec<Value> = arr_of(sheet, &["columns"]).cloned().unwrap_or_default();
    let rows_spec: Vec<Value> = arr_of(sheet, &["rows", "data"]).cloned().unwrap_or_default();
    // 没写 columns 但行是对象：用第一行的键当列
    if cols_spec.is_empty() { if let Some(Value::Object(first)) = rows_spec.first() { cols_spec = first.keys().map(|k| Value::String(k.clone())).collect(); } }
    if !cols_spec.is_empty() {
        let (d, used) = apply_columns(&mut ws, sheet, &cols_spec, header_row, ctx, &mut written)?;
        defs = d;
        data_start = header_row + used;
    }
    // 3. 行
    let mut last_data_row: Option<RowNum> = None;
    if !rows_spec.is_empty() { last_data_row = apply_rows(&mut ws, &rows_spec, data_start, &defs, ctx, &mut written)?; }
    let data_end = last_data_row.unwrap_or(data_start);
    let ncols_data = defs.len().max(rows_spec.iter().map(|r| match r { Value::Array(a) => a.len(), Value::Object(o) => o.get("values").or(o.get("cells")).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(o.len()), _ => 1 }).max().unwrap_or(0));
    // 4. 稀疏格子
    if let Some(cells) = obj_of(sheet, &["cells"]) {
        for (addr, v) in cells {
            let (row, col) = parse_cell(addr).ok_or_else(|| format!("cells 里的地址不合法：{addr}"))?;
            write_cell(&mut ws, row, col, v, None, ctx)?;
            if let Value::String(s) = v { written.insert((row, col), s.clone()); }
        }
    }
    // 5. 区域样式 / 列宽 / 行高 / 隐藏 / 分组
    if let Some(sr) = obj_of(sheet, &["styleRanges"]) {
        for (range, st) in sr {
            let (_, r0, c0, r1, c1) = parse_range(range).ok_or_else(|| format!("styleRanges 范围不合法：{range}"))?;
            let f = format_of(&match st { Value::String(n) => serde_json::json!({ "style": n }), o => o.clone() }, ctx);
            xerr(ws.set_range_format(r0, c0, r1, c1, &f))?;
        }
    }
    if let Some(w) = obj_of(sheet, &["widths"]) {
        for (k, v) in w {
            let width = f64_of(v).ok_or_else(|| format!("列宽不是数字：{k}"))?;
            if let Some((a, b)) = k.split_once(':') { let c0 = parse_col(&Value::String(a.into())).ok_or_else(|| format!("列不合法：{k}"))?; let c1 = parse_col(&Value::String(b.into())).ok_or_else(|| format!("列不合法：{k}"))?; xerr(ws.set_column_range_width(c0.min(c1), c0.max(c1), width))?; }
            else { let c = parse_col(&Value::String(k.clone())).ok_or_else(|| format!("列不合法：{k}"))?; xerr(ws.set_column_width(c, width))?; }
        }
    }
    if let Some(h) = obj_of(sheet, &["heights"]) {
        for (k, v) in h { let r = parse_row(&Value::String(k.clone())).ok_or_else(|| format!("行号不合法：{k}"))?; xerr(ws.set_row_height(r, f64_of(v).ok_or_else(|| format!("行高不是数字：{k}"))?))?; }
    }
    if let Some(d) = num_of(sheet, &["defaultRowHeight"]) { ws.set_default_row_height(d); }
    if let Some(a) = arr_of(sheet, &["hiddenCols"]) { for c in a { if let Some(col) = parse_col(c) { xerr(ws.set_column_hidden(col))?; } } }
    if let Some(a) = arr_of(sheet, &["hiddenRows"]) { for r in a { if let Some(row) = parse_row(r) { xerr(ws.set_row_hidden(row))?; } } }
    if let Some(groups) = arr_of(sheet, &["groupRows"]) {
        for g in groups {
            let (a, b, collapsed) = match g { Value::Array(p) if p.len() >= 2 => (parse_row(&p[0]), parse_row(&p[1]), p.get(2).and_then(|x| x.as_bool()).unwrap_or(false)), Value::Object(_) => (get(g, &["from", "start"]).and_then(parse_row), get(g, &["to", "end"]).and_then(parse_row), bool_of(g, &["collapsed"]).unwrap_or(false)), _ => (None, None, false) };
            let (Some(a), Some(b)) = (a, b) else { ctx.warnings.push(format!("groupRows 项不合法：{g}")); continue; };
            xerr(if collapsed { ws.group_rows_collapsed(a.min(b), a.max(b)) } else { ws.group_rows(a.min(b), a.max(b)) })?;
        }
    }
    if let Some(groups) = arr_of(sheet, &["groupCols"]) {
        for g in groups {
            let (a, b, collapsed) = match g { Value::Array(p) if p.len() >= 2 => (parse_col(&p[0]), parse_col(&p[1]), p.get(2).and_then(|x| x.as_bool()).unwrap_or(false)), Value::Object(_) => (get(g, &["from", "start"]).and_then(parse_col), get(g, &["to", "end"]).and_then(parse_col), bool_of(g, &["collapsed"]).unwrap_or(false)), _ => (None, None, false) };
            let (Some(a), Some(b)) = (a, b) else { ctx.warnings.push(format!("groupCols 项不合法：{g}")); continue; };
            xerr(if collapsed { ws.group_columns_collapsed(a.min(b), a.max(b)) } else { ws.group_columns(a.min(b), a.max(b)) })?;
        }
    }
    // 6. 冻结 / 筛选
    match get(sheet, &["freeze"]) {
        Some(Value::Bool(true)) => { xerr(ws.set_freeze_panes(data_start.max(1), 0))?; }
        Some(v @ Value::Number(_)) => { let n = f64_of(v).unwrap_or(1.0).max(0.0) as RowNum; xerr(ws.set_freeze_panes(n, 0))?; }
        Some(Value::String(s)) => { let (r, c) = parse_cell(s).ok_or_else(|| format!("freeze 单元格不合法：{s}"))?; xerr(ws.set_freeze_panes(r, c))?; }
        Some(o @ Value::Object(_)) => { xerr(ws.set_freeze_panes(num_of(o, &["rows"]).unwrap_or(0.0).max(0.0) as RowNum, num_of(o, &["cols", "columns"]).unwrap_or(0.0).max(0.0) as ColNum))?; }
        _ => {}
    }
    let filter_range: Option<(RowNum, ColNum, RowNum, ColNum)> = match get(sheet, &["autoFilter", "autofilter"]) {
        Some(Value::Bool(true)) => if ncols_data > 0 { Some((header_row, 0, data_end.max(header_row), (ncols_data - 1) as ColNum)) } else { None },
        Some(Value::String(r)) => { let (_, r0, c0, r1, c1) = parse_range(r).ok_or_else(|| format!("筛选范围不合法：{r}"))?; Some((r0, c0, r1, c1)) }
        _ => None,
    };
    if let Some((r0, c0, r1, c1)) = filter_range {
        xerr(ws.autofilter(r0, c0, r1, c1))?;
        if let Some(fs) = arr_of(sheet, &["filters"]) {
            for f in fs {
                let col = get(f, &["col", "column"]).and_then(parse_col).ok_or("filters[] 需要 col")?;
                let mut cond = FilterCondition::new();
                if let Some(vals) = arr_of(f, &["values", "in"]) { for v in vals { cond = match v { Value::Number(n) => cond.add_list_filter(n.as_f64().unwrap_or(0.0)), Value::String(s) => cond.add_list_filter(s.as_str()), _ => cond }; } }
                if bool_of(f, &["blanks"]) == Some(true) { cond = cond.add_list_blanks_filter(); }
                if let Some(op) = str_of(f, &["op", "operator"]) {
                    use FilterCriteria::*;
                    let crit = match op.to_ascii_lowercase().replace(['_', ' ', '-'], "").as_str() { "eq" | "=" | "equal" | "equalto" => EqualTo, "ne" | "<>" | "!=" | "notequal" => NotEqualTo, "gt" | ">" | "greaterthan" => GreaterThan, "gte" | ">=" => GreaterThanOrEqualTo, "lt" | "<" | "lessthan" => LessThan, "lte" | "<=" => LessThanOrEqualTo, "beginswith" | "startswith" => BeginsWith, "notbeginswith" => DoesNotBeginWith, "endswith" => EndsWith, "notendswith" => DoesNotEndWith, "contains" => Contains, "notcontains" => DoesNotContain, other => return Err(format!("筛选 op 不认识：{other}")) };
                    cond = match get(f, &["value"]) { Some(Value::Number(n)) => cond.add_custom_filter(crit, n.as_f64().unwrap_or(0.0)), Some(Value::String(s)) => cond.add_custom_filter(crit, s.as_str()), _ => return Err("filters[] 带 op 时需要 value".into()) };
                }
                xerr(ws.filter_column(col, &cond))?;
            }
        }
    } else if get(sheet, &["filters"]).is_some() { ctx.warnings.push("filters 需要先开 autoFilter（true 或范围）".into()); }
    // 7. 表格 / 条件格式 / 验证 / 图表 / 图片 / 迷你图 / 批注 / 文本框 / 复选框
    if let Some(ts) = arr_of(sheet, &["tables"]) { for t in ts { apply_table(&mut ws, t, &written, ctx)?; } }
    if let Some(cfs) = arr_of(sheet, &["conditionalFormats"]) { for cf in cfs { apply_conditional_format(&mut ws, cf, ctx)?; } }
    if let Some(vs) = arr_of(sheet, &["validations"]) { for v in vs { apply_validation(&mut ws, v, ctx)?; } }
    if let Some(cs) = arr_of(sheet, &["charts"]) { for c in cs { apply_chart(&mut ws, c, name, ctx)?; } }
    if let Some(is) = arr_of(sheet, &["images"]) { for i in is { apply_image(&mut ws, i, ctx)?; } }
    if let Some(ss) = arr_of(sheet, &["sparklines"]) { for s in ss { apply_sparkline(&mut ws, s, name, ctx)?; } }
    if let Some(ns) = arr_of(sheet, &["notes"]) { for n in ns { apply_note(&mut ws, n)?; } }
    if let Some(ss) = arr_of(sheet, &["shapes"]) { for s in ss { apply_shape(&mut ws, s, ctx)?; } }
    if let Some(cs) = arr_of(sheet, &["checkboxes"]) { for c in cs { let (row, col) = anchor_of(c).ok_or("checkboxes[] 需要 at")?; xerr(ws.insert_checkbox(row, col, bool_of(c, &["checked", "value"]).unwrap_or(false)))?; } }
    if let Some(hs) = arr_of(sheet, &["hyperlinks"]) { for h in hs { let (row, col) = anchor_of(h).ok_or("hyperlinks[] 需要 at")?; let url = str_of(h, &["url", "link"]).ok_or("hyperlinks[] 需要 url")?; let mut u = Url::new(url); if let Some(t) = str_of(h, &["text"]) { u = u.set_text(t); } if let Some(t) = str_of(h, &["tip"]) { u = u.set_tip(t); } xerr(ws.write_url(row, col, u))?; } }
    // 8. 页面 / 页眉页脚 / 外观 / 保护
    if let Some(ps) = get(sheet, &["pageSetup"]) { apply_page_setup(&mut ws, ps, ctx)?; }
    if let Some(hf) = get(sheet, &["headerFooter", "header_footer"]) {
        if let Some(h) = get(hf, &["header"]).and_then(header_footer_text) { ws.set_header(h); }
        if let Some(f) = get(hf, &["footer"]).and_then(header_footer_text) { ws.set_footer(f); }
    }
    if let Some(c) = str_of(sheet, &["tabColor"]) { match color_of(c) { Some(col) => { ws.set_tab_color(col); } None => ctx.warnings.push(format!("标签颜色不认识：{c}")) } }
    if let Some(z) = num_of(sheet, &["zoom"]) { ws.set_zoom(z.clamp(10.0, 400.0) as u16); }
    if let Some(b) = bool_of(sheet, &["gridlines"]) { ws.set_screen_gridlines(b); }
    if bool_of(sheet, &["rtl"]) == Some(true) { ws.set_right_to_left(true); }
    if bool_of(sheet, &["hidden"]) == Some(true) { ws.set_hidden(true); }
    if let Some(s) = str_of(sheet, &["selection"]) { let (_, r0, c0, r1, c1) = parse_range(s).ok_or_else(|| format!("selection 不合法：{s}"))?; xerr(ws.set_selection(r0, c0, r1, c1))?; }
    if let Some(p) = get(sheet, &["protect"]) { apply_protection(&mut ws, p)?; }
    if bool_of(sheet, &["autofit"]).unwrap_or(false) { ws.autofit(); }
    if bool_of(sheet, &["active"]) == Some(true) { ws.set_active(true); }
    let _ = idx;
    Ok(ws)
}

const WORKBOOK_KEYS: &[&str] = &["sheets", "styles", "properties", "definedNames", "activeSheet", "font", "fontSize", "color", "readOnlyRecommended", "headerStyle", "autofit"];

/// 整份规格 → 字节。`spec.sheets` 缺省时把顶层当成唯一一张表。
pub fn build_workbook(spec: &Value, root: &Path) -> Result<Built, String> {
    let spec = if spec.is_object() { spec.clone() } else { return Err("spec 必须是对象".into()) };
    let mut named: HashMap<String, Value> = HashMap::new();
    if let Some(st) = obj_of(&spec, &["styles"]) { for (k, v) in st { named.insert(k.clone(), v.clone()); } }
    let mut base = Format::new();
    if let Some(f) = str_of(&spec, &["font"]) { base = base.set_font_name(f); }
    if let Some(s) = num_of(&spec, &["fontSize"]) { base = base.set_font_size(s); }
    if let Some(c) = str_of(&spec, &["color"]).and_then(color_of) { base = base.set_font_color(c); }
    let mut ctx = Ctx { named, base, root, warnings: Vec::new(), data_ws: None, data_next_col: 0 };
    let single_sheet_mode = get(&spec, &["sheets"]).is_none();
    let sheets_spec: Vec<Value> = if single_sheet_mode { vec![spec.clone()] } else { arr_of(&spec, &["sheets"]).cloned().unwrap_or_default() };
    if sheets_spec.is_empty() { return Err("需要至少一张工作表：sheets:[{name, columns, rows, ...}]".into()); }
    if !single_sheet_mode {
        if let Value::Object(o) = &spec { for k in o.keys() { if !WORKBOOK_KEYS.contains(&k.as_str()) { ctx.warnings.push(format!("工作簿顶层不认识的字段被忽略：{k}（工作表级字段要放进 sheets[] 里）")); } } }
    }
    // 工作簿级 headerStyle 下沉给没写的表
    let wb_header_style = get(&spec, &["headerStyle"]).cloned();
    let wb_autofit = bool_of(&spec, &["autofit"]);
    let mut workbook = Workbook::new();
    let mut names: Vec<String> = Vec::new();
    let mut active_idx: Option<usize> = None;
    for (i, sh) in sheets_spec.iter().enumerate() {
        let mut sh = sh.clone();
        if let Value::Object(o) = &mut sh {
            if !o.contains_key("headerStyle") { if let Some(h) = &wb_header_style { o.insert("headerStyle".into(), h.clone()); } }
            if !o.contains_key("autofit") { if let Some(a) = wb_autofit { o.insert("autofit".into(), Value::Bool(a)); } }
            if single_sheet_mode { for k in WORKBOOK_KEYS { if *k != "headerStyle" && *k != "autofit" { o.remove(*k); } } }
        }
        let raw_name = str_of(&sh, &["name", "title"]).unwrap_or("");
        let name = sanitize_sheet_name(raw_name, i, &names);
        if !raw_name.is_empty() && name != raw_name { ctx.warnings.push(format!("工作表名「{raw_name}」不合法或重复，改成了「{name}」")); }
        if bool_of(&sh, &["active"]) == Some(true) { active_idx = Some(i); }
        let ws = build_sheet(&sh, i, &name, &mut ctx)?;
        names.push(name);
        workbook.push_worksheet(ws);
    }
    if let Some(data) = ctx.data_ws.take() { workbook.push_worksheet(data); }
    match get(&spec, &["activeSheet"]) {
        Some(Value::String(n)) => { if let Some(i) = names.iter().position(|x| x == n) { active_idx = Some(i); } }
        Some(v @ Value::Number(_)) => { if let Some(i) = f64_of(v) { let i = i as usize; if i >= 1 && i <= names.len() { active_idx = Some(i - 1); } } }
        _ => {}
    }
    if let Some(i) = active_idx { if let Some(ws) = workbook.worksheets_mut().get_mut(i) { ws.set_active(true); } }
    if let Some(dn) = get(&spec, &["definedNames"]) {
        let pairs: Vec<(String, String)> = match dn {
            Value::Object(o) => o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect(),
            Value::Array(a) => a.iter().filter_map(|d| Some((str_of(d, &["name"])?.to_string(), str_of(d, &["ref", "formula", "range"])?.to_string()))).collect(),
            _ => Vec::new(),
        };
        for (name, f) in pairs {
            let formula = if f.starts_with('=') { f } else { format!("={f}") };
            if let Err(e) = workbook.define_name(&name, &formula) { ctx.warnings.push(format!("定义名称 {name} 失败: {e}")); }
        }
    }
    if let Some(p) = get(&spec, &["properties"]) {
        let mut props = DocProperties::new();
        if let Some(v) = str_of(p, &["title"]) { props = props.set_title(v); }
        if let Some(v) = str_of(p, &["subject"]) { props = props.set_subject(v); }
        if let Some(v) = str_of(p, &["author", "creator"]) { props = props.set_author(v); }
        if let Some(v) = str_of(p, &["manager"]) { props = props.set_manager(v); }
        if let Some(v) = str_of(p, &["company"]) { props = props.set_company(v); }
        if let Some(v) = str_of(p, &["category"]) { props = props.set_category(v); }
        if let Some(v) = str_of(p, &["keywords"]) { props = props.set_keywords(v); }
        if let Some(v) = str_of(p, &["comment", "comments", "description"]) { props = props.set_comment(v); }
        if let Some(v) = str_of(p, &["status"]) { props = props.set_status(v); }
        workbook.set_properties(&props);
    }
    if bool_of(&spec, &["readOnlyRecommended"]) == Some(true) { workbook.read_only_recommended(); }
    let bytes = workbook.save_to_buffer().map_err(|e| format!("生成 xlsx 失败: {e}"))?;
    Ok(Built { bytes, sheets: names, warnings: ctx.warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn has(bytes: &[u8], needle: &str) -> bool {
        bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn parses_addresses() {
        assert_eq!(parse_cell("A1"), Some((0, 0)));
        assert_eq!(parse_cell("$C$10"), Some((9, 2)));
        assert_eq!(parse_cell("AA2"), Some((1, 26)));
        assert_eq!(parse_cell("1A"), None);
        assert_eq!(parse_range("B2:A1").map(|r| (r.1, r.2, r.3, r.4)), Some((0, 0, 1, 1)));
        assert_eq!(parse_range("Sheet 1!A1:B2").map(|r| r.0), Some(Some("Sheet 1".into())));
        assert_eq!(parse_col(&json!("C")), Some(2));
        assert_eq!(parse_col(&json!(3)), Some(2));
        assert_eq!(parse_number("¥1,234.50"), Some(1234.5));
        assert_eq!(parse_number("12%"), Some(0.12));
    }

    #[test]
    fn full_featured_workbook_round_trips_every_part() {
        // 1×1 透明 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let raw = r##"{
            "font": "Arial", "fontSize": 11,
            "styles": { "money": { "numFmt": "currency", "bold": true }, "warn": { "fill": "#FFC7CE", "color": "#9C0006" } },
            "properties": { "title": "季度报表", "author": "Mr. Day One" },
            "definedNames": { "Total": "=销售!$D$8" },
            "sheets": [{
                "name": "销售", "tabColor": "#1677FF", "freeze": true, "autoFilter": true, "zoom": 110,
                "columns": [
                    { "header": "日期", "key": "date", "type": "date", "width": 14 },
                    { "header": "产品", "key": "product", "width": 18 },
                    { "header": "数量", "key": "qty", "type": "int" },
                    { "header": "金额", "key": "amount", "style": "money" }
                ],
                "rows": [
                    ["2026-01-05", "键盘", 12, 1188.0],
                    ["2026-01-06", "鼠标", 30, 2970.5],
                    { "values": ["2026-01-07", { "v": "显示器", "bold": true, "note": "大客户" }, 5, "=C4*1999"], "height": 22 },
                    [null, "合计", "=SUM(C2:C4)", { "f": "SUM(D2:D4)", "style": "money" }]
                ],
                "cells": { "F1": { "v": "官网", "link": "https://michaelide.xyz" }, "F2": { "rich": [{ "text": "红", "color": "red" }, "黑"] }, "F3": "=XLOOKUP(\"鼠标\",B2:B4,D2:D4)" },
                "merges": [{ "range": "A7:D7", "text": "备注：以上为测试数据", "align": "center", "fill": "#F5F5F5" }],
                "styleRanges": { "A1:D1": { "border": "thin" } },
                "widths": { "F": 20 }, "heights": { "7": 28 },
                "tables": [{ "ref": "H1:J4", "name": "库存", "style": "Medium9", "columns": [{ "header": "SKU" }, { "header": "在库", "total": "sum" }, { "header": "单价", "numFmt": "currency" }], "totalRow": true }],
                "conditionalFormats": [
                    { "ref": "C2:C4", "type": "cell", "operator": ">", "value": 10, "style": "warn" },
                    { "ref": "D2:D4", "type": "colorScale", "colors": ["#F8696B", "#FFEB84", "#63BE7B"] },
                    { "ref": "D2:D4", "type": "dataBar", "color": "#638EC6" },
                    { "ref": "C2:C4", "type": "iconSet", "icons": "3Arrows" },
                    { "ref": "B2:B4", "type": "text", "operator": "contains", "text": "鼠", "style": { "bold": true } },
                    { "ref": "A2:A4", "type": "formula", "formula": "=$C2>20", "style": { "italic": true } }
                ],
                "validations": [
                    { "ref": "B2:B100", "type": "list", "values": ["键盘", "鼠标", "显示器"], "prompt": "选一个产品" },
                    { "ref": "C2:C100", "type": "whole", "operator": "between", "min": 0, "max": 1000, "error": "0-1000 之间" },
                    { "ref": "A2:A100", "type": "date", "operator": ">=", "value": "2026-01-01" }
                ],
                "charts": [
                    { "type": "column", "title": "各产品金额", "at": "H8", "width": 480, "height": 288, "series": [{ "name": "金额", "categories": "B2:B4", "values": "D2:D4", "labels": true, "color": "#1677FF" }], "xAxis": { "title": "产品" }, "yAxis": { "title": "元", "numFmt": "#,##0" }, "legend": "bottom",
                      "combine": { "type": "line", "series": [{ "name": "数量", "categories": "B2:B4", "values": "C2:C4", "secondaryAxis": true, "marker": "circle", "trendline": "linear" }] } },
                    { "type": "pie", "title": "占比", "at": "H24", "series": [{ "categories": ["A", "B", "C"], "values": [1, 2, 3], "labels": { "percent": true, "value": false } }], "holeSize": 0 }
                ],
                "images": [{ "src": "data:image/png;base64,PNG_B64", "at": "F6", "width": 40, "height": 40 }],
                "sparklines": [{ "at": "E2", "range": "C2:D2", "type": "column", "high": true }],
                "notes": [{ "at": "A1", "text": "下单日期", "author": "系统" }],
                "shapes": [{ "at": "F10", "text": "提示", "width": 120, "height": 40, "fill": "#E6F4FF", "line": "#1677FF", "align": "center", "valign": "middle" }],
                "checkboxes": [{ "at": "G2", "checked": true }],
                "pageSetup": { "orientation": "landscape", "paper": "A4", "fitToPages": [1, 0], "printArea": "A1:F10", "repeatRows": [1, 1], "margins": { "left": 0.5, "right": 0.5 } },
                "headerFooter": { "header": { "center": "季度报表" }, "footer": "&C第 {PAGE} 页 / 共 {PAGES} 页" },
                "protect": { "password": "1234", "options": { "sort": true, "autofilter": true }, "unprotectRanges": ["B2:B100"] }
            }, {
                "name": "对象行", "rows": [{ "name": "A", "score": 1 }, { "name": "B", "score": 2 }], "autofit": true, "hidden": false
            }]
        }"##.replace("PNG_B64", png);
        let spec: Value = serde_json::from_str(&raw).expect("test spec json");
        let built = build_workbook(&spec, Path::new("/tmp")).expect("build");
        assert_eq!(built.sheets, vec!["销售".to_string(), "对象行".to_string()]);
        assert!(built.warnings.is_empty(), "不该有警告：{:?}", built.warnings);
        let b = &built.bytes;
        for part in ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml", "xl/charts/chart1.xml", "xl/charts/chart2.xml",
                     "xl/tables/table1.xml", "xl/drawings/drawing1.xml", "xl/media/image1.png", "xl/comments1.xml", "vmlDrawing1.vml", "docProps/app.xml"] {
            assert!(has(b, part), "缺少 {part}");
        }
        assert!(b.len() > 10_000);
        // 给 JS 侧的往返验证用：OFFICE_XLSX_OUT=path cargo test … 会把这份文件落盘
        if let Ok(out) = std::env::var("OFFICE_XLSX_OUT") { std::fs::write(&out, b).expect("dump"); }
    }

    #[test]
    fn single_sheet_shorthand_and_object_rows() {
        let spec = json!({ "name": "S", "rows": [{ "a": 1, "b": "x" }, { "a": 2, "b": "y" }], "freeze": 1 });
        let built = build_workbook(&spec, Path::new("/tmp")).expect("build");
        assert_eq!(built.sheets, vec!["S".to_string()]);
        assert!(built.warnings.is_empty(), "{:?}", built.warnings);
    }

    #[test]
    fn unknown_keys_and_bad_names_are_reported_not_silent() {
        let spec = json!({ "sheets": [{ "name": "a/b:c", "rowz": [], "rows": [[1]] }, { "name": "a bc", "rows": [[2]] }], "sheetz": 1 });
        let built = build_workbook(&spec, Path::new("/tmp")).expect("build");
        assert_eq!(built.sheets[0], "abc");
        assert!(built.warnings.iter().any(|w| w.contains("rowz")), "{:?}", built.warnings);
        assert!(built.warnings.iter().any(|w| w.contains("sheetz")), "{:?}", built.warnings);
        assert!(built.warnings.iter().any(|w| w.contains("a/b:c")), "{:?}", built.warnings);
        let err = build_workbook(&json!({ "sheets": [{ "rows": [[1]], "charts": [{ "type": "bubble", "series": [] }] }] }), Path::new("/tmp")).unwrap_err();
        assert!(err.contains("bubble"), "{err}");
    }
}
