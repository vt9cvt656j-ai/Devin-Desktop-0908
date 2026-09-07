//! 截图后处理与 Set-of-Marks。
//!
//! 这里只有纯函数：不碰 Agent、不碰 AX 句柄、不起进程。于是它能在单测里真跑，
//! 也能挂在 accept 线程之外（见 rpc.rs 的 `offloadable`）。
//!
//! # 为什么要缩图、为什么在这里缩
//!
//! 模型给坐标的空间是**它看到的那张图**。Retina 上 `screencapture` 出的是 2× 像素
//! （3456×2234），超过各家视觉 API 的上限后会被**静默缩放**——模型在缩过的图上量坐标，
//! 我们却按原图换算，点击一律偏移。Anthropic 的参考实现和 Agent S 都是同一个做法：
//! 壳里先缩到 1280×720 上下、记住比例、把模型给的坐标换算回屏幕，**模型不碰任何换算**。
//! 原来那条「图上量到的坐标要除以 2」的文字提示，是把换算推给模型，而它正是最容易忘的那方。
//!
//! # Set-of-Marks
//!
//! 可访问性树里每个节点都有屏幕坐标，截图上每个像素都有颜色——两样早就都有了，
//! 只是从没叠在一起。把节点的框和编号（编号 = read_screen 的 ref）画到图上，模型同时看到
//! 结构和像素：认出 ⑦ 就 `ui_click ref:7`，精确且不碰坐标；没编号的区域才用坐标点。
//! 这是 GUI Agent 领域最通用的混合定位法（UFO²、Agent S、SoM 论文都是它）。

use image::{ImageBuffer, Rgba, RgbaImage};

/// 送给模型的图默认最长边。官方建议 1280×720 上下：再大超预算、再小认不出小图标。
pub const DEFAULT_MAX_SIDE: u32 = 1280;
/// 最多画多少个编号框。再多就糊成一片，模型反而找不到；browser 的 task 循环上限 140 是同一个考虑。
pub const DEFAULT_MAX_MARKS: usize = 150;

/// 编号框的颜色：SoM 惯例用高饱和红，深浅背景上都读得出。
const MARK_RGBA: Rgba<u8> = Rgba([200, 55, 31, 255]);
const MARK_TEXT: Rgba<u8> = Rgba([255, 255, 255, 255]);
/// 框线宽（像素）。图已缩到 ~1280，2px 在深色和浅色界面上都看得清、又不至于盖住控件本身。
const STROKE: u32 = 2;
/// 3×5 位图数字，放大倍数。×2 → 每个数字 6×10 像素，1280 宽的图上刚好能读。
const GLYPH_SCALE: u32 = 2;

/// 一张截图在「模型坐标」和「屏幕点坐标」之间的换算关系。
///
/// 模型只见 `image_w × image_h` 这张图；它给的 (x, y) 换回屏幕点是
/// `origin + (x, y) × points_per_image_px`。整屏时 origin 是 (0, 0)，区域截图时是区域左上角。
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Geometry {
    pub image_w: u32,
    pub image_h: u32,
    /// 图左上角对应的屏幕点坐标。
    pub origin_x: i32,
    pub origin_y: i32,
    /// 图覆盖的屏幕范围（点）。
    pub points_w: u32,
    pub points_h: u32,
    /// 图上一个像素等于多少屏幕点。整屏 1280 宽对 1728 点宽的屏，就是 1.35。
    pub points_per_image_px: f64,
}

impl Geometry {
    /// 屏幕点 → 图上像素。
    pub fn to_image_px(&self, x_pt: f64, y_pt: f64) -> (f64, f64) {
        let k = self.points_per_image_px.max(1e-9);
        ((x_pt - self.origin_x as f64) / k, (y_pt - self.origin_y as f64) / k)
    }
    /// 图上像素 → 屏幕点。JS 侧也做同一件事；两边算式一致，这里留一份是给测试和 marked 用。
    pub fn to_points(&self, x_px: f64, y_px: f64) -> (f64, f64) {
        (
            self.origin_x as f64 + x_px * self.points_per_image_px,
            self.origin_y as f64 + y_px * self.points_per_image_px,
        )
    }
}

