# -*- coding: utf-8 -*-
# 一次性移植脚本：新发射归档（多船共存）+ 发射台偏移 + 观察站闭环，跑完即删
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8', newline='\n').read()
    for old, new in pairs:
        assert s.count(old) == 1, path + ' marker x%d: %s' % (s.count(old), old[:60])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('patched', path)

# ============ js/main.js ============
main_pairs = []

# 1) placeOnSurface 支持沿表面偏移（发射台被占时挪一个身位）
main_pairs.append((
"""        function placeOnSurface() {
            rocket.x = planet.x;
            rocket.y = planet.y - planet.radius;
            for (let i = 0; i < 8; i++) {""",
"""        function placeOnSurface(offsetDeg) {
            rocket.x = planet.x;
            rocket.y = planet.y - planet.radius;
            if (offsetDeg) {
                // 发射台被占：位置绕球心旋转挪开，机头保持垂直于当地表面
                const rad = offsetDeg * Math.PI / 180;
                const cosO = Math.cos(rad), sinO = Math.sin(rad);
                const rx = rocket.x - planet.x, ry = rocket.y - planet.y;
                rocket.x = planet.x + rx * cosO - ry * sinO;
                rocket.y = planet.y + rx * sinO + ry * cosO;
                rocket.angle = ((rocket.angle + offsetDeg) % 360 + 360) % 360;
            }
            for (let i = 0; i < 8; i++) {"""
))

# 2) setShipDef 透传偏移 + 新船伞重包
main_pairs.append((
"""        function setShipDef(def) {
            shipDef = def;
            pristineShip = JSON.parse(JSON.stringify(def));   // 重置（R）时回到这艘
            SPEC = shipSpec(shipDef);
            destroyed = new Set();
            partHP = initPartHP();
            partTemp = initPartTemp();
            invalidateShipCache();
            resetImpactBudget();
            rocket.fuel = 1;
            lastComFuel = -1;   // 换船后质心必须重算
            rocket.throttle = 1;
            rocket.state = 'idle';
            placeOnSurface();
            resetInterp();
            chuteState = 'packed';   // 新船的伞是包好的
        }""",
"""        function setShipDef(def, opts) {
            shipDef = def;
            pristineShip = JSON.parse(JSON.stringify(def));   // 重置（R）时回到这艘
            SPEC = shipSpec(shipDef);
            destroyed = new Set();
            partHP = initPartHP();
            partTemp = initPartTemp();
            invalidateShipCache();
            resetImpactBudget();
            rocket.fuel = 1;
            lastComFuel = -1;   // 换船后质心必须重算
            rocket.throttle = 1;
            rocket.state = 'idle';
            placeOnSurface(opts && opts.offsetDeg);
            resetInterp();
            chuteState = 'packed';   // 新船的伞是包好的
        }"""
))

# 3) archiveCurrentShip（插在 setShipDef 之后、任务存档段之前）
main_pairs.append((
"""        // ==================== 本局任务自动存档 ====================""",
"""        // ==================== 多船共存：旧船归档 ====================
        // 换船发射时不再覆盖旧船 —— 把当前主船整体物化成世界里的一艘
        // 可接管船（原位保留：在飞就继续飞，着陆就停在原地）。
        const SHIP_CAP = 8;   // 世界并存船只上限（含当前操控的）
        function archiveCurrentShip() {
            const others = vessels.filter(v => v.id !== activeVesselId);
            if (others.length >= SHIP_CAP - 1) {
                const retired = others.find(v => v.landed) || others[0];
                if (!retired) return false;
                vessels = vessels.filter(v => v !== retired);
                toastQueue.push({
                    title: '船 舶 退 役',
                    name: (retired.def.name || '最老的一艘船') + ' 已移出世界',
                    desc: '世界最多保留 ' + SHIP_CAP + ' 艘船',
                });
            }
            const old = makeVessel(shipDef.parts, rocket.x, rocket.y,
                                   rocket.vx, rocket.vy, rocket.angle, rocket.fuel);
            old.hp = partHP;
            old.temp = partTemp;
            old.dead = destroyed;
            old.def = shipDef;
            old.spec = SPEC;
            old.def.name = shipDef.name || '旧船';
            old.throttle = rocket.throttle;
            old.state = rocket.state === 'firing' ? 'idle' : rocket.state;
            old.landed = rocket.landed;
            old.heat = rocket.heat || 0;
            old._impactCooldown = 0;
            old._impactBudget = {};
            const idx = vessels.indexOf(mainView);
            if (idx >= 0) vessels[idx] = old; else vessels.push(old);
            return true;
        }

        // ==================== 本局任务自动存档 ===================="""
))

