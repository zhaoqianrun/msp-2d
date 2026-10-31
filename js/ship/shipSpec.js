// ==================== 船体规格（纯计算）====================
// 从部件列表算出质量/燃料容量/推力/包围盒/质心/碰撞箱。
// 不碰 DOM、不读游戏状态 —— Node 里可以直接单测。
import { PART_TYPES, PART_PX } from './partTypes.js';

export function shipSpec(def) {
    let dryMass = 0, fuelCap = 0, thrust = 0;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of def.parts) {
        const t = PART_TYPES[p.type];
        if (!t) continue;
        dryMass += t.mass; fuelCap += t.fuel; thrust += t.thrust;
        minX = Math.min(minX, p.x);             maxX = Math.max(maxX, p.x + t.w);
        minY = Math.min(minY, p.y);             maxY = Math.max(maxY, p.y + t.h);
    }
    if (minX > maxX) { minX = 0; maxX = 2; minY = 0; maxY = 2; }
    const cx = (minX + maxX) / 2;
    const spec = {
        dryMass, fuelCap, thrust,
        box: { minX, maxX, minY, maxY },
        width: (maxX - minX) * PART_PX,
        height: (maxY - minY) * PART_PX,
        centerX: cx,                     // 船的中轴（格坐标）
        bottomY: minY,                   // 最底下（发动机喷口）
        corners: null,                   // 下面填
        com: { x: 0, y: 0 },             // 质心（本地像素坐标）
    };
    spec.corners = shipCollisionPoints(def, spec);
    spec.com = shipCenterOfMass(def, spec);
    return spec;
}

// ==================== 质心（重心）====================
// 航天器应该绕自己的重心旋转，而不是绕控制舱、也不是绕船底。
// 做法：每个部件的质量放在它自己的几何中心上，加权平均。
//   燃料算在燃料箱里 —— 所以油烧掉后，重心会往船头方向偏。
export function shipCenterOfMass(def, spec, fuelRatio) {
    const P = PART_PX;
    const fr = (typeof fuelRatio === 'number') ? fuelRatio : 1;   // 默认按满油算
    const cx = spec.centerX;
    const bottom = spec.box.maxY;
    let mx = 0, my = 0, total = 0;

    for (const p of def.parts) {
        const t = PART_TYPES[p.type];
        if (!t) continue;
        // 部件质量：燃料箱里有多少油，就算多少燃料质量（质量随燃料减少）
        const partFuel = t.fuel * fr;
        const m = t.mass + partFuel;
        if (m <= 0) continue;
        // 部件几何中心（本地像素：x 以中轴为 0，y 以底面为 0、向上为负）
        const px = (p.x + t.w / 2 - cx) * P;
        const py = (bottom - (p.y + t.h / 2)) * P;
        mx += px * m;
        my += py * m;
        total += m;
    }
    if (total <= 0) return { x: 0, y: 0 };
    return { x: mx / total, y: my / total };
}

// ==================== 碰撞箱 ====================
// 飞船不是"一个点" —— 有大小、还会转。
// 所以取一圈轮廓点（船体的四个角 + 每个部件的外角），
// 撞地判定看「哪个点最低」，着陆就贴在那个点上，这样船才不会插进地里。
export function shipCollisionPoints(def, spec) {
    const P = PART_PX;
    const cx = spec.centerX;
    const bottom = spec.box.maxY;
    const pts = [];
    const seen = {};

    function add(gx, gy) {
        const key = gx.toFixed(2) + ',' + gy.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        // 网格坐标（y 向上）→ 船体本地像素（x 以中轴为 0，y 以底面为 0、向上为负）
        pts.push({ x: (gx - cx) * P, y: (bottom - gy) * P });
    }

    // 整体包围盒的四个角
    add(spec.box.minX, spec.box.minY);
    add(spec.box.maxX, spec.box.minY);
    add(spec.box.minX, spec.box.maxY);
    add(spec.box.maxX, spec.box.maxY);

    // 每个部件的四个角（这样凹凸的外形也能被算进去）
    for (const p of def.parts) {
        const t = PART_TYPES[p.type];
        if (!t) continue;
        add(p.x, p.y);
        add(p.x + t.w, p.y);
        add(p.x, p.y + t.h);
        add(p.x + t.w, p.y + t.h);
    }
    return pts;
}

