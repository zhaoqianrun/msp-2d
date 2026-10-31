// ==================== 星球 / 引力 / 大气（纯计算）====================
// 不碰 DOM、不读飞船状态 —— Node 里可以直接单测。
import { G0_PX, ATMO_RATIO, ATMO_SCALE_HEIGHT, ATMO_FADE_KM, DIST_M_PER_PX } from '../core/constants.js';

// ==== 游戏数据 ====
// 星球：半径 2500 km，参数按真实物理选取（火星级重力）：
//
//   表面重力 3.71 m/s²   —— 火星表面重力
//   半径     2500 km
//   密度     5.31 g/cm³  —— 比火星(3.9)略重，仍在岩石行星范围
//   逃逸速度 4307 m/s    —— 充分留住 N₂/O₂ 大气（比值 8.5 / 9.1）
//   表面温度 288 K (15°C) —— 猫咪能活
//
// 【为什么重力从 1.35 提到 3.71】
// 重力 1.35 时飞船「关机后要滑行一分多钟才停下」：
//   无阻力时减速时间 ≈ v/g，重力越小刹得越慢。
//   1.35 -> 58 m/s 要 43 秒；3.71 -> 只要 15.6 秒。
// 而且低速时空气阻力 ∝ v² 几乎为零，单靠加阻力救不回来，
// 只能靠重力 —— 所以这里必须把重力提上来。
//
// 这几个量由同一套物理互相约束，不能单独改：
//   密度 = 3g / (4πGR)，逃逸速度 = √(2gR)，标高 = kT/(mg)
//
// 引力用“平方反比”，和真实星球、和 SFS 一样：
//     引力 = g0 × (radius / 距离)²
// 所以贴着地面时的引力就是 g0 —— 想让星球变重只改 SURFACE_GRAVITY_MS2。
export const planet = {
    x: 500, y: 350,
    // 像素半径 2500000 = 2500 km，按 1 px = 1 m 换算
    radius: 2500000,
    // 注意：这里**不再**存 surfaceGravity。
    // 以前存过一个 19.6，但物理实际用的是另一个值，
    // 两者差几十倍，导致 HUD 的圆轨道速度、推重比、轨道根数全部算错。
    // 现在全场景只有一个数据源：SURFACE_GRAVITY_MS2（米制）+ G0_PX（像素制）。
};

// 引力常数 μ = g0 × R²（像素制）—— 用于能量判据 / 轨道根数 / 逃逸判定。
// 以前这里乘的是 planet.surfaceGravity（19.6），比真实 g0（0.0196）大 1000 倍，
// 导致「逃脱摇篮」成就几乎永远拿不到、轨道根数也是错的。现在统一用 G0_PX。
export const GRAVITY_MU = G0_PX * planet.radius * planet.radius;

// ==== 引力：平方反比（真正的轨道引力）====
// a = G0_PX × (radius / 距离)²
// 这里不用另外加“离心力”：我们用的是不跟着飞船转的坐标系，
// 只要横向速度够快，飞船就会一直“绕着、掉不到地上”—— 这就是轨道。
//
// SURFACE_GRAVITY_MS2 / G0_PX 已在上面「尺度系统」里定义（唯一数据源），
// 这里不再重复声明，避免两处不一致再次出现。

// 引力：平方反比，a = g0 × (R / r)²
// g0 直接用上面算好的 G0_PX（像素/秒²），恒定，绝不用相机缩放。
export function gravityAt(x, y) {
    const dx = planet.x - x;
    const dy = planet.y - y;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    const safe = Math.max(dist, planet.radius * 0.5);   // 防止贴到球心时引力爆表
    const a = G0_PX * (planet.radius / safe) ** 2;
    return { ax: (dx / dist) * a, ay: (dy / dist) * a, dist };
}


export function atmosphereDensity(x, y) {
    const r = Math.hypot(x - planet.x, y - planet.y);
    const alt = r - planet.radius;
    if (alt < 0) return 1;
    // 200 km 以上当作真空（8.7 个标高，密度已降到千万分之一）
    if (alt * DIST_M_PER_PX > ATMO_FADE_KM * 1000) return 0;
    // 指数衰减
    const d = Math.exp(-alt / ATMO_SCALE_HEIGHT);
    return d > 1 ? 1 : d;
}


export function atmoThickness() { return planet.radius * ATMO_RATIO; }