/// 缩到 `max_side` 以内要乘的系数。**只缩不放**：小图放大只会糊，白白多花 token。
/// `max_side == 0` 表示不缩。
pub fn fit_scale(w: u32, h: u32, max_side: u32) -> f64 {
    let long = w.max(h);
    if max_side == 0 || long == 0 || long <= max_side {
        return 1.0;
    }
    max_side as f64 / long as f64
}

/// 一个要画到图上的框，**图上像素**坐标。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkPx {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub label: u32,
}

/// 屏幕上的一个窗口矩形（屏幕点），配它所属的进程。`system::window_stack` 按 z 序**从前到后**给。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WinRect {
    pub pid: i32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl WinRect {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }
}

/// 目标进程 `pid` 的一个屏幕点，在截图上看不看得见。
///
/// `stack` 是屏幕上普通层的窗口，从前到后。盖住这个点的最前面那扇窗口是谁的，就决定了答案：
/// 是目标自己的 → 看得见；是别人的 → 被盖住；没有窗口盖着（菜单栏、桌面空处）→ 看得见。
/// 实拍过一次反例：访达是「前台应用」，它的窗口却排在 Claude 的窗口后面，于是访达列表里
/// 两百多个框全画在了 Claude 的正文上。「谁在前台」答不了这个问题，z 序才能。
pub fn point_visible(pid: i32, stack: &[WinRect], px: f64, py: f64) -> bool {
    stack.iter().find(|w| w.contains(px, py)).map_or(true, |w| w.pid == pid)
}

/// 截图处理完的结果：缩好的图 + 换算关系。
pub struct Prepared {
    pub image: RgbaImage,
    pub geometry: Geometry,
}

/// 把 `screencapture`（或 GDI）出来的 PNG 缩到 `max_side`，并算出换算关系。
///
/// `region_points`：区域截图时传区域（点）；整屏传 None。`screen_points`：主屏点尺寸。
/// 换算的分母取「图覆盖的点范围」而不是屏幕点尺寸——区域截图时两者不同，混用就是错位。
pub fn prepare(
    png: &[u8],
    max_side: u32,
    region_points: Option<(i32, i32, i32, i32)>,
    screen_points: (u32, u32),
) -> Result<Prepared, String> {
    let decoded = image::load_from_memory(png).map_err(|e| format!("截图解码失败：{e}"))?;
    let rgba = decoded.to_rgba8();
    let (pw, ph) = rgba.dimensions();
    if pw == 0 || ph == 0 {
        return Err("截图是 0 像素".into());
    }
    let (ox, oy, cw, ch) = match region_points {
        Some((x, y, w, h)) if w > 0 && h > 0 => (x, y, w as u32, h as u32),
        _ => (0, 0, screen_points.0.max(1), screen_points.1.max(1)),
    };
    let scale = fit_scale(pw, ph, max_side);
    let image = if scale < 1.0 {
        let nw = ((pw as f64 * scale).round() as u32).max(1);
        let nh = ((ph as f64 * scale).round() as u32).max(1);
        // Triangle（双线性）：比 Lanczos 快好几倍，缩 2× 左右的界面截图肉眼分不出差别。
        image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle)
    } else {
        rgba
    };
    let (iw, ih) = image.dimensions();
    let geometry = Geometry {
        image_w: iw,
        image_h: ih,
        origin_x: ox,
        origin_y: oy,
        points_w: cw,
        points_h: ch,
        points_per_image_px: cw as f64 / iw as f64,
    };
    Ok(Prepared { image, geometry })
}

/// 把编号框画到图上。框不在图内的部分裁掉，不 panic。
pub fn draw_marks(img: &mut RgbaImage, marks: &[MarkPx]) {
    for m in marks {
        stroke_rect(img, m.x, m.y, m.w, m.h);
        draw_label(img, m.x, m.y, m.label);
    }
}

fn put(img: &mut RgbaImage, x: i64, y: i64, c: Rgba<u8>) {
    if x < 0 || y < 0 {
        return;
    }
    let (w, h) = img.dimensions();
    if (x as u32) < w && (y as u32) < h {
        img.put_pixel(x as u32, y as u32, c);
    }
}

fn fill_rect(img: &mut RgbaImage, x: i64, y: i64, w: i64, h: i64, c: Rgba<u8>) {
    for yy in y..y + h {
        for xx in x..x + w {
            put(img, xx, yy, c);
        }
    }
}

