// ==================== 轨道预测线 ====================
// 两种画法，按场景自动选：
//   1) 真空 + 关机 + 椭圆轨道（稳定绕轨正是这种）→ 解析椭圆，零积分成本。
//      以前这条路径每帧要做约 62 万步数值积分（探测一遍 + 复现一遍），
//      入轨后帧率直接坍塌 —— 现在是纯几何计算，而且比数值积分更精确。
//   2) 其它（点火中 / 大气内 / 逃逸 / 亚轨道）→ 数值积分，力和积分方式
//      与 physicsStep 完全一致（引力 + 大气阻力，同一步长），虚线贴合实机。
//
// 预测语义：**假设此刻关机滑行**的轨迹，不含推力 —— 点火中的虚线表示
// 「如果现在熄火，之后会怎么飞」，和 SFS 的预测线一个意思。
// 数值路径做了 100ms 节流：点火中轨迹本来就在变，肉眼不需要 60fps 的虚线。

import { FIXED_DT, DRAG_COEF } from '../core/constants.js';
import { planet, GRAVITY_MU, gravityAt, atmosphereDensity } from '../world/planet.js';

const NUMERIC_INTERVAL_MS = 100;
const BURN_PREDICT_MAX_STEPS = 30000;   // 点火中预测限幅：≈8 游戏分钟，够看清趋势
// 重算代价自适应：越贵的重算间隔越长（100ms 下限，400ms 上限），
// 防止个别很长的轨迹（如大气内跳轨道）每 100ms 咬掉一整帧
const numericCache = { at: -1e9, points: null, interval: NUMERIC_INTERVAL_MS, lastSteps: 0 };

// 对外入口。s = { x, y, vx, vy }；engineOn = 发动机是否在烧；now = performance.now()
export function predictPath(s, engineOn, now) {
    const dx = s.x - planet.x;
    const dy = s.y - planet.y;
    const r = Math.hypot(dx, dy) || 1;
    const v2 = s.vx * s.vx + s.vy * s.vy;
    const energy = v2 / 2 - GRAVITY_MU / r;
    const dens = atmosphereDensity(s.x, s.y);

    // 真空 + 关机 + 束缚轨道 → 解析椭圆
    if (!engineOn && dens < 0.01 && energy < 0) {
        const pts = conicPoints(s, dx, dy, r);
        if (pts) return pts;
    }

    // 数值路径节流复用
    if (now - numericCache.at < numericCache.interval && numericCache.points) {
        return numericCache.points;
    }
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    numericCache.points = numericPath(s, engineOn);
    numericCache.at = now;
    if (t0) numericCache.interval = Math.min(400, Math.max(NUMERIC_INTERVAL_MS, (performance.now() - t0) * 8));
    return numericCache.points;
}

// 测试钩子：上次数值路径实际积分了多少步
export function __debugLastSteps() { return numericCache.lastSteps; }

// ---- 画法一：解析椭圆 ----
// 由状态向量直接算轨道根数（半通径 p、偏心率 e、近点角方向 ω），
// 沿真近点角均匀取 360 个点。线画到撞地为止 —— 比旧数值画法提前
// 5km 收笔的问题在这里天然不存在。
function conicPoints(s, dx, dy, r) {
    const mu = GRAVITY_MU;
    const h = dx * s.vy - dy * s.vx;              // 角动量（z 分量，带方向）
    if (Math.abs(h) < 1e-6) return null;          // 纯径向直上直下：交给数值画（很短）

    const v2 = s.vx * s.vx + s.vy * s.vy;
    const p = h * h / mu;                          // 半通径
    const ecc2 = 1 + 2 * (v2 / 2 - mu / r) * h * h / (mu * mu);
    const e = Math.sqrt(Math.max(0, ecc2));
    if (e >= 1) return null;                       // 抛物/双曲：逃逸轨迹很短，数值画

    // 离心率向量 e⃗ = ((v²-μ/r)·r⃗ - (r⃗·v⃗)·v⃗) / μ，指向近心点
    const rv = dx * s.vx + dy * s.vy;
    const ex = ((v2 - mu / r) * dx - rv * s.vx) / mu;
    const ey = ((v2 - mu / r) * dy - rv * s.vy) / mu;
    let omega = Math.atan2(ey, ex);
    if (e < 1e-6) omega = Math.atan2(dy, dx);      // 近圆轨道：e⃗ 是数值噪声，用当前位置角

    const nu0 = Math.atan2(dy, dx) - omega;        // 当前真近点角
    const dir = h > 0 ? 1 : -1;                    // 顺/逆时针
    const N = 360;
    const points = [];
    let prevNu = nu0;

    for (let i = 0; i <= N; i++) {
        const nu = nu0 + dir * (i / N) * Math.PI * 2;
        const rr = p / (1 + e * Math.cos(nu));
        if (rr < planet.radius) {
            // 掠地时 1° 采样一跨就是几十公里：二分逼近地表穿越点，线头贴准地面
            let lo = prevNu, hi = nu;
            for (let k = 0; k < 24; k++) {
                const mid = (lo + hi) / 2;
                if (p / (1 + e * Math.cos(mid)) < planet.radius) hi = mid; else lo = mid;
            }
            const rrHit = p / (1 + e * Math.cos(lo));
            const angHit = omega + lo;
            points.push(planet.x + rrHit * Math.cos(angHit), planet.y + rrHit * Math.sin(angHit));
            break;
        }
        if (rr > planet.radius * 3) break;         // 远离：同 'far'
        const ang = omega + nu;
        points.push(planet.x + rr * Math.cos(ang), planet.y + rr * Math.sin(ang));
        prevNu = nu;
    }
    return points.length >= 4 ? points : null;
}