# 4) loadShipFromServer：归档旧船 + 发射台偏移
main_pairs.append((
"""                if (missionRestored && shipPartsSig(parts) === missionSig) return;
                // 换了一艘船（或在造船厂造了新的搭配）—— 旧任务作废
                clearMission();""",
"""                if (missionRestored && shipPartsSig(parts) === missionSig) return;
                // —— 多船共存：换船发射不再覆盖旧船 ——
                // 当前船若还活着，整体归档为世界里可接管的船（原位保留）。
                if (alivePartCount() > 0 && !archiveCurrentShip()) return;
                // 换了一艘船（或在造船厂造了新的搭配）—— 旧任务作废
                clearMission();"""
))
main_pairs.append((
"""                setShipDef({ version: 1, name: d.ship.name || '无名', parts });
                try { localStorage.setItem('msp2d-ship', JSON.stringify(shipDef)); } catch (e) {}
                toastQueue.push({
                    name: shipDef.name,
                    desc: `控制舱 ${parts.filter(p=>p.type==='capsule').length}　燃料箱 ${parts.filter(p=>p.type==='tank').length}　发动机 ${parts.filter(p=>p.type==='engine').length}　质量 ${SPEC.dryMass + SPEC.fuelCap}`,
                    title: '飞 船 已 装 载'
                });""",
"""                // 发射台被占（旧船停在那）就沿表面挪一个身位
                const padBusy = vessels.some(v => v.id !== activeVesselId && v.landed &&
                    Math.hypot(v.x - planet.x, v.y - (planet.y - planet.radius)) < 500);
                setShipDef({ version: 1, name: d.ship.name || '无名', parts },
                           { offsetDeg: padBusy ? 12 : 0 });
                try { localStorage.setItem('msp2d-ship', JSON.stringify(shipDef)); } catch (e) {}
                toastQueue.push({
                    name: shipDef.name,
                    desc: `控制舱 ${parts.filter(p=>p.type==='capsule').length}　燃料箱 ${parts.filter(p=>p.type==='tank').length}　发动机 ${parts.filter(p=>p.type==='engine').length}　质量 ${SPEC.dryMass + SPEC.fuelCap}`,
                    title: '飞 船 已 装 载'
                });"""
))

# 5) sendState：残骸载荷带 id/name（观察站接管用）
main_pairs.append((
"""                derelicts: vessels.filter(v => v.id !== activeVesselId).map(v => ({
                    x: v.x, y: v.y, vx: v.vx, vy: v.vy, angle: v.angle,""",
"""                derelicts: vessels.filter(v => v.id !== activeVesselId).map(v => ({
                    id: v.id,
                    name: v.def.name || ('残骸 ' + v.id),
                    x: v.x, y: v.y, vx: v.vx, vy: v.vy, angle: v.angle,"""
))

# 6) ?vessel= 接管（开局初始化之后）
main_pairs.append((
"""        resetInterp();   // 开局初始化插值状态（无论是否从任务档恢复）
        setInterval(pollControl, CTRL_INTERVAL_MS);""",
"""        resetInterp();   // 开局初始化插值状态（无论是否从任务档恢复）

        // 观察站「进入并操控」：?vessel=<id> 载入后接管指定航天器
        try {
            const urlVessel = new URLSearchParams(location.search).get('vessel');
            if (urlVessel && urlVessel !== activeVesselId && !activateVessel(urlVessel)) {
                toastQueue.push({
                    title: '接 管 失 败',
                    name: '目标航天器不在世界里',
                    desc: '回到观察站刷新后再试',
                });
            }
        } catch (e) { /* 无 location（如无头测试）就跳过 */ }
        setInterval(pollControl, CTRL_INTERVAL_MS);"""
))