fn stroke_rect(img: &mut RgbaImage, x: i32, y: i32, w: u32, h: u32) {
    let (x, y, w, h, s) = (x as i64, y as i64, w as i64, h as i64, STROKE as i64);
    fill_rect(img, x, y, w, s, MARK_RGBA); // 上
    fill_rect(img, x, y + h - s, w, s, MARK_RGBA); // 下
    fill_rect(img, x, y, s, h, MARK_RGBA); // 左
    fill_rect(img, x + w - s, y, s, h, MARK_RGBA); // 右
}

/// 3×5 位图数字。每个数字 5 行，每行 3 位，从高位到低位是左到右。
const GLYPHS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b001, 0b001, 0b001], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

/// 标签盒子的像素尺寸（不含位置）：宽 = 数字数 × (3×scale + 间距) + 内边距。
pub fn label_size(label: u32) -> (u32, u32) {
    let digits = label.to_string().len() as u32;
    let gw = 3 * GLYPH_SCALE;
    let gh = 5 * GLYPH_SCALE;
    let gap = GLYPH_SCALE;
    let pad = 2;
    (digits * gw + (digits.saturating_sub(1)) * gap + pad * 2, gh + pad * 2)
}

fn draw_label(img: &mut RgbaImage, x: i32, y: i32, label: u32) {
    let (lw, lh) = label_size(label);
    // 盒子贴在框的左上角外侧（上方）；顶到图边时挪到框内。
    let (iw, _) = img.dimensions();
    let by = if y as i64 - lh as i64 >= 0 { y as i64 - lh as i64 } else { y as i64 };
    let bx = (x as i64).max(0).min((iw as i64 - lw as i64).max(0));
    fill_rect(img, bx, by, lw as i64, lh as i64, MARK_RGBA);
    let mut cx = bx + 2;
    let cy = by + 2;
    for ch in label.to_string().bytes() {
        let d = (ch - b'0') as usize;
        let glyph = GLYPHS[d.min(9)];
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) != 0 {
                    let px = cx + (col * GLYPH_SCALE) as i64;
                    let py = cy + (row as u32 * GLYPH_SCALE) as i64;
                    fill_rect(img, px, py, GLYPH_SCALE as i64, GLYPH_SCALE as i64, MARK_TEXT);
                }
            }
        }
        cx += (3 * GLYPH_SCALE + GLYPH_SCALE) as i64;
    }
}

/// 一个框最多占画面多大还值得画。窗口 / 分栏 / 滚动区这类容器几乎铺满整张图，画上去只会
/// 把真正的控件糊住，而它们本身也不是点击目标。0.4 是看过实拍定的：Finder 的侧栏 Outline
/// 占三成，仍然值得标；整窗和 SplitGroup 占六成以上，全部排掉。
pub const MAX_MARK_AREA_FRAC: f64 = 0.4;

/// 两个框重合到这个程度就当同一个目标，只画先来的（DFS 先父后子：Row 和它铺满整行的
/// Cell、按钮和它里面的图标）。0.8：铺满的会合并，挨着的两个控件不会。
pub const DEDUPE_IOU: f64 = 0.8;

fn iou(a: &MarkPx, b: &MarkPx) -> f64 {
    let (ax1, ay1) = (a.x + a.w as i32, a.y + a.h as i32);
    let (bx1, by1) = (b.x + b.w as i32, b.y + b.h as i32);
    let iw = (ax1.min(bx1) - a.x.max(b.x)).max(0) as f64;
    let ih = (ay1.min(by1) - a.y.max(b.y)).max(0) as f64;
    let inter = iw * ih;
    let union = (a.w as f64 * a.h as f64) + (b.w as f64 * b.h as f64) - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// 把屏幕点坐标的节点换成图上的框；不在图内的丢掉。`label` 从 1 起，和 read_screen 的 ref 一致。
/// 面积超过 [`MAX_MARK_AREA_FRAC`] 的不画（见那条常量的说明）。
pub fn marks_for(
    geometry: &Geometry,
    nodes: impl IntoIterator<Item = (usize, (i32, i32, i32, i32))>,
    max_marks: usize,
) -> Vec<MarkPx> {
    let mut out = Vec::new();
    let image_area = geometry.image_w as f64 * geometry.image_h as f64;
    for (i, (x, y, w, h)) in nodes {
        if out.len() >= max_marks {
            break;
        }
        if w <= 0 || h <= 0 {
            continue;
        }
        {
            let (bw, bh) = (w as f64 / geometry.points_per_image_px, h as f64 / geometry.points_per_image_px);
            if image_area > 0.0 && bw * bh / image_area > MAX_MARK_AREA_FRAC {
                continue;
            }
        }
        let (x0, y0) = geometry.to_image_px(x as f64, y as f64);
        let (x1, y1) = geometry.to_image_px((x + w) as f64, (y + h) as f64);
        // 整个框都在图外就不画；部分在外的照画，画的时候会裁。
        if x1 <= 0.0 || y1 <= 0.0 || x0 >= geometry.image_w as f64 || y0 >= geometry.image_h as f64 {
            continue;
        }
        let pw = (x1 - x0).round().max(1.0) as u32;
        let ph = (y1 - y0).round().max(1.0) as u32;
        let cand = MarkPx { x: x0.round() as i32, y: y0.round() as i32, w: pw, h: ph, label: i as u32 + 1 };
        // 两个编号叠在同一个位置，模型哪个都读不清；几乎重合的只留先来的那个。
        if out.iter().any(|m| iou(m, &cand) >= DEDUPE_IOU) {
            continue;
        }
        out.push(cand);
    }
    out
}

pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败：{e}"))?;
    Ok(buf.into_inner())
}