// ---- 画法二：数值积分 ----
// 与 physicsStep 完全同一套力：先引力、再阻力、后位移，半隐式欧拉同阶。
function predictStep(s, dt) {
    const g = gravityAt(s.x, s.y);
    s.vx += g.ax * dt;
    s.vy += g.ay * dt;
    const dens = atmosphereDensity(s.x, s.y);
    if (dens > 0) {
        const sp = Math.hypot(s.vx, s.vy);
        if (sp > 1) {
            const drag = DRAG_COEF * dens * sp * sp;
            s.vx -= (s.vx / sp) * drag * dt;
            s.vy -= (s.vy / sp) * drag * dt;
        }
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
}

function predictShouldStop(s, sweep, i, hitMargin) {
    const d = Math.hypot(s.x - planet.x, s.y - planet.y);
    if (d < planet.radius + hitMargin) return 'hit';
    if (d > planet.radius * 3) return 'far';
    if (i > 600 && Math.abs(sweep) >= Math.PI * 2) return 'orbit';
    return null;
}

// 粗测要画多远：步长放大 8 倍换 8 倍速度，只用来估计长度；
// 正式画线的第二遍自己会精确撞上停止条件，粗测偏差无所谓。
// （旧实现探测用全精度步长，绕轨时探测一遍就要 30 万步。）
function predictProbeSteps(s, maxSteps) {
    const PROBE_DT = FIXED_DT * 8;
    const t = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
    let sweep = 0;
    let prevAng = Math.atan2(t.y - planet.y, t.x - planet.x);
    const LIMIT = Math.min(100000, Math.ceil(maxSteps / 8));   // ×8 步长 ≈ 80 万原步
    for (let i = 1; i <= LIMIT; i++) {
        predictStep(t, PROBE_DT);
        const ang = Math.atan2(t.y - planet.y, t.x - planet.x);
        let da = ang - prevAng;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        sweep += da;
        prevAng = ang;
        if (predictShouldStop(t, sweep, i * 8, 600)) return i * 8;
    }
    return LIMIT * 8;
}

function numericPath(s, engineOn) {
    // 点火中的轨迹本来就在持续变化，画满一整圈毫无意义还巨贵
    // （近轨道椭圆一圈约 40 万步 = 每 100ms 冻结一帧）—— 限幅后几毫秒就算完，
    // 熄火后解析椭圆接管画全程。
    const maxSteps = engineOn ? BURN_PREDICT_MAX_STEPS : Infinity;
    let totalSteps;
    try {
        totalSteps = predictProbeSteps(s, maxSteps);
    } catch (e) {
        totalSteps = 3000;
    }
    // 至少画 5 秒，免得静止时线太短看不见
    totalSteps = Math.max(totalSteps, 5 / FIXED_DT);
    totalSteps = Math.min(totalSteps, maxSteps);
    numericCache.lastSteps = totalSteps;

    const TARGET_POINTS = 600;
    const sample = Math.max(1, Math.round(totalSteps / TARGET_POINTS));

    const t = { x: s.x, y: s.y, vx: s.vx, vy: s.vy };
    const points = [t.x, t.y];
    let sweep = 0;
    let prevAng = Math.atan2(t.y - planet.y, t.x - planet.x);

    for (let i = 0; i < totalSteps; i++) {
        predictStep(t, FIXED_DT);
        if (i % sample === 0) points.push(t.x, t.y);

        const ang = Math.atan2(t.y - planet.y, t.x - planet.x);
        let da = ang - prevAng;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        sweep += da;
        prevAng = ang;

        if (predictShouldStop(t, sweep, i, 2)) break;
    }
    points.push(t.x, t.y);   // 收笔补一个点，线头才准
    return points;
}
