// ==================== 天空与星空（纯计算） ====================
// 背景层的数据与颜色：天空色按大气密度插值、星表 seeded 确定性生成。
// 不碰 DOM/画布 —— Node 可直接 import 单测；绘制接线在 main.js。

// 太空底色（与旧清屏色 #050510 一致）与地表天空色（石板蓝，贴合 UI 基调）
export const SPACE_RGB = { r: 5, g: 5, b: 16 };
export const SURFACE_SKY_RGB = { r: 116, g: 162, b: 204 };

// 星色三档：白 / 钢蓝 / 淡暖白 —— 禁紫
export const STAR_COLORS = [
    [230, 238, 248],
    [150, 190, 230],
    [255, 244, 224],
];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 密度 → 天空色。dens=1 地表全蓝、=0 太空纯黑；×1.15 让低空尽快蓝起来
export function skyTint(dens) {
    const t = clamp01((dens || 0) * 1.15);
    return {
        r: Math.round(lerp(SPACE_RGB.r, SURFACE_SKY_RGB.r, t)),
        g: Math.round(lerp(SPACE_RGB.g, SURFACE_SKY_RGB.g, t)),
        b: Math.round(lerp(SPACE_RGB.b, SURFACE_SKY_RGB.b, t)),
    };
}

// 密度 → 星星可见度：地表看不见星星，越高越亮（比天空色衰减更快一点）
export function starVisibility(dens) {
    const t = clamp01((dens || 0) * 1.15);
    return clamp01(1 - t * 1.4);
}

// seeded 随机数（mulberry32）—— 同 seed 星表完全一致，可复现可测试
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 生成一层星表：count 颗，位置在 [0,w)×[0,h)。
// opts: rMin/rMax 半径、aMin/aMax 亮度、crosses 末尾 N 颗画成十字亮星
export function makeStarLayer(seed, w, h, count, opts) {
    const o = opts || {};
    const rnd = mulberry32(seed);
    const rMin = o.rMin ?? 0.4, rMax = o.rMax ?? 1.1;
    const aMin = o.aMin ?? 0.25, aMax = o.aMax ?? 0.75;
    const crosses = o.crosses ?? 0;
    const stars = [];
    for (let i = 0; i < count; i++) {
        stars.push({
            x: rnd() * w,
            y: rnd() * h,
            r: rMin + rnd() * (rMax - rMin),
            a: aMin + rnd() * (aMax - aMin),
            c: Math.floor(rnd() * STAR_COLORS.length) % STAR_COLORS.length,
            cross: i >= count - crosses,
            crossR: 3 + rnd() * 3,
        });
    }
    return stars;
}
