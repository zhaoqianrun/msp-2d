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
console.log('\n== Phase3 修复回归 ==');

const { GRAVITY_MU } = await import('../../js/world/planet.js');
const { __debugLastSteps } = await import('../../js/physics/prediction.js');

// 支持异步用例（loadGame 内部走 promise 链）
async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  PASS  ' + name);
    } catch (e) {
        failed++;
        failures.push(name + ' :: ' + (e && e.message));
        console.log('  FAIL  ' + name);
        console.log('        ' + (e && e.message));
    }
}

test('[ce176c8] 预测·圆轨道：解析椭圆画满一圈且半径恒定', () => {
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0);
    const pts = t.predictPath({ x: planet.x, y: planet.y - r0, vx: v, vy: 0 }, false, 1);
    assert(pts.length >= 700, '应画满 360 段，got ' + pts.length / 2 + ' 点');
    for (let i = 0; i < pts.length; i += 2) {
        const rr = Math.hypot(pts[i] - planet.x, pts[i + 1] - planet.y);
        near(rr, r0, r0 * 0.001, '圆轨道半径恒定');
    }
});

test('[ce176c8] 预测·掠地椭圆：线画到真实地表为止（旧实现提前 5km 收笔）', () => {
    const r0 = planet.radius + 1000000;
    const v = Math.sqrt(GRAVITY_MU / r0) * 0.55;   // 近点会扎进地表的椭圆
    const pts = t.predictPath({ x: planet.x, y: planet.y - r0, vx: v, vy: 0 }, false, 2);
    assert(pts.length >= 8, '应有轨迹');
    let minR = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
        const rr = Math.hypot(pts[i] - planet.x, pts[i + 1] - planet.y);
        assert(rr >= planet.radius - 1, '线不应画进地下');
        minR = Math.min(minR, rr);
    }
    assert(minR < planet.radius + 100, '应画到贴近地表, 距地表 ' + (minR - planet.radius).toFixed(0) + 'px');
});

test('[ce176c8] 预测·数值与解析互证：圆轨道半径一致', () => {
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0);
    const num = t.predictPath({ x: planet.x, y: planet.y - r0, vx: v, vy: 0 }, true, 3000000);
    for (let i = 2; i < Math.min(num.length, 200); i += 2) {
        const rr = Math.hypot(num[i] - planet.x, num[i + 1] - planet.y);
        near(rr, r0, r0 * 0.005, '数值路径半径');
    }
});

test('[ce176c8] 预测·数值路径 100ms 节流复用', () => {
    const s = { x: planet.x, y: planet.y - (planet.radius + 8), vx: 0, vy: -1 };
    const a = t.predictPath(s, true, 10000000);
    const b = t.predictPath(s, true, 10000000 + 50);
    assert(a === b, '50ms 内应复用缓存');
    const c = t.predictPath(s, true, 10000000 + 200);
    assert(c !== b, '超过 100ms 应重算');
});

test('[6938f81] 长按 .（repeat=true）不再连跳时间倍率', () => {
    resetToGround();
    const idx0 = t.timeScaleIdx;
    t.onKeyDown({ code: 'Period', repeat: true });
    assert(t.timeScaleIdx === idx0, 'repeat=true 不应换档');
    t.onKeyDown({ code: 'Period', repeat: false });
    assert(t.timeScaleIdx === idx0 + 1, '正常按应 +1 档');
    t.onKeyDown({ code: 'Comma', repeat: false });
    assert(t.timeScaleIdx === idx0, '恢复正常');
});

test('[6938f81] 100x 加速下横幅按真实时间显示 3 秒', () => {
    resetToGround();
    t.resetToasts();           // 前面用例残留的 toast（含正在显示的那条）先清掉
    t.toastQueue.push({ title: '测试', name: '横幅回归', desc: '' });
    t.timeScaleIdx = 5;      // 直接设 100x（用按键会往 toast 队列里塞 10 条倍率提示，污染断言）
    assert(t.timeScaleIdx === 5, '应处于 100x 档');
    env.pumpFrames(30);      // 0.5 真实秒（旧实现这里游戏时间已过 ~50 秒，横幅早没了）
    const el = env.elements.get('achievement');
    assert(el.style.opacity === '1', '横幅应仍在显示, opacity=' + el.style.opacity);
    env.pumpFrames(220);     // 再过 ~3.7 真实秒
    assert(el.style.opacity === '0', '3 秒后横幅应消失');
    t.timeScaleIdx = 0;
    assert(t.timeScaleIdx === 0, '应降回 1x');
});

test('[c54de99] 分离摆位：分离瞬间发动机与控制舱的世界位置保持不变', () => {
    resetToGround();
    env.pumpFrames(3);
    const P = 7;
    const a0 = (t.rocket.angle - 90) * Math.PI / 180;
    const worldOf = (lx, ly) => ({
        x: t.rocket.x + (lx - t.SPEC.com.x) * Math.cos(a0) - (ly - t.SPEC.com.y) * Math.sin(a0),
        y: t.rocket.y + (lx - t.SPEC.com.x) * Math.sin(a0) + (ly - t.SPEC.com.y) * Math.cos(a0),
    });
    const engineW = worldOf((0 + 1 - t.SPEC.centerX) * P, (t.SPEC.box.maxY - (0 + 1)) * P);
    const capsuleW = worldOf((0 + 1 - t.SPEC.centerX) * P, (t.SPEC.box.maxY - (5 + 1)) * P);

    t.destroyed.add('d2');
    t.invalidateShipCache();
    t.checkSeparation();
    assert(t.vessels.length === 2, '应分离成两截');
    const born = t.vessels[1];   // 发动机那截
    // 发动机在新截的本地中心 = (0,7)，新质心也在 (0,7) → 世界位置就是 v.x/v.y
    near(born.x, engineW.x, 1e-3, '发动机世界 X');
    near(born.y, engineW.y, 1e-3, '发动机世界 Y');
    // 主段（控制舱）锚点也挪过：舱体世界位置同样不变
    const capsuleAfter = worldOf((0 + 1 - t.SPEC.centerX) * P, (t.SPEC.box.maxY - (5 + 1)) * P);
    near(capsuleAfter.x, capsuleW.x, 1e-3, '控制舱世界 X');
    near(capsuleAfter.y, capsuleW.y, 1e-3, '控制舱世界 Y');
    resetToGround();
});