# 7) __test 导出
main_pairs.append((
"""            toggleChute, hasChute, shipTiltDeg, sanitizeShipDef, activateVessel, cycleVessel, vesselHasCapsule,""",
"""            toggleChute, hasChute, shipTiltDeg, sanitizeShipDef, activateVessel, cycleVessel, vesselHasCapsule,
            archiveCurrentShip,"""
))

patch('js/main.js', main_pairs)

# ============ station.html：真名 + 按控制舱给按钮 + 传 vessel id ============
station_pairs = [
(
"""        if (Array.isArray(world.derelicts)) {
            world.derelicts.forEach((d, i) => {
                items.push({
                    name: '失控残骸 #' + (i + 1),
                    derelict: true,
                    rocket: d,
                    parts: d.parts || null,
                    hasCapsule: false,
                });
            });
        }""",
"""        if (Array.isArray(world.derelicts)) {
            world.derelicts.forEach((d, i) => {
                items.push({
                    name: d.name || ('失控残骸 #' + (i + 1)),
                    vesselId: d.id || null,
                    derelict: true,
                    rocket: d,
                    parts: d.parts || null,
                    hasCapsule: (d.parts || []).some(p => p.type === 'capsule' && p.alive !== false),
                });
            });
        }"""
),
(
"""        // 按钮说实话：接管残骸的功能还没实装（play-main 不读 ?vessel= 参数），
        // 与其放一个点开发现进的还是主船的按钮，不如明确告诉玩家暂不支持
        const canEnter = !it.offline && it.hasCapsule && !it.derelict && !allDead;
        const act = it.offline
            ? '<button class="tbtn" onclick="location.href=\\'build.html\\'">去造船厂</button>'
            : (canEnter
                ? `<button class="tbtn go" onclick="enterVessel(${idx})">进入并操控</button>`
                : '<button class="tbtn" disabled style="opacity:.45;cursor:not-allowed" title="接管残骸暂未实装，游戏目前只能操控带控制舱的主船">暂不能接管</button>');""",
"""        // 带控制舱的船都可以接管（含断成两截后带舱的那截）——
        // 通过 ?vessel=<id> 让 play-main 载入后直接切换
        const canEnter = !it.offline && it.hasCapsule && !allDead;
        const act = it.offline
            ? '<button class="tbtn" onclick="location.href=\\'build.html\\'">去造船厂</button>'
            : (canEnter
                ? (it.vesselId
                    ? `<button class="tbtn go" onclick="enterVessel('${it.vesselId}')">进入并操控</button>`
                    : '<button class="tbtn go" onclick="location.href=\\'play-main.html\\'">进入并操控</button>')
                : '<button class="tbtn" disabled style="opacity:.45;cursor:not-allowed" title="这艘船没有能用的控制舱，无法接管">暂不能接管</button>');"""
),
(
"""        function enterVessel(idx) {
            // 进入游戏。有控制舱的能操控，没有的进去也只能看
            location.href = 'play-main.html?vessel=' + idx;
        }""",
"""        function enterVessel(id) {
            // 进入游戏并直接接管 ?vessel=<id> 对应的航天器
            location.href = 'play-main.html?vessel=' + encodeURIComponent(id);
        }"""
),
]
patch('station.html', station_pairs)

# ============ tools/tests/headless.mjs：location 桩 ============
patch('tools/tests/headless.mjs', [(
"""    globalThis.window = win;
    globalThis.document = documentStub;""",
"""    globalThis.window = win;
    globalThis.document = documentStub;
    globalThis.location = { search: '', port: '' };   // main.js 顶层会读 location.search"""
)])