/// 空白画布，测试和 Windows 兜底用。
pub fn blank(w: u32, h: u32) -> RgbaImage {
    ImageBuffer::from_pixel(w, h, Rgba([255, 255, 255, 255]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 只缩不放_且零表示不缩() {
        assert_eq!(fit_scale(3456, 2234, 1280), 1280.0 / 3456.0);
        assert_eq!(fit_scale(800, 600, 1280), 1.0, "小图不许放大");
        assert_eq!(fit_scale(3456, 2234, 0), 1.0, "max_side=0 = 原图");
    }

    #[test]
    fn retina_整屏_换算能来回走() {
        // 1728×1117 点的屏，screencapture 出 3456×2234 像素，缩到 1280 宽。
        let png = encode_png(&blank(3456, 2234)).unwrap();
        let p = prepare(&png, 1280, None, (1728, 1117)).unwrap();
        assert_eq!(p.geometry.image_w, 1280);
        assert_eq!(p.geometry.image_h, 827);
        // 一个图上像素 = 1728/1280 = 1.35 点
        assert!((p.geometry.points_per_image_px - 1.35).abs() < 1e-9);
        // 屏幕点 (864, 558) 应落在图中央附近；来回换算误差小于一个像素
        let (ix, iy) = p.geometry.to_image_px(864.0, 558.5);
        assert!((ix - 640.0).abs() < 1e-6 && (iy - 413.7).abs() < 0.1);
        let (bx, by) = p.geometry.to_points(ix, iy);
        assert!((bx - 864.0).abs() < 1e-6 && (by - 558.5).abs() < 1e-6);
    }

    #[test]
    fn 区域截图的原点和分母都是区域自己的() {
        // 区域 (100,200) 起 400×300 点，Retina 出 800×600 像素，不缩。
        let png = encode_png(&blank(800, 600)).unwrap();
        let p = prepare(&png, 1280, Some((100, 200, 400, 300)), (1728, 1117)).unwrap();
        assert_eq!((p.geometry.origin_x, p.geometry.origin_y), (100, 200));
        assert_eq!(p.geometry.points_per_image_px, 0.5, "800px 盖 400 点 → 每像素 0.5 点");
        // 图上 (0,0) 是区域左上角 (100,200)，不是屏幕 (0,0)
        assert_eq!(p.geometry.to_points(0.0, 0.0), (100.0, 200.0));
    }

    #[test]
    fn 编号框画在图内_且编号从ref_1起() {
        let mut img = blank(200, 100);
        let g = Geometry { image_w: 200, image_h: 100, origin_x: 0, origin_y: 0, points_w: 200, points_h: 100, points_per_image_px: 1.0 };
        // 三个节点：一个正常、一个完全在图外、一个零尺寸
        let marks = marks_for(&g, vec![(0, (20, 30, 60, 20)), (1, (500, 500, 10, 10)), (2, (5, 5, 0, 0))], 150);
        assert_eq!(marks.len(), 1, "图外和零尺寸的不画");
        assert_eq!(marks[0].label, 1, "编号 = 下标 + 1，和 read_screen 的 ref 对齐");
        draw_marks(&mut img, &marks);
        // 框的上边线（y=30..32, x=20..80）被涂成标记色
        assert_eq!(*img.get_pixel(50, 30), MARK_RGBA);
        assert_eq!(*img.get_pixel(50, 31), MARK_RGBA);
        // 框内部没被涂（点击目标本身要看得见）
        assert_eq!(*img.get_pixel(50, 40), Rgba([255, 255, 255, 255]));
        // 标签盒子在框上方，白色数字至少有一个像素
        let (lw, lh) = label_size(1);
        let mut white = 0;
        for yy in (30 - lh as i32)..30 {
            for xx in 20..(20 + lw as i32) {
                if *img.get_pixel(xx as u32, yy as u32) == MARK_TEXT { white += 1; }
            }
        }
        assert!(white > 0, "标签里没有数字像素");
    }

    #[test]
    fn 顶到图边的框不会panic_且标签挪进框内() {
        let mut img = blank(50, 40);
        let marks = vec![MarkPx { x: -10, y: -5, w: 30, h: 20, label: 12 }, MarkPx { x: 45, y: 35, w: 100, h: 100, label: 150 }];
        draw_marks(&mut img, &marks); // 不 panic 即通过
        assert_eq!(marks_for(&Geometry { image_w: 50, image_h: 40, origin_x: 0, origin_y: 0, points_w: 50, points_h: 40, points_per_image_px: 1.0 },
            vec![(0, (-10, -5, 30, 20))], 150).len(), 1, "部分在图外的照画");
    }

    #[test]
    fn 铺满画面的容器不画框() {
        let g = Geometry { image_w: 1000, image_h: 800, origin_x: 0, origin_y: 0, points_w: 1000, points_h: 800, points_per_image_px: 1.0 };
        // 整窗（占 90%）不画；一个占 30% 的侧栏画；一个按钮画
        let marks = marks_for(&g, vec![(0, (0, 0, 950, 760)), (1, (0, 0, 300, 800)), (2, (10, 10, 80, 30))], 150);
        assert_eq!(marks.iter().map(|m| m.label).collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn 编号上限生效() {
        let g = Geometry { image_w: 1000, image_h: 1000, origin_x: 0, origin_y: 0, points_w: 1000, points_h: 1000, points_per_image_px: 1.0 };
        let nodes: Vec<_> = (0..400).map(|i| (i, ((i % 20) as i32 * 40, (i / 20) as i32 * 40, 30, 30))).collect();
        assert_eq!(marks_for(&g, nodes, 150).len(), 150);
    }

    #[test]
    fn 被别的窗口盖住的点不算可见() {
        // 从前到后：Claude 的窗口在前，访达的在后，两者重叠
        let stack = vec![
            WinRect { pid: 2, x: 100.0, y: 100.0, w: 500.0, h: 400.0 },
            WinRect { pid: 1, x: 50.0, y: 50.0, w: 400.0, h: 300.0 },
        ];
        assert!(!point_visible(1, &stack, 200.0, 200.0), "在 Claude 窗口里的点，访达看不见");
        assert!(point_visible(1, &stack, 60.0, 60.0), "只有访达自己盖着的点看得见");
        assert!(point_visible(1, &stack, 900.0, 900.0), "没有窗口盖着（桌面空处 / 菜单栏）当可见");
        assert!(!point_visible(1, &stack, 550.0, 450.0), "只被别人盖着的点（桌面图标）看不见");
        assert!(point_visible(1, &[], 5.0, 5.0), "一扇窗口都没有也不能 panic");
    }

    #[test]
    fn 几乎重合的框只画一个_挨着的不合并() {
        let g = Geometry { image_w: 1000, image_h: 800, origin_x: 0, origin_y: 0, points_w: 1000, points_h: 800, points_per_image_px: 1.0 };
        let marks = marks_for(&g, vec![
            (0, (10, 10, 300, 20)),   // Row
            (1, (10, 10, 300, 20)),   // 它铺满整行的 Cell → 合并
            (2, (12, 11, 296, 18)),   // 几乎一样 → 合并
            (3, (10, 40, 300, 20)),   // 下一行 → 保留
            (4, (10, 10, 20, 20)),    // 行首的小图标 → 保留（IoU 小）
        ], 150);
        assert_eq!(marks.iter().map(|m| m.label).collect::<Vec<_>>(), vec![1, 4, 5]);
    }
}