test('[c54de99] 双油箱逐个炸掉：油量按活油箱份额扣，不留幽灵燃料', () => {
    t.setShipDef({ version: 1, name: '双箱船', parts: [
        { id: 'g1', type: 'engine',  x: 0, y: 0 },
        { id: 'g2', type: 'tank',    x: 0, y: 2 },
        { id: 'g3', type: 'tank',    x: 0, y: 5 },
        { id: 'g4', type: 'capsule', x: 0, y: 8 },
    ]});
    env.pumpFrames(2);
    const tank1 = t.shipDef.parts.find(p => p.id === 'g2');
    const tank2 = t.shipDef.parts.find(p => p.id === 'g3');
    t.blowUpPart(tank1, t.mainView);
    near(t.rocket.fuel, 0.5, 1e-9, '炸第一箱后');
    t.destroyed.add('g2');
    t.blowUpPart(tank2, t.mainView);
    near(t.rocket.fuel, 0, 1e-9, '炸第二箱后（旧实现会剩 25% 幽灵燃料）');
    assert(t.debris.length >= 14, '应生成碎片');
    const d = t.debris[0];
    assert(Math.hypot(d.x - t.rocket.x, d.y - t.rocket.y) < 100, '碎片应落在肇事船附近');
    resetToGround();
});

test('[6938f81] 单机模式不再空打 /api/state', () => {
    resetToGround();
    let calls = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { calls++; throw new TypeError('counted'); };
    env.pumpFrames(70);
    globalThis.fetch = oldFetch;
    assert(calls === 0, '不应有任何请求, got ' + calls);
});

await testAsync('[6938f81] 读档只恢复相机 x/y/zoom，minZoom 不被旧档覆盖', async () => {
    resetToGround();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            rocket: { x: planet.x, y: planet.y - planet.radius - 100, vx: 0, vy: 0,
                      angle: 90, throttle: 0.5, fuel: 0.5, state: 'idle', landed: false },
            camera: { x: 111, y: 222, zoom: 0.5, minZoom: 0.5, maxZoom: 3 },
        }),
    });
    env.win.loadGame();
    await new Promise(r => setTimeout(r, 20));
    globalThis.fetch = oldFetch;
    near(t.camera.x, 111, 1e-9, '相机 X');
    near(t.camera.zoom, 0.5, 1e-9, '缩放');
    assert(t.camera.minZoom === 0.0001, 'minZoom 不应被存档覆盖, got ' + t.camera.minZoom);
    assert(t.camera.maxZoom === 12, 'maxZoom 不应被存档覆盖');
    resetToGround();
});

test('[预测] 点火中预测限幅：近轨道椭圆不再全圈积分（上升段顿挫元凶）', () => {
    // 500km 高、0.9 倍圆轨道速度 → 椭圆一圈约 40 万步；点火中必须被限到 3 万步内
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0) * 0.9;
    t.predictPath({ x: planet.x, y: planet.y - r0, vx: v, vy: 0 }, true, 60000000);
    assert(__debugLastSteps() <= 30000, '点火中应限幅 3 万步, got ' + __debugLastSteps());
});

test('[输入] 100x 下旋转按真实时间响应：10 帧约 15°，不再一帧转一圈', () => {
    resetToGround();
    t.timeScaleIdx = 5;      // 100x
    const a0 = t.rocket.angle;
    t.keys.left = true;
    env.pumpFrames(10);
    t.keys.left = false;
    const d = t.rocket.angle - a0;
    near(Math.abs(d), 15, 3, '10 帧 @100x 应转 ~15°（90°/真实秒，方向随按键）');
    t.timeScaleIdx = 0;
    resetToGround();
});

test('[相机] 100x 加速下相机跟得住：飞船不出半屏', () => {
    resetToGround();
    // 直接放进 500km 高的圆轨道（速度 ~2780 px/s，100x 下一帧位移 ~1.2 万 px）
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0);
    t.rocket.x = planet.x;
    t.rocket.y = planet.y - r0;
    t.rocket.vx = v;
    t.rocket.vy = 0;
    t.rocket.landed = false;
    t.rocket.state = 'idle';
    t.camera.x = t.rocket.x;
    t.camera.y = t.rocket.y;
    t.camera.zoom = 1;
    t.timeScaleIdx = 5;      // 100x
    env.pumpFrames(30);
    const gap = Math.hypot(t.camera.x - t.rocket.x, t.camera.y - t.rocket.y);
    const maxGap = 1280 * 0.5 / t.camera.zoom;   // headless 视口 1280
    assert(gap <= maxGap * 1.05 + 1, '相机-飞船距离 ' + gap.toFixed(0) + 'px 应 ≤ 半屏 ' + maxGap.toFixed(0) + 'px');
    t.timeScaleIdx = 0;
    resetToGround();
});

// ============================================================

console.log('\n==========================================');
console.log(`结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
    console.log('\n失败用例：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
}
