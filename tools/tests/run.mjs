// ==================== msp-2d 无头回归测试 ====================
// 运行：node tools/tests/run.mjs
// 原理：用 headless.mjs 的浏览器桩把 js/main.js 整个跑起来，
//       直接对真实物理/损毁/换船逻辑做断言。零依赖，node >= 18 即可。

import { installBrowserStubs } from './headless.mjs';

const env = installBrowserStubs();
const t = (await import('../../js/main.js')).__test;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  PASS  ' + name);
    } catch (e) {
        failed++;
        failures.push(name + ' :: ' + (e && e.message));
        console.log('  FAIL  ' + name);
        console.log('        ' + (e && e.message));
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(actual, want, eps, label) {
    assert(Math.abs(actual - want) <= eps, `${label || ''} 实际 ${actual}，期望 ${want} ± ${eps}`);
}
function assertFinite(obj, keys, label) {
    for (const k of keys) assert(Number.isFinite(obj[k]), `${label} 的 ${k} 不是有穷数: ${obj[k]}`);
}

const { rocket, planet } = t;

function altitude() {
    return Math.hypot(rocket.x - planet.x, rocket.y - planet.y) - planet.radius;
}

// 恢复默认船、清残骸、贴地。每个场景开头调用，保证互不污染。
function resetToGround() {
    t.setShipDef({ version: 1, name: '默认船', parts: [
        { id: 'd1', type: 'engine',  x: 0, y: 0 },
        { id: 'd2', type: 'tank',    x: 0, y: 2 },
        { id: 'd3', type: 'capsule', x: 0, y: 5 },
    ]});
    t.vessels.splice(1);   // 清掉分离出的残骸，只留主船
    env.pumpFrames(2);
}

// ============================================================
console.log('\n== 启动冒烟 ==');

test('游戏能在 Node 里启动：1 秒内无 NaN、停在地面上', () => {
    env.pumpFrames(60);
    assertFinite(rocket, ['x', 'y', 'vx', 'vy', 'fuel', 'throttle'], 'rocket');
    assert(rocket.landed === true, '开局应停在地面，landed=' + rocket.landed);
    assert(t.shipInfo().alive === 3, '默认船应有 3 个活部件');
});

test('本局任务自动存档：开跑后 localStorage 里有任务存档', () => {
    env.pumpFrames(100);   // ≈1.7 秒
    assert(env.store.has('msp2d-mission-v1'), '应有 msp2d-mission-v1');
});

// ============================================================
console.log('\n== 引力 / 大气（物理常量回归）==');

test('表面引力 = 3.71 px/s²，2R 处衰减为 1/4（平方反比）', () => {
    const g1 = t.gravityAt(planet.x, planet.y - planet.radius);
    near(g1.ay, 3.71, 1e-9, '表面引力');
    near(g1.ax, 0, 1e-9, '水平分量');
    const g2 = t.gravityAt(planet.x, planet.y - planet.radius * 2);
    near(g2.ay, 3.71 / 4, 1e-9, '2R 处引力');
});

test('大气密度：表面 1，1 标高(23.1km) ≈ 1/e，200km 以上真空', () => {
    near(t.atmosphereDensity(planet.x, planet.y - planet.radius), 1, 1e-9, '表面');
    near(t.atmosphereDensity(planet.x, planet.y - planet.radius - 23100),
         Math.exp(-1), 1e-6, '1 个标高');
    assert(t.atmosphereDensity(planet.x, planet.y - planet.radius - 220000) === 0,
           '200km+ 应为真空');
});

test('距离/速度格式化（1px=1m 口径）', () => {
    assert(t.fmtDistance(2500000) === '2500 km', 'fmtDistance(2500000)=' + t.fmtDistance(2500000));
    assert(t.fmtDistance(500) === '500 m', 'fmtDistance(500)=' + t.fmtDistance(500));
    assert(t.fmtSpeed(50) === '50.0 m/s', 'fmtSpeed(50)=' + t.fmtSpeed(50));
    assert(t.fmtSpeed(1234) === '1.23 km/s', 'fmtSpeed(1234)=' + t.fmtSpeed(1234));
});

// ============================================================
console.log('\n== 点火 / 燃料 ==');

test('点火起飞：3 秒后离地、燃料减少、再按关机', () => {
    resetToGround();
    t.toggleEngine();
    assert(rocket.state === 'firing', '点火后应为 firing');
    const f0 = rocket.fuel;
    env.pumpFrames(180);   // 3 秒
    assert(altitude() > 5, '应已离地，alt=' + altitude().toFixed(1));
    assert(rocket.fuel < f0, '燃料应减少');
    t.toggleEngine();
    assert(rocket.state === 'idle', '再按应关机');
});

// ============================================================
console.log('\n== Phase1 修复回归 ==');

test('[eef4497] 发动机烧毁：推力归零、质量实时下降、无法维持点火', () => {
    resetToGround();
    near(t.shipMass(1), 115, 1e-9, '满油质量（默认船）');
    t.destroyed.add('d1');            // 烧毁发动机
    t.invalidateShipCache();
    near(t.shipMass(1), 90, 1e-9, '发动机毁后质量（25 干重消失）');
    assert(t.thrustAccel(1, 1) === 0, '推力应为 0');
    rocket.state = 'firing';
    env.pumpFrames(60);
    assert(rocket.state === 'idle', '死发动机应被强制熄火');
});

test('[eef4497] 部件全毁：强制熄火、油门归零、「任务失败」只弹一次', () => {
    resetToGround();
    for (const id of ['d1', 'd2', 'd3']) t.destroyed.add(id);
    t.invalidateShipCache();
    rocket.state = 'firing';
    rocket.throttle = 1;
    env.pumpFrames(70);
    assert(rocket.state === 'idle', '全毁应熄火');
    assert(rocket.throttle === 0, '全毁油门应归零');
    const count = () => t.toastQueue.filter(x => x.name === '航天器已完全损毁').length;
    assert(count() === 1, '任务失败应只弹一次，got ' + count());
    t.toastQueue.length = 0;   // 清掉后继续跑，验证不会再次触发
    env.pumpFrames(120);
    assert(count() === 0, '继续跑不应重复弹');
});

test('[cf2350a] 换船：血量表按新部件 id 重建，撞击不再免疫（NaN 回归）', () => {
    resetToGround();
    t.setShipDef({ version: 1, name: '测试船', parts: [
        { id: 'x-engine',  type: 'engine',  x: 0, y: 0 },
        { id: 'x-tank',    type: 'tank',    x: 0, y: 2 },
        { id: 'x-capsule', type: 'capsule', x: 0, y: 5 },
    ]});
    const keys = Object.keys(t.partHP).sort().join(',');
    assert(keys === 'x-capsule,x-engine,x-tank', '血量表 key 应为新 id，got: ' + keys);
    assert(t.SPEC.dryMass === 75, '新船干重应为 75');
    assert(rocket.landed === true, '新船应贴地');
    t.mainView._impactCooldown = 0;
    const blew = t.applyImpact(800);   // 超过 DESTROY_SPEED=700 的重击
    assert(blew >= 1, '重击应炸掉部件，blew=' + blew);
    for (const p of t.shipDef.parts) {
        if (!t.destroyed.has(p.id)) {
            assert(Number.isFinite(t.partHP[p.id]), `部件 ${p.id} 血量应为有穷数`);
        }
    }
    resetToGround();
});

test('[eef4497] 中间炸断：分离后质量/推力按剩的那截实时算', () => {
    resetToGround();
    t.destroyed.add('d2');            // 炸掉中间的燃料箱
    t.invalidateShipCache();
    t.checkSeparation();
    assert(t.vessels.length === 2, '应分离成两截，got ' + t.vessels.length);
    assert(t.shipDef.parts.length === 1 && t.shipDef.parts[0].type === 'capsule',
           '主控应只剩控制舱');
    assert(t.shipInfo().dryMass === 30, '分离后干重应为 30，got ' + t.shipInfo().dryMass);
    assert(t.thrustAccel(1, 1) === 0, '没有发动机，推力应为 0');
    resetToGround();
    assert(t.vessels.length === 1, '重置后残骸应清掉');
});

// ============================================================
console.log('\n== 纯模块单测（直接 import 模块文件，不经过 __test）==');

const { PART_TYPES, PART_PX } = await import('../../js/ship/partTypes.js');
const { shipSpec, shipCenterOfMass } = await import('../../js/ship/shipSpec.js');
const { fmtDistance: fmtDist, fmtSpeed: fmtSpd } = await import('../../js/core/format.js');

test('[partTypes] 部件数据：发动机推力 1000、油箱容量 40（与物理口径一致）', () => {
    assert(PART_TYPES.engine.thrust === 1000, 'engine.thrust=' + PART_TYPES.engine.thrust);
    assert(PART_TYPES.tank.fuel === 40, 'tank.fuel=' + PART_TYPES.tank.fuel);
    assert(PART_PX === 7, 'PART_PX=' + PART_PX);
});

test('[shipSpec] 默认船：干重75/油容40/推力1000，14×49m，8 个碰撞点', () => {
    const def = { version: 1, name: 't', parts: [
        { id: 'a', type: 'engine',  x: 0, y: 0 },
        { id: 'b', type: 'tank',    x: 0, y: 2 },
        { id: 'c', type: 'capsule', x: 0, y: 5 },
    ]};
    const s = shipSpec(def);
    assert(s.dryMass === 75, 'dryMass=' + s.dryMass);
    assert(s.fuelCap === 40, 'fuelCap=' + s.fuelCap);
    assert(s.thrust === 1000, 'thrust=' + s.thrust);
    assert(s.width === 14 && s.height === 49, `尺寸 ${s.width}×${s.height}`);
    assert(s.box.minX === 0 && s.box.maxX === 2 && s.box.minY === 0 && s.box.maxY === 7,
           '包围盒 ' + JSON.stringify(s.box));
    assert(s.corners.length === 8, '碰撞点数=' + s.corners.length);
    assert(s.centerX === 1 && s.bottomY === 0, '中轴/底面');
});

test('[shipSpec] 质心随燃料前移（满油 23.74 → 空油 23.33）', () => {
    const def = { version: 1, name: 't', parts: [
        { id: 'a', type: 'engine',  x: 0, y: 0 },
        { id: 'b', type: 'tank',    x: 0, y: 2 },
        { id: 'c', type: 'capsule', x: 0, y: 5 },
    ]};
    const s = shipSpec(def);
    const full = shipCenterOfMass(def, s, 1);
    const dry = shipCenterOfMass(def, s, 0);
    near(full.y, 2730 / 115, 1e-6, '满油质心高度');
    near(full.x, 0, 1e-9, '满油质心水平');
    near(dry.y, 1750 / 75, 1e-6, '空油质心高度');
    assert(dry.y < full.y, '油烧掉后质心应向船头（上）移');
});

// ============================================================

console.log('\n==========================================');
console.log(`结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
    console.log('\n失败用例：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
}
