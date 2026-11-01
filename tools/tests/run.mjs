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
    t.resetPauseState();   // 归零 ESC 菜单开合 + paused（模块级状态，防用例间泄漏）
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
    const full = shipCenterOfMass(def, s, p => PART_TYPES[p.type].fuel);   // 满油
    const dry = shipCenterOfMass(def, s, () => 0);                          // 空油
    near(full.y, 2730 / 115, 1e-6, '满油质心高度');
    near(full.x, 0, 1e-9, '满油质心水平');
    near(dry.y, 1750 / 75, 1e-6, '空油质心高度');
    assert(dry.y < full.y, '油烧掉后质心应向船头（上）移');
});

// ============================================================
console.log('\n== Phase3 修复回归 ==');

const { GRAVITY_MU } = await import('../../js/world/planet.js');
const { __debugLastSteps, predictPathOrigin } = await import('../../js/physics/prediction.js');

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

test('[燃料] 油箱被炸：油跟箱子走，不留幽灵燃料（按箱模型）', () => {
    t.setShipDef({ version: 1, name: '双箱船', parts: [
        { id: 'g1', type: 'capsule', x: 0, y: 0 },
        { id: 'g2', type: 'tank',    x: 0, y: 2 },
        { id: 'g3', type: 'tank',    x: 0, y: 5 },
        { id: 'g4', type: 'engine',  x: 0, y: 8 },
    ]});
    t.vessels.splice(1);
    t.resetInterp();
    const tank1 = t.shipDef.parts.find(p => p.id === 'g2');
    const tank2 = t.shipDef.parts.find(p => p.id === 'g3');
    t.destroyed.add('g2');                     // 真实时序：先标记损毁再爆炸
    t.blowUpPart(tank1, t.mainView);
    near(t.totalFuel(), 40, 1e-6, '炸第一箱后：另一箱 40 单位不受影响');
    near(t.totalRatio(), 1.0, 1e-6, '剩余油箱仍是满的（油量表跳满属正常）');
    t.destroyed.add('g3');
    t.blowUpPart(tank2, t.mainView);
    near(t.totalFuel(), 0, 1e-6, '炸第二箱后油量归零');
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

test('[预测] 点火中真空圆轨道画满一圈（旧限幅版只画 8 分钟——用户实测「画不完全」）', () => {
    // 分级燃烧中最需要看轨道：真空束缚轨道 → 解析椭圆整圈完整，逐帧随燃烧更新
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0);
    const pts = t.predictPath({ x: planet.x, y: planet.y - r0, vx: v, vy: 0 }, true, 60000000);
    assert(pts.length >= 700, '解析椭圆应画满一圈, got ' + pts.length / 2 + ' 点');
    for (let i = 0; i < pts.length; i += 2) {
        const rr = Math.hypot(pts[i] - planet.x, pts[i + 1] - planet.y);
        near(rr, r0, r0 * 0.001, '圆轨道半径恒定');
    }
});
test('[预测] 大气内点火：数值路径仍限幅（成本兜底保留）', () => {
    // 5km 稠密大气内点火 → 数值路径（限幅 + 节流仍在）
    const alt = planet.radius + 5000;
    t.predictPath({ x: planet.x, y: planet.y - alt, vx: 300, vy: 0 }, true, 80000000);
    assert(__debugLastSteps() <= 30000, '大气内数值路径应限幅, got ' + __debugLastSteps());
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

test('[预测] 缓存命中时锚点不漂移（渲染平移贴合船的契约）', () => {
    const a = { x: planet.x + 1000, y: planet.y - (planet.radius + 100000), vx: 2000, vy: 0 };
    const b = { x: planet.x + 5000, y: planet.y - (planet.radius + 100000), vx: 2000, vy: 0 };
    t.predictPath(a, true, 90000000);               // 独立的 now，避免撞前面用例的缓存
    near(predictPathOrigin().x, a.x, 1e-6, '首次计算锚点=计算时位置');
    t.predictPath(b, true, 90000000 + 30);          // 30ms 内 → 缓存命中
    near(predictPathOrigin().x, a.x, 1e-6, '缓存命中锚点不应更新为新位置');
    t.predictPath(b, true, 90000000 + 500);         // 超过自适应间隔 → 重算
    near(predictPathOrigin().x, b.x, 1e-6, '重算后锚点跟上新状态');
});

test('[相机] 相机硬锁渲染位置：任何速度/倍率下与画出来的船精确重合', () => {
    resetToGround();
    // 直接放进 500km 高的圆轨道（速度 ~2780 px/s，100x 下一帧位移 ~4600 px）
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
    const rp = t.rocketRenderPos();
    const gap = Math.hypot(t.camera.x - rp.x, t.camera.y - rp.y);
    assert(gap < 1e-6, '相机应与渲染位置精确重合, gap=' + gap.toFixed(3) + 'px');
    t.timeScaleIdx = 0;
    resetToGround();
});

test('[插值] 240Hz 帧节拍下渲染位置逐帧连续（旧实现 75% 帧零运动）', () => {
    resetToGround();
    const r0 = planet.radius + 500000;
    const v = Math.sqrt(GRAVITY_MU / r0);
    t.rocket.x = planet.x;
    t.rocket.y = planet.y - r0;
    t.rocket.vx = v;
    t.rocket.vy = 0;
    t.rocket.landed = false;
    t.rocket.state = 'idle';
    t.resetInterp();
    // 预热：插值对在第一次物理步进后才建立（resetInterp 让 prev=curr）
    env.pumpFrames(8, 1000 / 240);
    const deltas = [];
    let prevX = null;
    for (let i = 0; i < 232; i++) {
        env.pumpFrames(1, 1000 / 240);
        const rp = t.rocketRenderPos();
        if (prevX !== null) deltas.push(rp.x - prevX);
        prevX = rp.x;
    }
    const zeros = deltas.filter(d => Math.abs(d) < 1).length;
    assert(zeros === 0, `不应有零运动帧（旧实现 75% 零运动）, got ${zeros}/${deltas.length}`);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    near(avg, v / 240, v / 240 * 0.3, '平均帧位移');
    const max = Math.max(...deltas.map(Math.abs));
    assert(max < (v / 60) * 1.05, '最大帧位移 ' + max.toFixed(1) + 'px 不应超过一个物理步 46.4px');
    t.timeScaleIdx = 0;
    resetToGround();
});

test('[降落伞] 状态机：展开 → 切断 → 落地重包', () => {
    t.setShipDef({ version: 1, name: '伞船', parts: [
        { id: 'c1', type: 'capsule', x: 0, y: 0 },
        { id: 'c2', type: 'chute',   x: 0, y: 2 },
    ]});
    t.resetInterp();
    assert(t.hasChute() === true, '应有伞');
    t.toggleChute();
    assert(t.chuteStateOf('c2') === 'open', 'P 后应展开');
    t.toggleChute();
    assert(t.chuteStateOf('c2') === 'cut', '再按应切断');
    t.rocket.landed = true;
    t.toggleChute();
    assert(t.chuteStateOf('c2') === 'packed', '落地后按 P 应重包');
    t.toggleChute();
    assert(t.chuteStateOf('c2') === 'open', '重包后可再展开');
    // 伞毁了：hasChute 为 false，toggle 只提示不动状态
    t.toggleChute();   // cut
    t.destroyed.add('c2');
    t.invalidateShipCache();
    assert(t.hasChute() === false, '伞毁后应无伞');
    const before = t.chuteStateOf('c2');
    t.toggleChute();
    assert(t.chuteStateOf('c2') === before, '无伞时状态不变');
    resetToGround();
});

test('[降落伞] 展开后减速远强于收起（10km 高、下落 800px/s）', () => {
    const fall = (deploy) => {
        t.setShipDef({ version: 1, name: '伞船', parts: [
            { id: 'c1', type: 'capsule', x: 0, y: 0 },
            { id: 'c2', type: 'chute',   x: 0, y: 2 },
        ]});
        t.resetInterp();
        t.rocket.x = planet.x;
        t.rocket.y = planet.y - (planet.radius + 10000);   // 10km 高
        t.rocket.vx = 0;
        t.rocket.vy = 800;                                  // 朝星球下落
        t.rocket.landed = false;
        t.rocket.state = 'idle';
        t.chuteStates.c2 = deploy ? 'open' : 'packed';
        env.pumpFrames(30);                                 // 0.5 游戏秒
        return Math.hypot(t.rocket.vx, t.rocket.vy);
    };
    const packed = fall(false);
    const open = fall(true);
    assert(packed > 750, '收伞应继续加速, speed=' + packed.toFixed(0));
    assert(open < packed * 0.6, '开伞应大幅减速: open=' + open.toFixed(0) + ' vs packed=' + packed.toFixed(0));
    resetToGround();
});

test('[着陆姿态] shipTiltDeg：竖直 0° / 横躺 90° / 倒扣 180°', () => {
    resetToGround();
    t.rocket.angle = 90;
    near(t.shipTiltDeg(90), 0, 1e-6, '竖直');
    t.rocket.angle = 180;
    near(t.shipTiltDeg(180), 90, 1e-6, '横躺');
    t.rocket.angle = 270;
    near(t.shipTiltDeg(270), 180, 1e-6, '倒扣');
    resetToGround();
});

test('[造船] 悬空零件载入过滤：保留含控制舱的连通组', () => {
    // 用户实测的坏船：主船 + 三个悬空降落伞（截图 bug）
    const bad = { version: 1, name: '坏船', parts: [
        { id: 'm1', type: 'capsule', x: 0, y: 0 },
        { id: 'm2', type: 'tank',    x: 0, y: 2 },
        { id: 'm3', type: 'engine',  x: 0, y: 5 },
        { id: 'f1', type: 'chute',   x: 20, y: 0 },
        { id: 'f2', type: 'chute',   x: 22, y: 0 },
        { id: 'f3', type: 'chute',   x: 24, y: 0 },
    ]};
    const fixed = t.sanitizeShipDef(bad);
    assert(fixed.dropped === 3, '应丢弃 3 个悬空件, got ' + fixed.dropped);
    assert(fixed.def.parts.length === 3, '应保留主船 3 件');
    assert(fixed.def.parts.some(p => p.type === 'capsule'), '保留组应含控制舱');
    // 含控制舱的小组 优先于 无控制舱的大组
    const bad2 = { version: 1, name: 'x', parts: [
        { id: 'a', type: 'tank',    x: 0, y: 0 },
        { id: 'b', type: 'tank',    x: 0, y: 3 },
        { id: 'c', type: 'capsule', x: 30, y: 0 },
    ]};
    const fixed2 = t.sanitizeShipDef(bad2);
    assert(fixed2.def.parts.length === 1 && fixed2.def.parts[0].type === 'capsule',
           '应保留控制舱所在组（哪怕它更小）');
    assert(fixed2.dropped === 2, '应丢弃 2 个悬空件');
    // 正常船不受影响
    assert(t.sanitizeShipDef({ version: 1, name: 'ok', parts: [
        { id: 'k1', type: 'capsule', x: 0, y: 0 },
        { id: 'k2', type: 'engine',  x: 0, y: 2 },
    ]}).dropped === 0, '连通船不应被修整');
    resetToGround();
});

test('[多船] activateVessel：接管残骸、旧主船降级、可切回（部件世界位置全程不变）', () => {
    // 双舱船：炸掉中间油箱 → 分成两截，born 截必含控制舱
    t.setShipDef({ version: 1, name: '双舱船', parts: [
        { id: 'p1', type: 'tank',    x: 0, y: 0 },
        { id: 'p2', type: 'capsule', x: 0, y: 2 },
        { id: 'p3', type: 'tank',    x: 0, y: 5 },
        { id: 'p4', type: 'capsule', x: 0, y: 7 },
    ]});
    t.resetInterp();
    // 部件世界坐标 = 锚点 + 旋转(本地 - 质心)——分离/接管/切回全程不应变化
    const partWorld = (spec, rk, p) => {
        const ty = PART_TYPES[p.type];
        const lx = (p.x + ty.w / 2 - spec.centerX) * 7;
        const ly = (spec.box.maxY - (p.y + ty.h / 2)) * 7;
        const a = (rk.angle - 90) * Math.PI / 180;
        return {
            x: rk.x + (lx - spec.com.x) * Math.cos(a) - (ly - spec.com.y) * Math.sin(a),
            y: rk.y + (lx - spec.com.x) * Math.sin(a) + (ly - spec.com.y) * Math.cos(a),
        };
    };
    const p2 = t.shipDef.parts.find(p => p.id === 'p2');
    const p4 = t.shipDef.parts.find(p => p.id === 'p4');
    const p2Before = partWorld(t.SPEC, t.rocket, p2);

    t.destroyed.add('p3');
    t.invalidateShipCache();
    t.checkSeparation();
    assert(t.vessels.length === 2, '应分成两截');
    const born = t.vessels[1];
    assert(t.vesselHasCapsule(born), 'born 截应含控制舱');
    const mainAnchorAfterSplit = { x: t.rocket.x, y: t.rocket.y };   // 分离会把锚点挪到新质心
    // 分离本身不跳位（锚点会挪到新质心，部件不动）
    near(partWorld(t.SPEC, t.rocket, p2).x, p2Before.x, 1e-6, '分离后 p2 世界位置 X');
    near(partWorld(t.SPEC, t.rocket, p2).y, p2Before.y, 1e-6, '分离后 p2 世界位置 Y');
    const bornPos = { x: born.x, y: born.y };

    // 接管 born：主视图换入 born 的状态
    assert(t.activateVessel(born.id) === true, '接管应成功');
    near(t.rocket.x, bornPos.x, 1e-6, '接管后锚点 = born');
    near(t.rocket.y, bornPos.y, 1e-6, '接管后锚点 = born');
    assert(t.shipDef.parts.length === 1 && t.shipDef.parts[0].id === 'p4', 'shipDef 应换成 born 的');
    assert(t.vessels.length === 2, '世界里仍是两艘');
    // 不变式：vessels 里有且仅有一个 mainView 条目（id = activeVesselId），位置不限
    assert(t.vessels.filter(v => v.id === 'v0').length === 1, '主视图条目有且仅有一个');
    near(partWorld(t.SPEC, t.rocket, p4).x, partWorld(born.spec, born, p4).x, 1e-6, '接管后 p4 世界位置 X');
    near(partWorld(t.SPEC, t.rocket, p4).y, partWorld(born.spec, born, p4).y, 1e-6, '接管后 p4 世界位置 Y');

    // cycleVessel 切回：锚点与部件位置全部复原
    t.cycleVessel();
    near(t.rocket.x, mainAnchorAfterSplit.x, 1e-6, '切回后锚点 = 分离后的主段锚点');
    near(t.rocket.y, mainAnchorAfterSplit.y, 1e-6, '切回后锚点 = 分离后的主段锚点');
    near(partWorld(t.SPEC, t.rocket, p2).x, p2Before.x, 1e-6, '切回后 p2 世界位置 X');
    near(partWorld(t.SPEC, t.rocket, p2).y, p2Before.y, 1e-6, '切回后 p2 世界位置 Y');
    resetToGround();
});

test('[多船] 残骸自旋：分离/撞击带来翻滚，着陆停转', () => {
    // 默认船炸掉油箱 → born = 发动机截；放到空中给它确定的自旋
    resetToGround();
    t.destroyed.add('d2');
    t.invalidateShipCache();
    t.checkSeparation();
    const born = t.vessels[1];
    const angle0 = born.angle;
    born.x = planet.x;
    born.y = planet.y - (planet.radius + 50000);
    born.vx = Math.sqrt(GRAVITY_MU / (planet.radius + 50000)) * 0.5;
    born.vy = 0;
    born.landed = false;
    born.spin = 45;          // 45°/s，顺时针
    env.pumpFrames(60);      // 1 游戏秒
    assert(!born.landed, '空中不应着陆');
    const turned = ((born.angle - angle0) % 360 + 360) % 360;
    near(turned, 45, 6, '1 秒应转 ~45°');
    // 着陆停转
    born.spin = 90;
    born.landed = true;
    env.pumpFrames(10);
    assert(born.spin === 0, '着陆后自旋应归零');
    resetToGround();
});

test('[多船] 船-船碰撞：相互推开、不穿过、高速互撞掉血', () => {
    resetToGround();
    t.destroyed.add('d2');
    t.invalidateShipCache();
    t.checkSeparation();
    assert(t.vessels.length === 2, '应有两截');
    const born = t.vessels[1];
    // 两船都放到 10km 高空（贴地会被地面摩擦吃掉滑行速度）：主船在左，
    // 残骸在右，相距 500px，主船以 250px/s 靠近（> DAMAGE_SPEED=120）
    const ALT = planet.radius + 10000;
    t.rocket.x = planet.x - 250;
    t.rocket.y = planet.y - ALT;
    t.rocket.vx = 250;
    t.rocket.vy = 0;
    t.rocket.landed = false;
    t.rocket.state = 'idle';
    born.x = planet.x + 250;
    born.y = planet.y - ALT;
    born.vx = 0;
    born.vy = 0;
    born.landed = false;
    t.resetInterp();
    const hpBefore = Math.min(...Object.values(t.partHP));
    env.pumpFrames(120);     // 2 游戏秒，足够撞上
    const dx = born.x - t.rocket.x;
    const ra = Math.max(t.SPEC.width, t.SPEC.height) * 0.55;
    const rb = Math.max(born.spec.width, born.spec.height) * 0.55;
    assert(Math.abs(dx) >= (ra + rb) * 0.6, '碰撞后应被推开, dx=' + dx.toFixed(0));
    assert(dx > 0, '主船不应穿过残骸');
    const hpAfter = Math.min(...Object.values(t.partHP));
    assert(hpAfter < hpBefore, '高速互撞应掉血: before=' + hpBefore + ' after=' + hpAfter);
    const bornHpMin = Math.min(...Object.values(born.hp));
    assert(bornHpMin < 120, '残骸也应掉血, min=' + bornHpMin.toFixed(1));
    const relvx = born.vx - t.rocket.vx;
    assert(relvx > 0, '碰撞后应转为相互远离');
    resetToGround();
});

test('[多船] 带伤分离：血量从主船表切过去，不再满血复活', () => {
    t.setShipDef({ version: 1, name: '三节船', parts: [
        { id: 'e1', type: 'engine',  x: 0, y: 0 },
        { id: 'm1', type: 'tank',    x: 0, y: 2 },
        { id: 'k1', type: 'capsule', x: 0, y: 5 },
    ]});
    t.vessels.splice(1);      // 多船时代 setShipDef 不清世界：测试要自己清场上残骸
    t.resetInterp();
    t.mainView._impactCooldown = 0;
    t.applyImpact(400);                       // 全船掉血（<700 不会当场炸）
    t.destroyed.add('m1');
    t.invalidateShipCache();
    t.checkSeparation();
    assert(t.vessels.length === 2, '应分成两截');
    const born = t.vessels[1];                // 发动机那截
    const engine = born.def.parts.find(p => p.type === 'engine');
    assert(born.hp[engine.id] < 110,
           `发动机血量应带伤（<110）, got ${born.hp[engine.id].toFixed(1)}（旧实现满血 120）`);
    resetToGround();
});

test('[多船] 新发射归档：换船不覆盖旧船，两船可切换', () => {
    resetToGround();
    // 当前船（默认船）归档 → 换一艘新船 → 旧船应还在世界里且可接管
    const oldPos = { x: t.rocket.x, y: t.rocket.y };
    assert(t.archiveCurrentShip() === true, '归档应成功');
    const oldShip = t.vessels.find(v => v.id !== 'v0');
    assert(!!oldShip, '旧船应在世界里');
    near(oldShip.x, oldPos.x, 1e-3, '旧船原位保留 X');
    assert(oldShip.def.name === '默认船', '旧船应带上名字');
    // 换新船（带发射台偏移验证：旧船停在发射台，新船应挪开）
    t.setShipDef({ version: 1, name: '新船', parts: [
        { id: 'n1', type: 'capsule', x: 0, y: 0 },
        { id: 'n2', type: 'engine',  x: 0, y: 2 },
    ]}, { offsetDeg: 12 });
    assert(t.shipDef.name === '新船', '新船应生效');
    near(t.rocket.angle, 102, 1e-6, '发射台被占：新船应沿表面偏移 12°');
    const alt = Math.hypot(t.rocket.x - planet.x, t.rocket.y - planet.y) - planet.radius;
    assert(alt > 0 && alt < 30, '新船应贴地（锚点在最低角上方一点）, alt=' + alt.toFixed(1));
    // 两船都有控制舱 → V 键可切回旧船
    const before = { x: t.rocket.x, y: t.rocket.y };
    t.cycleVessel();
    near(t.rocket.x, oldPos.x, 1e-6, 'V 键切回旧船');
    const back = t.vessels.find(v => v.id !== 'v0');
    assert(back.def.name === '新船', '切走的新船也应留在世界里');
    resetToGround();
});

test('[分级] 空格切断：下级沿船轴抛离、血量无损', () => {
    t.setShipDef({ version: 1, name: '分级船', parts: [
        { id: 's1', type: 'capsule',   x: 0, y: 0 },
        { id: 's2', type: 'tank',      x: 0, y: 2 },
        { id: 's3', type: 'decoupler', x: 0, y: 5 },
        { id: 's4', type: 'tank',      x: 0, y: 7 },
        { id: 's5', type: 'engine',    x: 0, y: 10 },
    ]});
    t.vessels.splice(1);
    t.resetInterp();
    const hpBefore = JSON.parse(JSON.stringify(t.partHP));
    t.activateNextStage();
    assert(t.vessels.length === 2, '应分成两级, got ' + t.vessels.length);
    assert(t.shipDef.parts.some(p => p.id === 's1') && !t.shipDef.parts.some(p => p.id === 's5'),
           '主船应是上面级（含控制舱）');
    const born = t.vessels[1];
    assert(born.def.parts.some(p => p.id === 's3'), '分离器本体应跟下级走');
    assert(born.def.parts.some(p => p.id === 's5'), '下级含发动机');
    // 轴向分离：下级向船尾方向 15px/s（下级 +12、主机反冲 -3）
    near(born.vy - t.rocket.vy, 15, 2, '轴向分离相对速度');
    // 分级不是爆炸：上面级血量无损
    for (const p of t.shipDef.parts) {
        near(t.partHP[p.id], hpBefore[p.id], 1e-6, '血量无损 ' + p.id);
    }
    assert(t.severed.size === 0, 'severed 应随下级清空');
    resetToGround();
});

test('[分级] 多级串联：两次空格 → 三截', () => {
    t.setShipDef({ version: 1, name: '三级船', parts: [
        { id: 't1', type: 'capsule',   x: 0, y: 0 },
        { id: 't2', type: 'tank',      x: 0, y: 2 },
        { id: 'd1', type: 'decoupler', x: 0, y: 5 },
        { id: 't3', type: 'tank',      x: 0, y: 7 },
        { id: 'd2', type: 'decoupler', x: 0, y: 10 },
        { id: 't4', type: 'tank',      x: 0, y: 12 },
        { id: 't5', type: 'engine',    x: 0, y: 15 },
    ]});
    t.vessels.splice(1);
    t.resetInterp();
    t.activateNextStage();   // 先抛最下面一级（y 最大的分离器）
    assert(t.vessels.length === 2, '第一级分离');
    assert(t.shipDef.parts.some(p => p.id === 'd1'), '上面的分离器应留在主船上等待下次分级');
    t.activateNextStage();   // 再抛中间级
    assert(t.vessels.length === 3, '第二级分离');
    assert(t.shipDef.parts.length === 2, '主船只剩上面级');
    assert(t.severed.size === 0, 'severed 清空');
    resetToGround();
});

test('[分级] 侧挂分离器：切不断船体 → 整根脱离', () => {
    t.setShipDef({ version: 1, name: '侧挂船', parts: [
        { id: 'w1', type: 'capsule',   x: 0, y: 0 },
        { id: 'w2', type: 'engine',    x: 0, y: 2 },
        { id: 'w3', type: 'decoupler', x: 20, y: 0 },
    ]});
    t.vessels.splice(1);
    t.resetInterp();
    t.activateNextStage();
    assert(t.vessels.length === 2, '分离器应自成一小船');
    assert(t.shipDef.parts.length === 2, '主船不再含分离器');
    const det = t.vessels[1];
    assert(det.def.parts.length === 1 && det.def.parts[0].type === 'decoupler', '单件小船');
    assert(t.severed.size === 0, 'severed 清空');
    resetToGround();
});

// ============================================================

console.log('\n== ESC 暂停菜单 ==');

const ESC_DOWN = { code: 'Escape', repeat: false, preventDefault() {} };

test('ESC 开合暂停：paused 随之切换，键盘自动重复不翻转', () => {
    resetToGround();
    t.onKeyDown(ESC_DOWN);
    assert(t.paused === true, '按 ESC 后应处于暂停');
    t.onKeyDown({ code: 'Escape', repeat: true, preventDefault() {} });
    assert(t.paused === true, 'repeat 的 ESC 不应翻转暂停');
    t.onKeyDown(ESC_DOWN);
    assert(t.paused === false, '再按 ESC 应解除暂停');
});

test('暂停中物理冻结：点火后暂停位置不动，恢复后继续上升', () => {
    resetToGround();
    t.toggleEngine();                       // 点火起飞
    t.paused = true;
    const d0 = Math.hypot(rocket.x - planet.x, rocket.y - planet.y);
    env.pumpFrames(30);
    const d1 = Math.hypot(rocket.x - planet.x, rocket.y - planet.y);
    assert(d1 === d0, `暂停中 30 帧船不应移动（位移 ${d1 - d0}）`);
    t.paused = false;
    env.pumpFrames(30);
    const d2 = Math.hypot(rocket.x - planet.x, rocket.y - planet.y);
    assert(d2 > d1, '恢复后船应继续上升');
    assertFinite(rocket, ['x', 'y', 'vx', 'vy'], 'rocket');
    t.toggleEngine();                       // 关机，别把点火状态带给下个用例
    resetToGround();
});

test('菜单开着时游戏键全部失效（防隔山打牛），恢复后生效', () => {
    resetToGround();
    t.onKeyDown(ESC_DOWN);                  // 暂停
    t.onKeyDown({ code: 'KeyE', repeat: false, preventDefault() {} });
    assert(rocket.state !== 'firing', '暂停中不应能点火');
    const achEl = env.elements.get('achievement-panel');
    t.onKeyDown({ code: 'KeyC', repeat: false, preventDefault() {} });
    assert(achEl.style.display !== 'block', '暂停中不应能打开成就面板');
    t.onKeyDown(ESC_DOWN);                  // 恢复
    assert(t.paused === false, '再按 ESC 应恢复');
    t.onKeyDown({ code: 'KeyE', repeat: false, preventDefault() {} });
    assert(rocket.state === 'firing', '恢复后点火应生效');
    t.onKeyDown({ code: 'KeyC', repeat: false, preventDefault() {} });
    assert(achEl.style.display === 'block', '恢复后成就面板应能打开');
    t.onKeyDown({ code: 'KeyC', repeat: false, preventDefault() {} });   // 关面板
    t.toggleEngine();                       // 关机
    resetToGround();
});

test('暂停/恢复不改时间倍率档位', () => {
    resetToGround();
    t.timeScaleIdx = 3;
    t.onKeyDown(ESC_DOWN);
    t.onKeyDown(ESC_DOWN);
    assert(t.timeScaleIdx === 3, `暂停/恢复不应改倍率档，现在是 ${t.timeScaleIdx}`);
    t.timeScaleIdx = 0;
});

test('window.togglePauseMenu 桥接存在（触控端 ☰ 按钮依赖）', () => {
    resetToGround();
    assert(typeof window.togglePauseMenu === 'function', 'window.togglePauseMenu 应存在');
    window.togglePauseMenu();
    assert(t.paused === true, '桥接开菜单应同步暂停');
    window.togglePauseMenu();
    assert(t.paused === false, '桥接关菜单应解除暂停');
});

test('菜单开着泵帧无帧错误（帧守卫）', () => {
    resetToGround();
    window.__lastGameError = undefined;     // __lastGameError 粘滞，先清基线
    t.onKeyDown(ESC_DOWN);
    env.pumpFrames(60);
    assert(window.__lastGameError === undefined || window.__lastGameError === null,
           '暂停期间渲染循环不应抛错: ' + (window.__lastGameError && window.__lastGameError.message));
    t.onKeyDown(ESC_DOWN);
    env.pumpFrames(10);
    assert(window.__lastGameError === undefined || window.__lastGameError === null,
           '恢复后渲染循环不应抛错');
});

// ============================================================

console.log('\n== 天空与星空 ==');
const sky = await import('../../js/render/sky.js');

test('skyTint：太空纯黑 / 地表全蓝 / 单调过渡 / 越界钳制', () => {
    const t0 = sky.skyTint(0);
    assert(t0.r === sky.SPACE_RGB.r && t0.g === sky.SPACE_RGB.g && t0.b === sky.SPACE_RGB.b,
        'dens=0 应为太空底色: ' + JSON.stringify(t0));
    const t1 = sky.skyTint(1);
    assert(t1.r === sky.SURFACE_SKY_RGB.r && t1.g === sky.SURFACE_SKY_RGB.g && t1.b === sky.SURFACE_SKY_RGB.b,
        'dens=1 应为地表天空色: ' + JSON.stringify(t1));
    const tOver = sky.skyTint(5);
    assert(tOver.r === t1.r && tOver.g === t1.g && tOver.b === t1.b, 'dens>1 应钳到地表色');
    let last = -1;
    for (let d = 0; d <= 1.001; d += 0.1) {
        const c = sky.skyTint(d).r;
        assert(c >= last, '天空色应随密度单调变亮: ' + d + ' → ' + c);
        last = c;
    }
});

test('starVisibility：地表 0 / 太空 1 / 单调', () => {
    assert(sky.starVisibility(1) === 0, '地表不应看见星星');
    assert(sky.starVisibility(0) === 1, '太空应满星');
    assert(sky.starVisibility(5) === 0, '越界应钳为 0');
    let last = 2;
    for (let d = 0; d <= 1.001; d += 0.1) {
        const v = sky.starVisibility(d);
        assert(v <= last, '星星可见度应随密度单调下降: ' + d + ' → ' + v);
        last = v;
    }
});

test('星表 seeded 确定性：同 seed 逐字节一致，crosses 在末尾', () => {
    const a = sky.makeStarLayer(42, 800, 600, 50, { crosses: 5 });
    const b = sky.makeStarLayer(42, 800, 600, 50, { crosses: 5 });
    assert(JSON.stringify(a) === JSON.stringify(b), '同 seed 星表应完全一致');
    const c = sky.makeStarLayer(43, 800, 600, 50, { crosses: 5 });
    assert(JSON.stringify(a) !== JSON.stringify(c), '不同 seed 星表应不同');
    for (const s of a) {
        assert(s.x >= 0 && s.x < 800 && s.y >= 0 && s.y < 600, '星星应在画布范围内');
        assert(s.c >= 0 && s.c < sky.STAR_COLORS.length, '色档应合法');
    }
    assert(a.slice(45).every(s => s.cross) && a.slice(0, 45).every(s => !s.cross),
        'crosses 应是末尾 N 颗');
});

test('高空满星渲染泵帧无帧错误（星空/视差/天空色全链路）', () => {
    resetToGround();
    // 把船放到大气外（密度 0）：走「太空黑 + 满星 + 近层平铺」渲染分支
    t.rocket.x = planet.x;
    t.rocket.y = planet.y - (planet.radius + 500000);
    t.rocket.vx = 0; t.rocket.vy = 0;
    t.rocket.landed = false;
    t.rocket.state = 'idle';
    t.resetInterp();
    window.__lastGameError = undefined;     // 粘滞基线先清
    env.pumpFrames(60);
    assert(window.__lastGameError === undefined || window.__lastGameError === null,
           '星空渲染循环不应抛错: ' + (window.__lastGameError && window.__lastGameError.message));
    resetToGround();
});

// ============================================================

console.log('\n==========================================');
test('[守卫] 渲染循环无帧错误（开伞/分级/切船后仍每帧完整执行）', () => {
    // 回归：drawChute 曾因引用未定义的 P 让每帧抛错被防护网吞掉——
    // 表现为整帧冻结、啥都没法做（用户实测）。这类错误必须在这里现形。
    window.__lastGameError = undefined;   // 清掉前面用例可能残留的帧错误基线
    t.setShipDef({ version: 1, name: '守卫船', parts: [
        { id: 'w0', type: 'capsule',   x: 0, y: 0 },
        { id: 'w1', type: 'chute',     x: 0, y: 2 },
        { id: 'w2', type: 'decoupler', x: 0, y: 4 },
        { id: 'w3', type: 'tank',      x: 0, y: 6 },
        { id: 'w4', type: 'engine',    x: 0, y: 8 },
    ]});
    t.vessels.splice(1);
    t.resetInterp();
    t.chuteStates.w1 = 'open';          // 开伞（drawChute 每帧执行）
    t.activateNextStage();              // 分级激活（切断/开伞/警告路径全走）
    env.pumpFrames(30);
    if (t.vessels[1] && t.vesselHasCapsule(t.vessels[1])) {
        t.activateVessel(t.vessels[1].id);   // 切船
    }
    env.pumpFrames(30);
    assert(window.__lastGameError === undefined || window.__lastGameError === null,
           '渲染循环有帧错误: ' + (window.__lastGameError && window.__lastGameError.message));
    resetToGround();
    env.pumpFrames(10);
    assert(window.__lastGameError === undefined || window.__lastGameError === null,
           '切船后渲染循环仍有帧错误');
});

console.log(`结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
    console.log('\n失败用例：');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
}
