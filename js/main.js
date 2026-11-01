// ==================== 模块导入 ====================
import { PART_TYPES, PART_PX } from './ship/partTypes.js';
import { shipSpec, shipCenterOfMass } from './ship/shipSpec.js';
import {
    FIXED_DT, TIME_SCALES, ROTATE_SPEED, THROTTLE_RATE, THROTTLE_FINE_RATE,
    ZOOM_RATE_PER_SEC, FUEL_BURN_SECONDS, FUEL_FILL_RATE,
    M_PER_PX, PHYS_M_PER_PX, DIST_M_PER_PX, PLANET_RADIUS_KM, PLANET_RADIUS_M,
    ATMO_TOP_KM, ATMO_TOP_M, ATMO_RATIO, ATMO_SCALE_HEIGHT_KM, ATMO_SCALE_HEIGHT, ATMO_FADE_KM,
    SURFACE_GRAVITY_MS2, G0_PX, LANDING_SPEED, DAMAGE_SPEED, DESTROY_SPEED, PART_HP,
    HEAT_LIMIT, HEAT_COOL_RATE, AMBIENT_TEMP, DRAG_COEF, REENTRY_SPEED, GROUND_FRICTION,
} from './core/constants.js';
import { fmtDistance, fmtSpeed } from './core/format.js';
import { planet, GRAVITY_MU, gravityAt, atmosphereDensity, atmoThickness } from './world/planet.js';
import { predictPath, predictPathOrigin } from './physics/prediction.js';
import { camera } from './render/camera.js';
import { unlock, settleMission, updateAchievementToast, toggleAchievementPanel,
         resetToasts, toastQueue, achieved, achievements } from './ui/achievements.js';


        const canvas = document.getElementById('game');
        const ctx = canvas.getContext('2d');

        // ==================== 画布自适应 ====================
        // 画布铺满窗口，宇宙才有足够的显示面积。
        // 渲染分辨率跟着窗口走（考虑高 DPI），物理坐标不变。
        // 逻辑画布尺寸（绘制时统一用这两个，替代以前写死的 1000 / 700）
        let canvasW = 1000, canvasH = 700;
        function fitCanvas() {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const w = Math.max(320, window.innerWidth);
            const h = Math.max(240, window.innerHeight);
            canvas.width = Math.round(w * dpr);      // canvas.width 是物理像素
            canvas.height = Math.round(h * dpr);
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // 之后所有绘制都用逻辑坐标
            canvasW = w; canvasH = h;
        }
        fitCanvas();
        window.addEventListener('resize', () => { fitCanvas(); });
        window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 120));
        const hud = document.getElementById('hud');
        const throttleFill = document.getElementById('throttle-fill');
        const throttleText = document.getElementById('throttle-text');
        const fuelFill = document.getElementById('fuel-fill');
        const fuelText = document.getElementById('fuel-text');
        const touchControlsEl = document.getElementById('touch-controls');

        // ==================== 多端协同 ====================
        // 服务器上的服主决定每个端是「操控」还是「观战」。
        // 操控端算物理并上报；观战端不跑物理，只把服务器状态插值渲染出来。
        let clientId = "";
        try {
            clientId = localStorage.getItem("msp2d-client-id") || "";
            if (!clientId) {
                clientId = "c" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
                localStorage.setItem("msp2d-client-id", clientId);
            }
        } catch (e) { clientId = "c" + Math.random().toString(36).slice(2, 10); }

        let myRole = "control";        // 默认单人自己玩，就是操控端
        let isAdmin = false;
        let onlineCount = 1;
        let controllerId = null;
        let netMode = false;           // 有没有连上协同服务器
        let lastSentAt = 0;
        let lastCtrlPollAt = 0;
        let lastStatePollAt = 0;
        let lastRecvAt = 0;
        let lastWorldRev = -1;      // 已拿到的世界版本：>0 后走 since 增量，省流量

        // 观战端用：服务器状态 + 插值
        let remotePrev = null;
        let remoteNext = null;
        let remoteRecvTime = 0;
        const SEND_INTERVAL_MS = 100;   // 操控端每 100ms 上报一次
        const POLL_INTERVAL_MS = 100;   // 观战端每 100ms 拉一次
        const CTRL_INTERVAL_MS = 1000;  // 每 1 秒问一次自己是什么角色
        const REMOTE_TIMEOUT_MS = 3000;

        function isSpectator() { return netMode && myRole !== "control"; }

        function apiUrl(path) {
            return path + (path.indexOf("?") >= 0 ? "&" : "?") + "cid=" + encodeURIComponent(clientId);
        }

        async function pollControl() {
            try {
                const r = await fetch(apiUrl("/api/ctrl"));
                const d = await r.json();
                netMode = true;
                const changed = (d.role !== myRole);
                myRole = d.role;
                isAdmin = !!d.is_admin;
                onlineCount = d.online_count || 1;
                controllerId = d.controller || null;
                if (changed) {
                    const spectating = myRole !== "control";
                    toastQueue.push({
                        name: spectating ? "观战模式" : "操控模式",
                        desc: spectating ? "服主把你设为观战端，跟操控端一起看" : "服主把操控权交给你了，开始操作吧",
                        title: "协 同 通 知"
                    });
                }
            } catch (e) {
                netMode = false;   // 服务器不在（比如直接双击打开 html），就单机自己玩
            }
        }

        async function sendState() {
            if (isSpectator()) return;
            const now = performance.now();
            if (now - lastSentAt < SEND_INTERVAL_MS) return;
            lastSentAt = now;
            const payload = {
                rocket: { x: rocket.x, y: rocket.y, vx: rocket.vx, vy: rocket.vy, angle: rocket.angle,
                          throttle: rocket.throttle, fuel: rocket.fuel, state: rocket.state, landed: rocket.landed },
                camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
                orbits: stats.orbits,
                // 给「喵星地面观察站」看的信息
                shipName: shipDef.name || '当前航天器',
                hasCapsule: hasWorkingCapsule(),
                parts: shipDef.parts.map(p => ({ type: p.type, alive: !destroyed.has(p.id) })),
                derelicts: vessels.filter(v => v.id !== activeVesselId).map(v => ({
                    id: v.id,
                    name: v.def.name || ('残骸 ' + v.id),
                    x: v.x, y: v.y, vx: v.vx, vy: v.vy, angle: v.angle,
                    fuel: v.fuel, landed: v.landed,
                    parts: v.def.parts.map(p => ({ type: p.type, alive: !v.destroyed.has(p.id) })),
                })),
                planet: { x: planet.x, y: planet.y, radius: planet.radius },
            };
            try {
                await fetch(apiUrl("/api/state"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            } catch (e) { /* 掉线了也不影响本地继续玩 */ }
        }

        async function fetchState() {
            if (!isSpectator()) return;
            const now = performance.now();
            if (now - lastStatePollAt < POLL_INTERVAL_MS) return;
            lastStatePollAt = now;
            try {
                const r = await fetch(apiUrl("/api/state" + (lastWorldRev >= 0 ? "?since=" + lastWorldRev : "")));
                const d = await r.json();
                if (d && typeof d.rev === 'number') lastWorldRev = d.rev;
                if (d && d.changed && d.world) {
                    // 忽略和本端比例不一致的旧世界：
                    // 如果操控端还是旧版本（星球半径 50000 等），照搬过来会把画面缩小几十倍。
                    const wp = d.world.planet;
                    if (wp && Math.abs((wp.radius || 0) - planet.radius) > 1) return;
                    remotePrev = remoteNext || d.world;
                    remoteNext = d.world;
                    remoteRecvTime = performance.now();
                    lastRecvAt = remoteRecvTime;
                }
            } catch (e) {}
        }

        // 观战端：把服务器来的状态插值到当前帧，画面才顺滑
        function applyRemoteWorld() {
            const now = performance.now();
            const stale = (now - lastRecvAt) > REMOTE_TIMEOUT_MS;

            if (!remoteNext) {
                if (stale) hud.innerText = "等待操控端连接...";
                return;
            }
            const t = Math.min(1, (now - remoteRecvTime) / POLL_INTERVAL_MS);
            const a = remotePrev && remotePrev.rocket ? remotePrev.rocket : remoteNext.rocket;
            const b = remoteNext.rocket;
            const lerp = (p, q) => p + (q - p) * t;

            // 角度走最短弧，避免从 359° 转到 1° 时整圈乱转
            let da = b.angle - a.angle;
            while (da > 180) da -= 360;
            while (da < -180) da += 360;

            rocket.x = lerp(a.x, b.x);
            rocket.y = lerp(a.y, b.y);
            rocket.vx = b.vx; rocket.vy = b.vy;
            rocket.angle = ((a.angle + da * t) % 360 + 360) % 360;
            rocket.throttle = b.throttle;
            rocket.fuel = b.fuel;
            rocket.state = b.state;
            rocket.landed = b.landed;

            if (remoteNext.camera) {
                camera.x = lerp(camera.x, remoteNext.camera.x);
                camera.y = lerp(camera.y, remoteNext.camera.y);
                camera.zoom = lerp(camera.zoom, remoteNext.camera.zoom);
            }
            if (typeof remoteNext.orbits === "number" && remoteNext.orbits > stats.orbits) {
                stats.orbits = remoteNext.orbits;
            }
        }

        // ==================== 背景音乐：miaosic / Higher ====================
        const bgm = new Audio('miaosic/BGM-Higher.mp3');
        bgm.loop = true;
        bgm.volume = 0.45;

        let bgmMuted = false;
        try { bgmMuted = localStorage.getItem('msp2d-bgm-muted') === '1'; } catch (e) {}
        if (bgmMuted) bgm.volume = 0;

        function startBgm() {
            if (bgmMuted) return;
            try {
                const p = bgm.play();
                if (p && p.catch) p.catch(() => {});   // 浏览器不让自动播放就先算了
            } catch (e) {}
        }

        function toggleBgm() {
            bgmMuted = !bgmMuted;
            try { localStorage.setItem('msp2d-bgm-muted', bgmMuted ? '1' : '0'); } catch (e) {}
            if (bgmMuted) {
                bgm.pause();
            } else {
                bgm.volume = 0.45;
                startBgm();
            }
        }

        // 浏览器规定：必须先有用户操作（点击 / 按键）才允许放声音
        canvas.addEventListener('pointerdown', startBgm);
        window.addEventListener('pointerdown', startBgm);
        window.addEventListener('keydown', startBgm);

        const rocket = {
            x: planet.x, y: planet.y - (planet.radius + 8), vx: 0, vy: 0,   // 一开始就停在星球表面（跟着半径自动算，改星球大小不用再改这里）
            angle: 90,
            throttle: 1,                      // 节流阀：0 ~ 1
            fuel: 1,                          // 燃料：0 ~ 1（1 = 满格）
            state: 'idle',                    // idle = 关机，firing = 点火
            landed: true                      // 是否正停在星球上
        };

        let accumulator = 0;

        // ==================== 渲染插值（Fix Your Timestep）====================
        // 物理固定 60Hz 步进，显示器往往 120~240Hz：不插值的话世界会
        // 「每 4 帧硬跳一步」（240Hz 下 75% 的渲染帧零运动——实测数据见
        // 2026-11-01 排查）。做法：每个物理帧快照「步进前/步进后」两个状态，
        // 渲染时按 alpha = 累加器余量/步长 在两者之间线性插值。
        // 物理本身一行不改；传送类场景（换船/重开/读档/观战）调 resetInterp 归位。
        const interp = {
            alpha: 0,
            rocket: { px: 0, py: 0, pa: 0, cx: 0, cy: 0, ca: 0 },   // p=prev c=curr a=angle
            vessels: new Map(),                                     // id -> 同上结构
            debris: [],                                             // 与 debris 按下标对齐
        };

        function snapInterp() {
            // curr → prev，然后把当前逻辑状态采样为 curr。角度解回绕（±180 内）。
            const shift = (e, x, y, a) => {
                e.px = e.cx; e.py = e.cy; e.pa = e.ca;
                e.cx = x; e.cy = y; e.ca = a;
                if (e.ca - e.pa > 180) e.ca -= 360;
                else if (e.ca - e.pa < -180) e.ca += 360;
            };
            shift(interp.rocket, rocket.x, rocket.y, rocket.angle);
            for (const v of vessels) {
                let e = interp.vessels.get(v.id);
                if (!e) {
                    interp.vessels.set(v.id, { px: v.x, py: v.y, pa: v.angle, cx: v.x, cy: v.y, ca: v.angle });
                    continue;
                }
                shift(e, v.x, v.y, v.angle);
            }
            if (interp.debris.length !== debris.length) {
                interp.debris = debris.map(d => ({ px: d.x, py: d.y, cx: d.x, cy: d.y }));
            } else {
                for (let i = 0; i < debris.length; i++) shift(interp.debris[i], debris[i].x, debris[i].y, 0);
            }
        }

        function resetInterp() {
            // 传送后归位：prev = curr = 当前逻辑状态（下一帧起重新积累）
            interp.alpha = 0;
            interp.vessels.clear();
            const r = interp.rocket;
            r.px = r.cx = rocket.x; r.py = r.cy = rocket.y; r.pa = r.ca = rocket.angle;
            for (const v of vessels) {
                interp.vessels.set(v.id, { px: v.x, py: v.y, pa: v.angle, cx: v.x, cy: v.y, ca: v.angle });
            }
            interp.debris = debris.map(d => ({ px: d.x, py: d.y, cx: d.x, cy: d.y }));
        }

        // 渲染取值：逻辑状态在两个物理快照之间的插值位置
        function rocketRenderPos() {
            const r = interp.rocket, a = interp.alpha;
            return { x: r.px + (r.cx - r.px) * a,
                     y: r.py + (r.cy - r.py) * a,
                     angle: r.pa + (r.ca - r.pa) * a };
        }
        function vesselRenderPos(v) {
            const e = interp.vessels.get(v.id);
            if (!e) return { x: v.x, y: v.y, angle: v.angle };
            const a = interp.alpha;
            return { x: e.px + (e.cx - e.px) * a,
                     y: e.py + (e.cy - e.py) * a,
                     angle: e.pa + (e.ca - e.pa) * a };
        }
        function debrisRenderPos(i) {
            const e = interp.debris[i];
            if (!e) return null;
            const a = interp.alpha;
            return { x: e.px + (e.cx - e.px) * a, y: e.py + (e.cy - e.py) * a };
        }

        // ==================== 时间加速 ====================
        // 主循环是「固定步长 + 累加器」，所以加速只要把累加器乘个倍率，
        // 物理本身一行都不用改（每步还是 1/60 秒，只是每帧跑更多步）。
        //
        // 可选的倍率档位（按 . 加速 / , 减速，或点屏幕右上角的按钮）
        let timeScaleIdx = 0;
        function timeScale() { return TIME_SCALES[timeScaleIdx]; }
        function cycleTimeScale(dir) {
            timeScaleIdx = (timeScaleIdx + (dir || 1) + TIME_SCALES.length) % TIME_SCALES.length;
            toastQueue.push({
                title: '时 间 倍 率',
                name: timeScale() === 1 ? '恢复正常速度' : timeScale() + ' 倍速',
                desc: '按 . 加速 ｜ 按 , 减速',
            });
        }
        let lastTime = performance.now();

        // 飞船尺寸（米）—— 和其他一切共用同一个比例
        // 数值虽大（公里级），但和星球 1000 km 是同一把尺子，量纲自洽。
        function shipSizeMeters() {
            return { w: SPEC.width * M_PER_PX,
                     h: SPEC.height * M_PER_PX };
        }

        function defaultShip() {
            return { version: 1, name: '默认船', parts: [
                { id: 'd1', type: 'engine',  x: 0, y: 0 },
                { id: 'd2', type: 'tank',    x: 0, y: 2 },
                { id: 'd3', type: 'capsule', x: 0, y: 5 },
            ]};
        }

        function loadShipLocal() {
            try {
                const raw = localStorage.getItem('msp2d-ship');
                if (!raw) return defaultShip();
                const s = JSON.parse(raw);
                if (!s || !Array.isArray(s.parts) || s.parts.length === 0) return defaultShip();
                s.parts = s.parts.filter(p => p && PART_TYPES[p.type]);
                const fix = sanitizeShipDef(s);
                s.parts = fix.def.parts;
                return s.parts.length ? s : defaultShip();
            } catch (e) { return defaultShip(); }
        }

        let shipDef = loadShipLocal();

        // 从部件算出：空船质量、燃料容量、总推力、包围盒
        // ==================== 飞船状态缓存 ====================
        // 以前每次上报（10Hz）都要遍历全部部件去数「还有没有控制舱 / 发动机 / 多少油」，
        // 部件多了就是白白浪费。改成缓存：只在部件被毁 / 船体变化时重算一次。
        let shipCache = {
            alive: 0,            // 还活着的部件数
            total: 0,            // 总部件数
            capsule: 0,          // 活着的控制舱数
            engine: 0,           // 活着的发动机数
            fuelCap: 0,          // 活着的燃料容量
            dryMass: 0,          // 空船质量
            thrust: 0,           // 总推力
            dirty: true,
        };

        function invalidateShipCache() { shipCache.dirty = true; }

        function rebuildShipCache() {
            let alive = 0, capsule = 0, engine = 0, fuelCap = 0, dryMass = 0, thrust = 0;
            for (const p of shipDef.parts) {
                if (destroyed.has(p.id)) continue;
                const t = PART_TYPES[p.type];
                if (!t) continue;
                alive++;
                if (p.type === 'capsule') capsule++;
                if (p.type === 'engine') engine++;
                fuelCap += t.fuel;
                dryMass += t.mass;
                thrust += t.thrust;
            }
            shipCache.alive = alive;
            shipCache.total = shipDef.parts.length;
            shipCache.capsule = capsule;
            shipCache.engine = engine;
            shipCache.fuelCap = fuelCap;
            shipCache.dryMass = dryMass;
            shipCache.thrust = thrust;
            shipCache.dirty = false;
            return shipCache;
        }

        function shipInfo() {
            return shipCache.dirty ? rebuildShipCache() : shipCache;
        }

        // 活着的部件算出来的燃料容量（炸掉的箱子不再提供容量）
        function aliveFuelCap() { return shipInfo().fuelCap; }


        // 把船的本地坐标点转到世界坐标（考虑位置和旋转）
        // 本地坐标（以船底中轴为原点）→ 世界坐标
        // 旋转中心是「质心」：先把点相对于质心摆好，再转，再平移回去。
        function shipPointWorld(lx, ly, angleDeg) {
            const a = (angleDeg - 90) * Math.PI / 180;   // 和绘制用的是同一个旋转
            const cos = Math.cos(a), sin = Math.sin(a);
            const rx = lx - SPEC.com.x;                  // 相对质心
            const ry = ly - SPEC.com.y;
            return { x: rocket.x + rx * cos - ry * sin,
                     y: rocket.y + rx * sin + ry * cos };
        }

        // 找出离星球中心最近的那个碰撞点（也就是"最低"的那个）
        // ==================== 着陆姿态 ====================
        // 机头偏离「星球正上方」的角度（度）
        //   0   = 完全竖直（正常着陆）
        //   55+ = 横躺 / 倒扣，不该算正常着陆
        function shipTiltDeg(angleDeg) {
            // 飞船角度约定：90° = 机头朝上（游戏里默认的竖直状态）
            // 用和渲染同一套换算：rotate((angle - 90) * PI/180)
            const a = (angleDeg - 90) * Math.PI / 180;
            // 机头方向在本地是 (0, -1)，旋转后：
            const noseX = Math.sin(a);
            const noseY = -Math.cos(a);
            // 星球在飞船的哪个方向 -> 反方向就是「天空」
            const dxG = planet.x - rocket.x;
            const dyG = planet.y - rocket.y;
            const len = Math.hypot(dxG, dyG) || 1;
            const upX = -dxG / len;
            const upY = -dyG / len;
            const dot = Math.max(-1, Math.min(1, noseX * upX + noseY * upY));
            return Math.acos(dot) * 180 / Math.PI;
        }

        function lowestCollisionPoint(angleDeg) {
            let best = null, bestD = Infinity;
            for (const p of SPEC.corners) {
                const w = shipPointWorld(p.x, p.y, angleDeg);
                const dx = w.x - planet.x, dy = w.y - planet.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < bestD) { bestD = d; best = { local: p, world: w, dist: d }; }
            }
            return best;
        }

        // 真正的「离地高度」：量到船底（离星球最近的那个碰撞点），不是量飞船原点。
        // 飞船原点在船体内部，直接量它会虚高半个船身 ——
        // 默认船的质心离底面约 25 px，旧比例 1px=50m 时就是 1.26 km，
        // 停在地上却显示「高度 1.26 km」，看着像浮在半空 / 碰撞失效。
        function surfaceAltitudePx() {
            const hit = lowestCollisionPoint(rocket.angle);
            if (hit && hit.dist > 0) return hit.dist - planet.radius;
            const r = Math.hypot(rocket.x - planet.x, rocket.y - planet.y) || 1;
            return r - planet.radius;
        }

        // 把飞船放到「碰撞箱最深点正好贴在地表」的位置。
        // 不能简单写 planet.radius —— rocket.y 是船体本地原点，
        // 最深的碰撞点可能在原点下方（取决于你拼的船形）。
        function placeOnSurface(offsetDeg) {
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
            for (let i = 0; i < 8; i++) {
                const hit = lowestCollisionPoint(rocket.angle);
                if (!hit || hit.dist <= 0) break;
                const push = hit.dist - planet.radius;
                if (Math.abs(push) < 0.01) break;
                const ux = (hit.world.x - planet.x) / hit.dist;
                const uy = (hit.world.y - planet.y) / hit.dist;
                rocket.x -= ux * push;
                rocket.y -= uy * push;
            }
            rocket.vx = 0;
            rocket.vy = 0;
            rocket.landed = true;
        }

        // ==================== 质量模型（燃料会变轻）====================
        // 总质量 = 空船质量 + 燃料质量
        // 加速度 = 推力 / 总质量
        // 所以：油越少 → 飞船越轻 → 同样的油门加速越快。
        // 这也是真实火箭的脾气（齐奥尔科夫斯基公式讲的就是这件事）。
        // 质量 / 推力 全部由「你造的飞船」决定：
        //   空船质量 = Σ 部件质量
        //   燃料质量 = Σ 燃料箱容量
        //   总推力   = Σ 发动机推力
        // 燃料烧掉多少，质量就减轻多少 —— 这就是「燃料减少，重量也减少」。
        let SPEC = shipSpec(shipDef);   // 分离/换船后要重算，所以是 let
        let lastComFuel = -1;           // 上次算质心时的燃料量（变了才重算）

        // 质量/推力永远按「现在还活着的部件」实时算（shipInfo 有缓存，开销可忽略）。
        // 以前这里用页面加载时冻结的 DRY_MASS / FUEL_MASS / FULL_THRUST 三个 const：
        // 发动机烧毁、撞毁、随断船分离之后，飞船照样有满推力、质量也不变 —— 已废除。
        // ==================== 燃料按箱存储 ====================
        // 每个燃料箱部件自带油量 p.fuel（0~容量）。发动机抽全船所有油箱
        //（等比消耗，油门手感不变）；分离时各段带走自己格子里的油箱和油——
        // 上面级没放油箱就没油烧（分级火箭的物理约束，与 KSP 一致）。
        function tankFuel(p) {
            return (p.fuel !== undefined) ? p.fuel : (PART_TYPES[p.type] ? PART_TYPES[p.type].fuel : 0);
        }
        function aliveTanks() {
            return shipDef.parts.filter(p => p.type === 'tank' && !destroyed.has(p.id) && !severed.has(p.id));
        }
        function totalFuel() {
            return aliveTanks().reduce((s, p) => s + tankFuel(p), 0);
        }
        function totalCap() {
            return aliveTanks().reduce((s, p) => s + (PART_TYPES[p.type].fuel || 0), 0);
        }
        function totalRatio() {
            const c = totalCap();
            return c > 0 ? Math.max(0, Math.min(1, totalFuel() / c)) : 0;
        }
        // 等比抽取：所有油箱同比例下降（frac = 占总容量的比例）
        function drainFuel(frac) {
            for (const p of aliveTanks()) {
                const t = PART_TYPES[p.type];
                p.fuel = Math.max(0, tankFuel(p) - frac * t.fuel);
            }
        }
        function setFuelRatio(r) {
            for (const p of aliveTanks()) {
                p.fuel = Math.max(0, Math.min(1, r)) * PART_TYPES[p.type].fuel;
            }
        }
        function partsRatio(parts) {
            let f = 0, c = 0;
            for (const p of parts) {
                const t = PART_TYPES[p.type];
                if (!t || t.fuel <= 0) continue;
                f += tankFuel(p); c += t.fuel;
            }
            return c > 0 ? f / c : 0;
        }
        function shipMass() {
            let m = 0;
            for (const p of shipDef.parts) {
                if (destroyed.has(p.id) || severed.has(p.id)) continue;
                const t = PART_TYPES[p.type];
                if (!t) continue;
                m += t.mass + tankFuel(p);
            }
            return m;
        }

        // 当前实际加速度（已经算上油门和质量）
        function thrustAccel(throttle) {
            const m = shipMass();
            return m > 0 ? shipInfo().thrust * Math.max(0, Math.min(1, throttle)) / m : 0;
        }

        let fuelMsgTimer = 0;           // 在空中按 +/- 时的提示，显示 2 秒

        const stats = {
            orbits: 0, sweep: 0, lastAngle: 0,
            maxSpeed: 0, maxAlt: 0, hoverTime: 0,
            escaped: false, dumpedFuel: 0,
            launchX: 0, launchY: 0
        };

        // 每个物理步都会检查一遍
        function checkAchievements(dt) {
            const rx = rocket.x - planet.x;
            const ry = rocket.y - planet.y;
            const r = Math.sqrt(rx * rx + ry * ry) || 1;
            const alt = surfaceAltitudePx();   // 量到船底，和 HUD 一致
            const speed = Math.sqrt(rocket.vx * rocket.vx + rocket.vy * rocket.vy);
            const ang = Math.atan2(ry, rx);

            if (speed > stats.maxSpeed) stats.maxSpeed = speed;
            if (alt > stats.maxAlt) stats.maxAlt = alt;
            if (stats.maxSpeed >= 300) unlock('speed_300');
            if (stats.maxSpeed >= 600) unlock('speed_600');
            if (stats.maxAlt >= 1000) unlock('alt_1000');
            if (stats.maxAlt >= 5000) unlock('alt_5000');

            // 逃逸：能量 ≥ 0，而且必须真的是往外飞。
            // （不然一头扎向地面的俯冲也算能量 ≥ 0，那就成"撞地逃逸"了）
            const radialSpeed = (rocket.vx * rx + rocket.vy * ry) / r;
            if (speed * speed / 2 - GRAVITY_MU / r >= 0 && radialSpeed > 0) {
                stats.escaped = true;
                unlock('escape');
            }

            if (!rocket.landed) {
                let da = ang - stats.lastAngle;
                while (da > Math.PI) da -= 2 * Math.PI;
                while (da < -Math.PI) da += 2 * Math.PI;
                stats.sweep += Math.abs(da);
                if (stats.sweep >= Math.PI * 2) {
                    stats.sweep -= Math.PI * 2;
                    stats.orbits += 1;
                    unlock('orbit');
                    if (stats.orbits >= 3) unlock('orbit3');
                    if (stats.orbits >= 5) unlock('orbit5');
                }
                // 悬停：离地 200px 上下 20px 保持 3 秒
                if (Math.abs(alt - 200) < 20) {
                    stats.hoverTime += dt;
                    if (stats.hoverTime >= 3) unlock('hover_king');
                } else {
                    stats.hoverTime = 0;
                }
            } else {
                stats.sweep = 0;
                stats.hoverTime = 0;
            }
            stats.lastAngle = ang;
        }

        // 每个部件的当前温度
        let partTemp = {};
        let heatWrecked = 0;             // 这一趟烧毁了几个

        function initPartTemp() {
            const t = {};
            for (const p of shipDef.parts) t[p.id] = AMBIENT_TEMP;
            return t;
        }
        partTemp = initPartTemp();

        // 冲击加热：算每个部件"迎着气流"的程度（0~1）
        // 迎风面 = 部件中心相对飞船质心、在速度反方向上的投影
        // 迎风程度：部件在速度方向上越靠前，受热越多（同样支持任意船体）
        function partWindExposure(p, v) {
            v = v || mainView;
            const t = PART_TYPES[p.type];
            if (!t) return 0;
            const P = PART_PX;
            const spec = v.spec;
            const cx = (p.x + t.w / 2 - spec.centerX) * P - spec.com.x;
            const cy = (spec.box.maxY - (p.y + t.h / 2)) * P - spec.com.y;
            const a = (v.angle - 90) * Math.PI / 180;
            const wx = cx * Math.cos(a) - cy * Math.sin(a);
            const wy = cx * Math.sin(a) + cy * Math.cos(a);
            const sp = Math.hypot(v.vx, v.vy);
            if (sp < 1) return 0;
            const ux = v.vx / sp, uy = v.vy / sp;
            const proj = (wx * ux + wy * uy);
            const half = Math.max(spec.width, spec.height) / 2 || 1;
            return Math.max(0, Math.min(1, 0.5 + proj / (half * 2)));
        }

        // 每帧更新温度
        // 再入加热：对任意船体都适用
        function updateHeat(dt, v) {
            v = v || mainView;
            const dens = atmosphereDensity(v.x, v.y);
            const sp = Math.hypot(v.vx, v.vy);

            // 必须「朝地面冲」才算再入加热 —— 否则垂直起飞也会被当成再入
            const rx = v.x - planet.x, ry = v.y - planet.y;
            const r = Math.hypot(rx, ry) || 1;
            const radialSpeed = (v.vx * rx + v.vy * ry) / r;
            const divingIn = radialSpeed < -20;

            const hot = dens > 0.01 && sp > REENTRY_SPEED && divingIn;
            if (v.isMain && dens > 0.05 && sp > 400 && divingIn) unlock('meteor');
            let blew = 0;

            for (const p of v.def.parts) {
                if (v.dead.has(p.id)) continue;
                if (hot) {
                    const expo = partWindExposure(p, v);
                    const over = sp - REENTRY_SPEED;
                    // 系数 3e-4：1500 m/s 再入时约 147 °/s，燃料箱(260°C)撑约 1.7 秒，
                    // 返回舱(900°C)能撑到最后 —— 和 README 里说的「燃料箱最先烧穿」一致。
                    const rate = over * over * 3e-4 * dens * (0.25 + expo * 1.6);
                    v.temp[p.id] += rate * dt;
                } else {
                    const d = v.temp[p.id] - AMBIENT_TEMP;
                    if (d > 0) v.temp[p.id] -= Math.min(d, HEAT_COOL_RATE * dt);
                }
                const limit = HEAT_LIMIT[p.type] || 800;
                if (v.temp[p.id] >= limit) {
                    v.dead.add(p.id);
                    blowUpPart(p, v);
                    invalidateShipCache();
                    blew++;
                }
            }
            // 主船才有成就和提示，残骸静默烧毁
            if (blew > 0 && v.isMain) {
                heatWrecked += blew;
                unlock('burned_up');
                checkSeparation();
                const others = v.def.parts.filter(p => p.type !== 'capsule');
                if (others.length > 0 &&
                    others.every(p => v.dead.has(p.id)) &&
                    hasWorkingCapsule()) {
                    unlock('capsule_survives');
                }
                toastQueue.push({
                    title: '再 入 警 报',
                    name: blew + ' 个部件因高温解体',
                    desc: '还有 ' + alivePartCount() + ' / ' + v.def.parts.length + ' 个部件完好',
                });
            }
            return blew;
        }

        // 最热的那个部件（用于 HUD 显示）
        function hottestPart() {
            let best = null, bestT = -1;
            for (const p of shipDef.parts) {
                if (destroyed.has(p.id)) continue;
                const t = partTemp[p.id] || 0;
                if (t > bestT) { bestT = t; best = p; }
            }
            if (!best) return null;
            return { part: best, temp: bestT, limit: HEAT_LIMIT[best.type] || 800 };
        }

        // HUD 上那行大气状态文字
        // 大气状态文字。
        // 大气改成指数衰减后，不再有「内 / 外」这种硬边界 ——
        // 所以改成显示**密度等级**，玩家能看到阻力是渐渐消失的。
        function atmoStatusText() {
            const alt = surfaceAltitudePx();   // 量到船底，和 HUD 一致
            const d = atmosphereDensity(rocket.x, rocket.y);
            const pct = d * 100;
            const altKm = (alt * DIST_M_PER_PX / 1000);

            if (d <= 0.0005) return '真空（无阻力）🌌';

            // 按密度给个直观的描述
            let label;
            if (pct >= 70) label = '稠密';
            else if (pct >= 30) label = '稀薄';
            else if (pct >= 8) label = '很稀薄';
            else if (pct >= 2) label = '接近真空';
            else label = '几乎真空';

            return `大气 ${label}（密度 ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%，高度 ${altKm < 10 ? altKm.toFixed(1) : Math.round(altKm)} km）`;
        }

        // 时间倍率按钮的显示
        const timeValueEl = document.getElementById('time-value');
        const timeDownEl = document.getElementById('time-down');
        const timeUpEl = document.getElementById('time-up');
        let timeBtnCache = '';

        function renderTimeBtn() {
            if (!timeValueEl) return;
            const s = timeScale();
            const label = s + 'x';
            if (label === timeBtnCache) return;
            timeBtnCache = label;
            timeValueEl.innerText = label;
            timeValueEl.className = s >= 100 ? 'ultra' : (s > 1 ? 'fast' : '');
        }
        if (timeDownEl) timeDownEl.addEventListener('click', () => cycleTimeScale(-1));
        if (timeUpEl) timeUpEl.addEventListener('click', () => cycleTimeScale(1));

        // ==================== 分级堆栈面板 ====================
        // 每帧比对签名，只有分级状态变化才重建 DOM。
        // 显示：自底向上，最下面一行 = 下一次按空格将激活的分级。
        let stageStackSig = '';
        function renderStageStack() {
            if (!stageStackEl) return;
            const acts = computeStageActions();
            const sig = acts.map(a => a.stage + a.kind[0] + (stagePending(a) ? '1' : '0')).join(',');
            if (sig === stageStackSig) return;
            stageStackSig = sig;
            const stages = [];
            for (const a of acts) (stages[a.stage] = stages[a.stage] || []).push(a);
            let html = '';
            for (let i = stages.length - 1; i >= 0; i--) {
                const items = stages[i] || [];
                const pending = items.some(stagePending);
                const tags = items.map(a => a.kind === 'sever' ? '分' : '伞').join('+');
                html += '<div class="stg' + (pending ? ' next' : ' done') + '">'
                    + '<span class="stg-n">' + (i + 1) + '</span><span>' + tags + '</span></div>';
            }
            stageStackEl.innerHTML = html;
        }

        // 顶部「本航天器还剩什么零件」
        const partsBarEl = document.getElementById('parts-bar');
        const stageStackEl = document.getElementById('stage-stack');
        let partsBarCache = '';

        function renderPartsBar() {
            if (!partsBarEl) return;
            const v = mainView;
            if (!v) return;

            const total = v.def.parts.length;
            const alive = alivePartCount();
            let html = '';

            for (const p of v.def.parts) {
                const t = PART_TYPES[p.type];
                if (!t) continue;
                const dead = v.dead.has(p.id);
                const hp = v.hp[p.id] || 0;
                const hpMax = PART_HP[p.type] || 100;
                const ratio = Math.max(0, Math.min(1, hp / hpMax));
                const temp = v.temp[p.id] || 0;
                const limit = HEAT_LIMIT[p.type] || 800;
                const burning = !dead && temp > limit * 0.6;

                let cls = 'ok';
                if (dead) cls = 'gone';
                else if (burning) cls = 'hot';
                else if (ratio < 0.6) cls = 'hurt';

                const hpTxt = dead ? '' : '<span class="hp">' + Math.round(ratio * 100) + '%</span>';
                html += '<span class="p ' + cls + '"><span class="dot"></span>' + t.name + hpTxt + '</span>';
            }

            html += '<span class="summary">' + alive + '/' + total;
            if (!hasWorkingCapsule()) html += ' <span class="warn">无控制舱</span>';
            else if (!hasWorkingEngine()) html += ' <span class="warn">无发动机</span>';
            html += '</span>';

            if (html === partsBarCache) return;
            partsBarCache = html;
            partsBarEl.innerHTML = html;
        }


        // 当前飞船所在位置的大气密度
        function myAtmosphere() {
            return atmosphereDensity(rocket.x, rocket.y);
        }
        // HUD 上那行再入温度提示
        function heatLine() {
            const h = hottestPart();
            if (!h || h.temp < AMBIENT_TEMP + 30) return '';
            const pct = Math.round(h.temp / h.limit * 100);
            const t = PART_TYPES[h.part.type];
            return `  🔥 ${t ? t.name : '部件'} ${Math.round(h.temp)}°C / ${h.limit}°C（${pct}%）`;
        }

        // 是否算「已在太空」：密度低到可以忽略（不再用硬边界）
        function inSpace() {
            return atmosphereDensity(rocket.x, rocket.y) < 0.005;
        }

        // ==================== 统一航天器抽象 ====================
        // 问题是「飞船有两套物理」：玩家船走完整流程（损伤/加热/分离），
        // 残骸只走引力+阻力+撞地反弹。任何改动只改一边就出不一致。
        //
        // 这层把两者统一成同一个接口，物理只认这个接口：
        //   v.x v.y v.vx v.vy v.angle v.fuel v.landed v.state v.throttle
        //   v.def   ← 部件列表     v.spec  ← 质量/质心/碰撞箱
        //   v.hp    ← 部件耐久     v.temp  ← 部件温度
        //   v.dead  ← 已毁部件集合
        //
        // 玩家船的「主视图」直接指向 rocket / shipDef / SPEC / partHP
        // 这些老变量，所以老的 147 处 rocket.xxx 一行都不用改。
        function mainVesselView() {
            return mainView;
        }
        let mainView = null;   // 在初始化时建立

        // 建立「玩家船」的统一视图（字段和残骸一一对应）
        function bindMainView() {
            mainView = {
                id: 'v0',
                isMain: true,
                get x() { return rocket.x; }, set x(v) { rocket.x = v; },
                get y() { return rocket.y; }, set y(v) { rocket.y = v; },
                get vx() { return rocket.vx; }, set vx(v) { rocket.vx = v; },
                get vy() { return rocket.vy; }, set vy(v) { rocket.vy = v; },
                get angle() { return rocket.angle; }, set angle(v) { rocket.angle = v; },
                get fuel() { return rocket.fuel; }, set fuel(v) { rocket.fuel = v; },
                get state() { return rocket.state; }, set state(v) { rocket.state = v; },
                get throttle() { return rocket.throttle; }, set throttle(v) { rocket.throttle = v; },
                get landed() { return rocket.landed; }, set landed(v) { rocket.landed = v; },
                get heat() { return rocket.heat; }, set heat(v) { rocket.heat = v; },
                // 这些直接引用同一个对象，改一边就是改两边
                get def() { return shipDef; }, set def(v) { shipDef = v; },
                get spec() { return SPEC; }, set spec(v) { SPEC = v; },
                get hp() { return partHP; }, set hp(v) { partHP = v; },
                get temp() { return partTemp; }, set temp(v) { partTemp = v; },
                get dead() { return destroyed; }, set dead(v) { destroyed = v; },
                // 兼容别名：与 makeVessel 的残骸对象用同一套字段名
                // （vesselMass 等通用函数读 v.destroyed / v.partHP / v.partTemp，
                //   别让「主视图」和「残骸」的字段名分叉 —— 曾经因此炸过）
                get partHP() { return partHP; },
                get partTemp() { return partTemp; },
                get destroyed() { return destroyed; },
            };
        }

        // 给残骸建一个同样形状的对象（用在 makeVessel 里）
        // 残骸有自己的 hp/temp/dead，和被毁后剩下的部件

        // ==================== 多航天器 ====================
        // 中间炸断之后，飞船会分离成好几截，每截都是独立航天器。
        // 为了不动那 147 处 rocket.xxx 的代码，这里保持一个约定：
        //   · rocket         = 当前正在操控的那一艘（有控制舱的）
        //   · vessels[]      = 全部航天器（包含 rocket 自己）
        //   · 失控的那些每帧只跑引力和惯性，不能操控
        let vessels = [];
        let activeVesselId = null;

        function makeVessel(parts, x, y, vx, vy, angle, fuel) {
            const def = { version: 1, name: '', parts: parts };
            const spec = shipSpec(def);
            return {
                id: 'v' + (vesselSeq++),
                def: def,
                spec: spec,
                x: x, y: y, vx: vx, vy: vy, angle: angle,
                fuel: fuel,
                throttle: 1,
                state: 'idle',
                landed: false,
                heat: 0,
                spin: 0,              // 角速度（°/s）：分离/撞击带来的翻滚
                chutes: {},           // 这艘船的伞状态（部件id → packed/open/cut）
                // 注意：下面三个用「短名字」hp/temp/dead，
                // 和主船视图（mainView）保持同一套字段名，
                // 这样物理代码不需要区分「这是玩家船还是残骸」。
                hp: (function () { const h = {}; for (const p of parts) h[p.id] = PART_HP[p.type] || 100; return h; })(),
                temp: (function () { const t = {}; for (const p of parts) t[p.id] = AMBIENT_TEMP; return t; })(),
                dead: new Set(),
                // 兼容老代码用的名字
                get partHP() { return this.hp; },
                get partTemp() { return this.temp; },
                get destroyed() { return this.dead; },
            };
        }
        let vesselSeq = 1;

        // 这艘船还有控制舱吗
        function vesselHasCapsule(v) {
            return v.def.parts.some(p => p.type === 'capsule' && !v.destroyed.has(p.id));
        }
        // 这艘船还有发动机吗
        function vesselHasEngine(v) {
            return v.def.parts.some(p => p.type === 'engine' && !v.destroyed.has(p.id));
        }
        // 这艘船的存活部件数
        function vesselAliveParts(v) {
            return v.def.parts.filter(p => !v.destroyed.has(p.id)).length;
        }
        // 这艘船当前的质量
        function vesselMass(v) {
            let dry = 0, cap = 0, thrust = 0;
            for (const p of v.def.parts) {
                if (v.destroyed.has(p.id)) continue;
                const t = PART_TYPES[p.type];
                if (!t) continue;
                dry += t.mass; cap += t.fuel; thrust += t.thrust;
            }
            return { dry, cap, thrust, total: dry + cap * v.fuel };
        }
        // 这艘船能不能被操控
        function vesselControllable(v) {
            return v && vesselHasCapsule(v) && !v.landed ? true : (v ? vesselHasCapsule(v) : false);
        }

        let wreckedCount = 0;         // 这一趟撞炸了几个部件
        let shipTotalLoss = false;    // 是否已经弹过「任务失败」（全毁只弹一次）
        let debris = [];              // 爆炸碎片（纯视觉）

        // 给每个部件建一份耐久表（和 shipDef.parts 一一对应）
        function initPartHP() {
            const hp = {};
            for (const p of shipDef.parts) hp[p.id] = PART_HP[p.type] || 80;
            return hp;
        }
        let partHP = initPartHP();
        let destroyed = new Set();    // 已经炸掉的部件 id
        let severed = new Set();      // 已被分离器切断的部件 id：还活着还画着，
                                      // 但不再把两侧粘在一起（与 destroyed 分开算）

        // 撞了一下：按撞击速度给所有部件掉耐久，太狠的直接炸。
        // 用「单次撞击配额」避免连续弹跳把伤害累积起来 ——
        // 不然轻轻颠两下就把整艘船震碎了。
        let impactCooldown = 0;
        let impactBudget = {};       // 本次着陆每个部件最多掉多少血

        function resetImpactBudget() {
            impactBudget = {};
            for (const p of shipDef.parts) impactBudget[p.id] = 0;
            // 现在撞击伤害实际用的是「每艘船自己的」_impactBudget / _impactCooldown
            // （见 applyImpact）。上面这个旧的 impactBudget 已经没人用了，
            // 所以这里必须把统一视图那份也清掉 ——
            // 否则配额一辈子不清零，攒满之后部件就永久免疫，船又撞不坏了。
            if (mainView) {
                mainView._impactBudget = {};
                mainView._impactCooldown = 0;
            }
        }
        resetImpactBudget();

        // 撞击时，每个部件离「撞到地面的那个点」有多近（0 = 最远，1 = 正撞）
        // v 可以是玩家船（mainView）也可以是任何一艘残骸 —— 同一套算法。
        function impactExposure(p, v) {
            v = v || mainView;
            const t = PART_TYPES[p.type];
            if (!t) return 1;
            const P = PART_PX;
            const spec = v.spec;
            const cx = (p.x + t.w / 2 - spec.centerX) * P - spec.com.x;
            const cy = (spec.box.maxY - (p.y + t.h / 2)) * P - spec.com.y;
            const a = (v.angle - 90) * Math.PI / 180;
            const wx = v.x + cx * Math.cos(a) - cy * Math.sin(a);
            const wy = v.y + cx * Math.sin(a) + cy * Math.cos(a);
            const dx = planet.x - v.x, dy = planet.y - v.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len, uy = dy / len;
            const proj = (wx - v.x) * ux + (wy - v.y) * uy;
            const reach = Math.max(spec.width, spec.height) / 2 || 1;
            return Math.max(0, Math.min(1, 0.5 + proj / (reach * 2)));
        }

        // 撞击伤害：对任意船体都适用（玩家船 v=mainView，残骸 v=那个残骸）
        function applyImpact(speed, v) {
            v = v || mainView;
            if (speed < DAMAGE_SPEED) return 0;
            // 冷却按「每艘船」各算各的
            if (!v._impactCooldown) v._impactCooldown = 0;
            if (v._impactCooldown > 0) return 0;
            v._impactCooldown = 0.35;

            const over = speed - DAMAGE_SPEED;
            const dmg = over * 0.18;
            if (!v._impactBudget) v._impactBudget = {};

            let blew = 0;
            let instantKillId = null;
            if (speed > DESTROY_SPEED) {
                let best = null, bestExpo = -1;
                for (const p of v.def.parts) {
                    if (v.dead.has(p.id)) continue;
                    const e = impactExposure(p, v);
                    if (e > bestExpo) { bestExpo = e; best = p; }
                }
                if (best) instantKillId = best.id;
            }

            for (const p of v.def.parts) {
                if (v.dead.has(p.id)) continue;
                const expo = impactExposure(p, v);
                const share = 0.15 + expo * 1.7;
                const room = Math.max(0, (PART_HP[p.type] || 100) * 2.5 - (v._impactBudget[p.id] || 0));
                const real = Math.min(dmg * share, room);
                v._impactBudget[p.id] = (v._impactBudget[p.id] || 0) + real;
                v.hp[p.id] -= real;
                if (p.id === instantKillId || v.hp[p.id] <= 0) {
                    v.dead.add(p.id);
                    blowUpPart(p, v);
                    invalidateShipCache();
                    blew++;
                }
            }
            if (v.isMain && blew > 0) wreckedCount += blew;
            // 非主船的残骸：撞击带来随机翻滚（主船姿态由玩家控制，不在此干预）
            if (!v.isMain) {
                v.spin = Math.max(-360, Math.min(360, (v.spin || 0) + (Math.random() - 0.5) * speed * 0.06));
            }
            return blew;
        }

        // 炸毁 ∪ 切断：两者都不再把部件粘在一起（分离器切断用）
        function allDead() { return new Set([...destroyed, ...severed]); }

        // 炸完之后检查：船是不是断成几截了（axial=true 走分级轴向冲量）
        function checkSeparation(axial) {
            if (findConnectedGroups(shipDef.parts, allDead()).length > 1) {
                splitVessel(axial);
                if (vessels.length >= 3) unlock('derelict_keeper');
            }
        }

        // 爆炸：生成碎片；燃料箱炸了还会把里面的油一起烧掉
        function blowUpPart(p, v) {
            v = v || mainView;
            const t = PART_TYPES[p.type];
            if (!t) return;

            // 燃料按箱存储：油箱被炸 = 它的油跟着箱子一起没了
            // （按箱独立，旧版「全船共享一个燃料池 + 按份额扣油」的结构已废除）。
            if (t.fuel > 0 && tankFuel(p) > 0) {
                if (v.isMain) {
                    toastQueue.push({
                        title: '燃 料 损 失',
                        name: `燃料箱炸了，损失 ${Math.round(tankFuel(p))} 单位油`,
                        desc: '其余油箱的燃料不受影响',
                    });
                    rocket.fuel = totalRatio();   // 镜像
                }
            }
            // 碎片从「肇事船」的部件位置喷出：旧实现硬用主船的 SPEC/rocket，
            // 残骸烧毁/撞毁时碎片会凭空出现在玩家船身上。
            const P = PART_PX;
            const cx = (p.x + t.w / 2 - v.spec.centerX) * P;
            const cy = (v.spec.box.maxY - (p.y + t.h / 2)) * P;
            const da = (v.angle - 90) * Math.PI / 180;
            const rx = cx - v.spec.com.x, ry = cy - v.spec.com.y;
            const world = {
                x: v.x + rx * Math.cos(da) - ry * Math.sin(da),
                y: v.y + rx * Math.sin(da) + ry * Math.cos(da),
            };
            for (let i = 0; i < 14; i++) {
                const ang = Math.random() * Math.PI * 2;
                const sp = 40 + Math.random() * 160;
                debris.push({
                    x: world.x, y: world.y,
                    vx: v.vx + Math.cos(ang) * sp,
                    vy: v.vy + Math.sin(ang) * sp,
                    life: 1.6 + Math.random() * 1.4,
                    size: 1.5 + Math.random() * 2.5,
                    color: t.body,
                });
            }
        }

        // 碎片淡出
        function updateDebris(dt) {
            for (let i = debris.length - 1; i >= 0; i--) {
                const d = debris[i];
                d.life -= dt;
                if (d.life <= 0) { debris.splice(i, 1); continue; }
                d.x += d.vx * dt;
                d.y += d.vy * dt;
                const g = gravityAt(d.x, d.y);
                d.vx += g.ax * dt;
                d.vy += g.ay * dt;
            }
            if (debris.length > 400) debris.splice(0, debris.length - 400);
        }

        // 这一局开局时用的飞船（重置时回到它，而不是重新读 localStorage）
        let pristineShip = JSON.parse(JSON.stringify(shipDef));

        // 重置：把飞船放回地面，恢复燃料和部件（飞丢了、炸惨了、卡住了都能用）
        function respawnOnGround() {
            // 清掉所有失控航天器
            vessels = vessels.filter(v => v.id === activeVesselId);
            // 修好所有部件
            destroyed.clear();
            severed.clear();
            chuteStates = {};   // 伞全部重新包好
            partHP = initPartHP();
            partTemp = initPartTemp();
            debris = [];
            wreckedCount = 0; heatWrecked = 0;
            resetImpactBudget();
            impactCooldown = 0;
            // 还原飞船定义（分离后 shipDef 可能被截断了）
            // 注意：这里要用「这一局开局时的船」，不能重新读 localStorage ——
            // 否则玩家在造船厂造的船会被默认船覆盖掉。
            shipDef = JSON.parse(JSON.stringify(pristineShip));
            SPEC = shipSpec(shipDef);
            invalidateShipCache();
            const main = vessels.find(v => v.id === activeVesselId);
            if (main) { main.def = shipDef; main.spec = SPEC; }
            // 满油落地（pristine 的油箱本身是满的，这里显式归位）
            for (const p of shipDef.parts) {
                const t = PART_TYPES[p.type];
                if (t && t.fuel > 0) p.fuel = t.fuel;
            }
            lastComFuel = -1;
            rocket.throttle = 1;
            rocket.state = 'idle';
            rocket.angle = 90;
            rocket.vx = 0; rocket.vy = 0;
            rocket.heat = 0;
            stats.escapedFar = false;
            placeOnSurface();
            resetInterp();   // 重开是传送：插值状态归位
            if (main) {
                main.x = rocket.x; main.y = rocket.y;
                main.vx = 0; main.vy = 0; main.landed = true;
                main.fuel = 1; main.destroyed = destroyed;
            }
            toastQueue.push({
                title: '重 新 开 始',
                name: '飞船已修复并放回地面',
                desc: '燃料满格，部件全好',
            });
            saveMission();   // 把「修好的新一局」写进本地任务存档
        }

        // ==================== 换船唯一入口 ====================
        // 不管新船来自本地、任务存档还是服务器，都必须走这一个函数换：
        // shipDef / SPEC / 血量表 / 温度表 / 已毁集合 / 撞击配额 要一起重建。
        // 少换任何一个，就会出现「旧船碰撞箱 + 新船部件」的缝合船：
        // 部件血量查不到 id 变 NaN（撞击永远免疫）、渲染错位、质心错、开局即毁。
        function setShipDef(def, opts) {
            shipDef = def;
            pristineShip = JSON.parse(JSON.stringify(def));   // 重置（R）时回到这艘
            SPEC = shipSpec(shipDef);
            destroyed = new Set();
            severed.clear();   // 新船没有已切断的分离器
            chuteStates = {};  // 新船的伞全部包好
            for (const p of shipDef.parts) {
                const t = PART_TYPES[p.type];
                if (t && t.fuel > 0) p.fuel = t.fuel;   // 新船油箱满油
            }
            partHP = initPartHP();
            partTemp = initPartTemp();
            invalidateShipCache();
            resetImpactBudget();
            rocket.fuel = 1;
            lastComFuel = -1;   // 换船后质心必须重算
            rocket.throttle = 1;
            rocket.state = 'idle';
            rocket.angle = 90;   // 新发射的船竖直立在发射台（别继承上一艘的姿态）
            placeOnSurface(opts && opts.offsetDeg);
            resetInterp();
        }

        // ==================== 多船共存：旧船归档 ====================
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
            old.chutes = chuteStates;   // 伞状态跟着船走
            const idx = vessels.indexOf(mainView);
            if (idx >= 0) vessels[idx] = old; else vessels.push(old);
            return true;
        }

        // ==================== 本局任务自动存档 ====================
        // 目的：把「当前飞船（含已炸掉的部件、耐久、分离出的残骸、位置）」存到浏览器本地。
        // 以前这些只在内存里 —— 页面一刷新、或从观察站点「进入」重开页面就全没了，
        // 于是明明炸光的飞船会「奇迹复原」成完好状态，观察站里也一直显示那艘完好的旧船。
        const MISSION_KEY = 'msp2d-mission-v1';
        let missionRestored = false;    // 这一局是不是从本地任务存档恢复的
        let missionSig = '';            // 恢复时那艘船的类型签名（用于判断「换船了就作废」）
        let lastMissionSave = 0;

        // 船的类型签名：只看部件种类，不看位置/耐久。换了一艘不同搭配的船就作废旧任务。
        function shipPartsSig(parts) {
            return JSON.stringify((parts || []).map(p => p && p.type).sort());
        }

        function saveMission() {
            try {
                const data = {
                    v: 1,
                    sig: shipPartsSig(pristineShip.parts),   // 用「这一局的完好船」做签名
                    ship: shipDef,                            // 当前主船（分离后可能只剩一截）
                    destroyed: [...destroyed],
                    chutes: chuteStates,
                    hp: partHP,
                    rocket: {
                        x: rocket.x, y: rocket.y, vx: rocket.vx, vy: rocket.vy,
                        angle: rocket.angle, throttle: rocket.throttle, fuel: rocket.fuel,
                        state: rocket.state, landed: rocket.landed, heat: rocket.heat || 0,
                    },
                    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
                    vessels: vessels.filter(v => v.id !== activeVesselId).map(v => ({
                        def: v.def, hp: v.hp, temp: v.temp, dead: [...v.dead], chutes: v.chutes || {},
                        x: v.x, y: v.y, vx: v.vx, vy: v.vy, angle: v.angle,
                        fuel: v.fuel, throttle: v.throttle, state: v.state,
                        landed: v.landed, heat: v.heat || 0,
                    })),
                };
                localStorage.setItem(MISSION_KEY, JSON.stringify(data));
            } catch (e) { /* 浏览器不给用 localStorage 就算了 */ }
        }

        function clearMission() {
            try { localStorage.removeItem(MISSION_KEY); } catch (e) {}
        }

        // 恢复上一次的任务。成功返回 true（调用方就别再把船摆回地面了）。
        function loadMission() {
            try {
                const raw = localStorage.getItem(MISSION_KEY);
                if (!raw) return false;
                const d = JSON.parse(raw);
                if (!d || d.v !== 1) return false;
                if (!d.ship || !Array.isArray(d.ship.parts) || d.ship.parts.length === 0) return false;
                if (d.sig !== shipPartsSig(pristineShip.parts)) return false;   // 换过船，旧任务作废

                const fixed = sanitizeShipDef({ version: 1, name: d.ship.name || '当前航天器',
                                                parts: d.ship.parts.filter(p => p && PART_TYPES[p.type]) });
                const parts = fixed.def.parts;
                if (parts.length === 0) return false;

                // 主船（含被炸掉的部件 id、剩余耐久）
                shipDef = { version: 1, name: d.ship.name || '当前航天器', parts };
                SPEC = shipSpec(shipDef);
                destroyed = new Set(Array.isArray(d.destroyed) ? d.destroyed : []);
                partHP = {};
                for (const p of shipDef.parts) {
                    partHP[p.id] = (d.hp && typeof d.hp[p.id] === 'number') ? d.hp[p.id] : (PART_HP[p.type] || 100);
                }
                partTemp = initPartTemp();
                chuteStates = d.chutes || {};   // 恢复各伞状态（缺省 packed）
                rocket.fuel = totalRatio();
                invalidateShipCache();
                if (d.rocket && typeof d.rocket === 'object') Object.assign(rocket, d.rocket);
                lastComFuel = -1;
                if (d.camera && typeof d.camera === 'object') Object.assign(camera, d.camera);

                // 分离出去、还在惯性飞的残骸
                vessels = vessels.filter(v => v.id === activeVesselId);
                vesselSeq = 1;
                if (Array.isArray(d.vessels)) {
                    for (const w of d.vessels) {
                        if (!w || !w.def || !Array.isArray(w.def.parts)) continue;
                        const wp = w.def.parts.filter(p => p && PART_TYPES[p.type]);
                        if (wp.length === 0) continue;
                        const v = makeVessel(wp, w.x, w.y, w.vx || 0, w.vy || 0, w.angle || 0,
                                             (typeof w.fuel === 'number' ? w.fuel : 1));
                        if (w.hp) v.hp = w.hp;
                        if (w.temp) v.temp = w.temp;
                        v.dead = new Set(Array.isArray(w.dead) ? w.dead : []);
                        v.throttle = (typeof w.throttle === 'number') ? w.throttle : 1;
                        v.state = w.state || 'idle';
                        v.landed = !!w.landed;
                        v.heat = w.heat || 0;
                        v.chutes = w.chutes || {};
                        vessels.push(v);
                    }
                }
                resetInterp();
                missionRestored = true;
                missionSig = d.sig;
                return true;
            } catch (e) { return false; }
        }

        // ==================== 分离 ====================
        // 中间炸断了，船就断成两截（甚至更多）。
        // 用「并查集」找出哪些部件还连在一起 —— 挨着的算同一截。
        function findConnectedGroups(parts, destroyed) {
            const alive = parts.filter(p => !destroyed.has(p.id));
            const parent = {};
            for (const p of alive) parent[p.id] = p.id;
            function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
            function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

            // 两个部件的格子区域是否相邻（含重叠）
            function touching(a, b) {
                const ta = PART_TYPES[a.type], tb = PART_TYPES[b.type];
                if (!ta || !tb) return false;
                const aL = a.x, aR = a.x + ta.w, aB = a.y, aT = a.y + ta.h;
                const bL = b.x, bR = b.x + tb.w, bB = b.y, bT = b.y + tb.h;
                // 允许 1 格容差（斜对角也算连着）
                return aL <= bR + 1 && aR >= bL - 1 && aB <= bT + 1 && aT >= bB - 1;
            }

            for (let i = 0; i < alive.length; i++) {
                for (let j = i + 1; j < alive.length; j++) {
                    if (touching(alive[i], alive[j])) union(alive[i].id, alive[j].id);
                }
            }
            const groups = {};
            for (const p of alive) {
                const r = find(p.id);
                (groups[r] = groups[r] || []).push(p);
            }
            return Object.values(groups);
        }

        // ==================== 载入过滤：悬空零件 ====================
        // 造船厂有「必须相邻」的放置规则，但旧存档/手改数据可能带着悬空零件
        //（发射时整船是一个刚体，悬空件跟着飞，视觉上就是「浮空零件」）。
        // 载入时只保留一个连通组：优先保留含控制舱的组，否则保留最大的组。
        function sanitizeShipDef(def) {
            if (!def || !Array.isArray(def.parts) || def.parts.length === 0) return { def, dropped: 0 };
            const groups = findConnectedGroups(def.parts, new Set());
            if (groups.length <= 1) return { def, dropped: 0 };
            let best = groups[0];
            for (const g of groups) {
                const bestCap = best.some(p => p.type === 'capsule');
                const gCap = g.some(p => p.type === 'capsule');
                if (gCap && !bestCap) best = g;
                else if (gCap === bestCap && g.length > best.length) best = g;
            }
            return { def: { version: def.version, name: def.name, parts: best },
                     dropped: def.parts.length - best.length };
        }

        // 把当前飞船按「还连在一起的部件」拆成若干航天器
        // 返回新产生的那些（不含仍然操控中的那艘）
        function splitVessel(axial) {
            const groups = findConnectedGroups(shipDef.parts, allDead());
            // 先捕获被切断部件的对象引用（此刻 shipDef 里还有它们；
            // 主分支重设 shipDef 后就只能靠这里的引用找回）
            const severedParts = shipDef.parts.filter(p => severed.has(p.id));
            if (groups.length <= 1) return [];

            // 挑出有控制舱的那组当主角；没有就挑最大的那组
            let mainIdx = groups.findIndex(g => g.some(p => p.type === 'capsule'));
            if (mainIdx < 0) {
                let best = 0;
                groups.forEach((g, i) => { if (g.length > groups[best].length) best = i; });
                mainIdx = best;
            }

            const born = [];
            // 主段会在循环中途替换 SPEC、挪动 rocket，先存住「分离前整船」的
            // 质心 / 中轴 / 底面 / 原点，给摆放公式用
            const prevCom = { x: SPEC.com.x, y: SPEC.com.y };
            const oldCx = SPEC.centerX;
            const oldMaxY = SPEC.box.maxY;
            const originX = rocket.x, originY = rocket.y;
            groups.forEach((g, i) => {
                if (i === mainIdx) {
                    // 主控那截：留在 rocket 里继续用
                    shipDef = { version: 1, name: shipDef.name, parts: g };
                    SPEC = shipSpec(shipDef);
                    invalidateShipCache();
                    // 锚点跟着新质心挪，主段部件才不会跳位（推导同下方 born 分支）
                    {
                        const dXm = (SPEC.centerX - oldCx) * PART_PX;
                        const dYm = (oldMaxY - SPEC.box.maxY) * PART_PX;
                        const oXm = SPEC.com.x - prevCom.x + dXm;
                        const oYm = SPEC.com.y - prevCom.y + dYm;
                        const am = (rocket.angle - 90) * Math.PI / 180;
                        rocket.x += oXm * Math.cos(am) - oYm * Math.sin(am);
                        rocket.y += oXm * Math.sin(am) + oYm * Math.cos(am);
                    }
                    // 燃料按箱存储：分离后各截带走自己格子里的油箱和油，
                    // 无需重新归一（per-tank 模型天然正确）。
                    // 同步更新登记在 vessels 里的主船记录
                    for (const v of vessels) {
                        if (v.id === activeVesselId) {
                            v.def = shipDef;
                            v.spec = SPEC;
                        }
                    }
                    return;
                }
                // 其它截：变成失控的航天器。
                // 摆放公式：要求分离瞬间每个部件的世界位置不变 ——
                //   v + R(l' - com2) = origin + R(l - prevCom)，其中 l' = l - (Δx,Δy)，
                //   Δx = (cx新 - cx老)·P，Δy = (maxY老 - maxY新)·P（同一部件在两套
                //   本地坐标里的差，对整组恒定）。解出
                //   v = origin + R( com2 - prevCom + (Δx, Δy) )。
                // 旧实现只算了水平 offX、offY 算了没用，各截全叠在主段原点附近。
                const spec = shipSpec({ version: 1, parts: g });
                const dX = (spec.centerX - oldCx) * PART_PX;
                const dY = (oldMaxY - spec.box.maxY) * PART_PX;
                const offX = spec.com.x - prevCom.x + dX;
                const offY = spec.com.y - prevCom.y + dY;
                const a = (rocket.angle - 90) * Math.PI / 180;
                const wx = originX + offX * Math.cos(a) - offY * Math.sin(a);
                const wy = originY + offX * Math.sin(a) + offY * Math.cos(a);
                const v = makeVessel(g, wx, wy, rocket.vx, rocket.vy, rocket.angle, partsRatio(g));
                // 带伤分离：血量/温度从主船表按 id 切过去（旧实现满血复活）
                for (const p of g) {
                    if (partHP[p.id] !== undefined) v.hp[p.id] = partHP[p.id];
                    if (partTemp[p.id] !== undefined) v.temp[p.id] = partTemp[p.id];
                }
                v.def.name = '残骸 ' + v.id.slice(1);
                v.spin = (Math.random() - 0.5) * 40;   // 爆炸冲量 → 随机翻滚
                // 伞状态跟着部件走到对应截
                for (const p of g) {
                    if (chuteStates[p.id] !== undefined) v.chutes[p.id] = chuteStates[p.id];
                }
                vessels.push(v);
                born.push(v);
            });

            // 分离本身给两边一点推开的力
            if (axial) {
                // 分离器分级：沿船体轴向确定性分离——下级向船尾抛出，主机反冲。
                // 轴向冲量是分级手感的灵魂：干净、可控、不翻滚。
                const a = (rocket.angle - 90) * Math.PI / 180;
                const downX = -Math.sin(a), downY = Math.cos(a);
                rocket.vx -= downX * 3;
                rocket.vy -= downY * 3;
                for (const v of born) {
                    v.vx += downX * 12;
                    v.vy += downY * 12;
                    v.spin = (Math.random() - 0.5) * 15;
                }
            } else {
                const push = 30;
                rocket.vx += (Math.random() - 0.5) * push;
                rocket.vy += (Math.random() - 0.5) * push;
                for (const v of born) {
                    v.vx -= (Math.random() - 0.5) * push;
                    v.vy -= (Math.random() - 0.5) * push;
                }
            }

            toastQueue.push({
                title: '结 构 分 离',
                name: '飞船断成 ' + groups.length + ' 截',
                desc: born.length + ' 截失控，只有带控制舱的那截能操控',
            });
            // severed（分离器切断）的部件不在任何组里——重新挂到相邻的 born 截，
            // 并带走自己的伞状态。分离器本体跟着被抛的那一级走。
            const orphans = severedParts;
            for (const op of orphans) {
                const ot = PART_TYPES[op.type];
                const home = born.find(v => v.def.parts.some(q => {
                    const qt = PART_TYPES[q.type];
                    return op.x <= q.x + qt.w + 1 && op.x + ot.w >= q.x - 1 &&
                           op.y <= q.y + qt.h + 1 && op.y + ot.h >= q.y - 1;
                })) || born[0];
                if (home) {
                    home.def.parts.push(op);
                    home.spec = shipSpec(home.def);
                    home.hp[op.id] = home.hp[op.id] || (PART_HP[op.type] || 80);
                    home.temp[op.id] = home.temp[op.id] || AMBIENT_TEMP;
                    if (chuteStates[op.id] !== undefined) home.chutes[op.id] = chuteStates[op.id];
                }
                severed.delete(op.id);
            }
            invalidateShipCache();
            lastComFuel = -1;

            unlock('split_vessel');
            if (vessels.length >= 3) unlock('derelict_keeper');
            return born;
        }

        // ==================== 切换操控（多飞船核心）====================
        // 把目标航天器提升为主视图，当前主船降级为世界里可接管的船。
        // mainView 是「模块级船位」的门面（getter 跟随模块变量）——
        // 所以接管 = 把目标的状态换入船位，成本极低且所有 HUD/存档自动正确。
        function activateVessel(id) {
            if (!id || id === activeVesselId) return false;
            const target = vessels.find(v => v.id === id);
            if (!target) return false;
            if (!vesselHasCapsule(target)) {
                toastQueue.push({
                    title: '无 法 接 管',
                    name: '这艘船没有能用的控制舱',
                    desc: '只有带控制舱的航天器可以操控',
                });
                return false;
            }
            // 1) 旧主船降级：把主视图当前状态物化成一个残骸对象（带伤原样带出）
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
            old.chutes = chuteStates;   // 旧船的伞状态跟着船走
            const idx = vessels.indexOf(mainView);
            if (idx >= 0) vessels[idx] = old; else vessels.push(old);
            // 2) 目标状态换入船位
            shipDef = target.def;
            SPEC = target.spec;
            partHP = target.hp;
            partTemp = target.temp;
            destroyed = target.dead;
            rocket.x = target.x; rocket.y = target.y;
            rocket.vx = target.vx; rocket.vy = target.vy;
            rocket.angle = target.angle;
            rocket.fuel = partsRatio(target.def.parts);   // 接管目标的燃料比
            rocket.throttle = target.throttle;
            rocket.state = target.state === 'firing' ? 'idle' : target.state;
            rocket.landed = target.landed;
            rocket.heat = target.heat || 0;
            chuteStates = target.chutes || {};   // 接管目标的伞状态
            // 3) 目标槽位换回主视图：mainView 必须留在 vessels 里
            //    （船-船碰撞、状态上报都遍历 vessels；invariant：列表里
            //    恒有且仅有一个 mainView 条目，id = activeVesselId）
            const tIdx = vessels.indexOf(target);
            if (tIdx >= 0) vessels[tIdx] = mainView;
            lastComFuel = -1;
            invalidateShipCache();
            resetImpactBudget();
            resetInterp();
            toastQueue.push({
                title: '切 换 操 控',
                name: shipDef.name || '已接管航天器',
                desc: '按 V 可在航天器之间切换',
            });
            return true;
        }

        // V 键：在所有「含活着控制舱的航天器」之间循环接管
        function cycleVessel() {
            const curIdx = vessels.findIndex(v => v.id === activeVesselId);
            for (let i = 1; i <= vessels.length; i++) {
                const v = vessels[(curIdx + i) % vessels.length];
                if (v.id !== activeVesselId && vesselHasCapsule(v)) {
                    activateVessel(v.id);
                    return;
                }
            }
            toastQueue.push({
                title: '没 有 其 他 船',
                name: '没有可接管的航天器',
                desc: '只有带控制舱的船可以接管（炸断船体可获得多截）',
            });
        }

        // ==================== 分级系统（KSP 式）====================
        // 分级 = 一组待触发动作（切断分离器 / 展开该级降落伞）。
        // 自动规则：分离器按 y 升序（自底向上）= 第 0..n-1 级；
        // 降落伞默认属于「所在段 +1」级（段被抛离后下一回合开伞）。
        // 造船厂可为每个动作部件指定 stage 覆盖默认值。
        function stageOf(part) {
            if (typeof part.stage === 'number') return part.stage;
            const decs = shipDef.parts
                .filter(p => p.type === 'decoupler' && !destroyed.has(p.id) && !severed.has(p.id))
                .sort((a, b) => b.y - a.y);   // 底级先抛（分级惯例）：y 最大的分离器 = 第 0 级
            if (part.type === 'decoupler') return decs.indexOf(part);
            // 降落伞：所在段 = 比它位置低的分离器数量；开伞排在下一段
            return Math.min(decs.filter(d => d.y < part.y).length, decs.length);
        }
        function computeStageActions() {
            const list = [];
            for (const p of shipDef.parts) {
                if (destroyed.has(p.id) || severed.has(p.id)) continue;
                if (p.type === 'decoupler') list.push({ stage: stageOf(p), kind: 'sever', part: p });
                else if (p.type === 'chute') list.push({ stage: stageOf(p), kind: 'chute', part: p });
            }
            list.sort((a, b) => a.stage - b.stage);
            return list;
        }
        function stagePending(a) {
            if (a.kind === 'sever') return !severed.has(a.part.id);
            return chuteStateOf(a.part.id) === 'packed';
        }
        // 空格：激活序号最小的未完成分级（执行该级全部动作）
        function activateNextStage() {
            const acts = computeStageActions().filter(stagePending);
            if (acts.length === 0) {
                toastQueue.push({ title: '没 有 分 级', name: '所有分级已用尽', desc: '分离器/降落伞都已动作完毕' });
                return;
            }
            const stage = acts[0].stage;
            const batch = acts.filter(a => a.stage === stage);
            const before = vessels.length;
            for (const a of batch) {
                if (a.kind === 'sever') {
                    severed.add(a.part.id);
                } else {
                    chuteStates[a.part.id] = 'open';
                }
            }
            checkSeparation(true);                 // 轴向分离（若有截断）
            if (vessels.length === before) {
                detachSeveredParts();              // 没切断任何东西 → 侧挂/末端分离器整根脱离
            }
            unlock('first_staging');
            if (vessels.length > before && hasWorkingEngine() && totalCap() === 0) {
                toastQueue.push({
                    title: '警 告',
                    name: '上面级没有燃料箱',
                    desc: '分离后发动机无法点火——上面级需要自己的油箱',
                });
            }
            const names = batch.map(a => a.kind === 'sever' ? '分离' : '开伞').join(' + ');
            toastQueue.push({
                title: '激 活 分 级 ' + (stage + 1),
                name: names,
                desc: '剩余分级 ' + computeStageActions().filter(stagePending).length + ' 个',
            });
        }

        // 侧挂 / 末端的分离器切不断船体：整个脱离成一艘单件小船
        function detachSeveredParts() {
            const loose = shipDef.parts.filter(p => severed.has(p.id));
            if (loose.length === 0) return;
            shipDef.parts = shipDef.parts.filter(p => !severed.has(p.id));
            SPEC = shipSpec(shipDef);
            const v = makeVessel(loose, rocket.x, rocket.y, rocket.vx, rocket.vy, rocket.angle, partsRatio(loose));
            v.def.name = '分离器';
            // 沿「部件相对船体质心的方向」弹开
            const P = PART_PX;
            const ty = PART_TYPES[loose[0].type];
            const cxL = (loose[0].x + ty.w / 2 - SPEC.centerX) * P;
            const cyL = (SPEC.box.maxY - (loose[0].y + ty.h / 2)) * P;
            const a = (rocket.angle - 90) * Math.PI / 180;
            const wx = rocket.x + (cxL - SPEC.com.x) * Math.cos(a) - (cyL - SPEC.com.y) * Math.sin(a);
            const wy = rocket.y + (cxL - SPEC.com.x) * Math.sin(a) + (cyL - SPEC.com.y) * Math.cos(a);
            v.x = wx; v.y = wy;
            const ddx = wx - rocket.x, ddy = wy - rocket.y;
            const dl = Math.hypot(ddx, ddy) || 1;
            v.vx = rocket.vx + (ddx / dl) * 10;
            v.vy = rocket.vy + (ddy / dl) * 10;
            for (const p of loose) severed.delete(p.id);
            invalidateShipCache();
            lastComFuel = -1;
            vessels.push(v);
        }

        // 失控航天器：走**和玩家船同一套**物理（引力/大气阻力/撞击损伤/再入加热）
        // 以前残骸只有引力和阻力，于是「残骸永远不会被烧毁、不会掉血」，
        // 和玩家船形成两套逻辑 —— 这就是各种不一致的根源。
        function updateDerelicts(dt) {
            for (const v of vessels) {
                if (v.id === activeVesselId) continue;

                // 冷却计时（和主船同一套机制）
                if (v._impactCooldown > 0) v._impactCooldown -= dt;

                // 再入加热 —— 残骸也会被烧毁
                updateHeat(dt, v);

                // 自旋：分离/撞击带来的翻滚（着陆后停转）
                if (v.landed) {
                    if (v.spin) v.spin = 0;
                } else if (v.spin) {
                    v.angle = ((v.angle + v.spin * dt) % 360 + 360) % 360;
                }

                if (v.landed) continue;

                // 引力
                const g = gravityAt(v.x, v.y);
                v.vx += g.ax * dt;
                v.vy += g.ay * dt;

                // 大气阻力
                const dens = atmosphereDensity(v.x, v.y);
                if (dens > 0) {
                    const sp = Math.hypot(v.vx, v.vy);
                    if (sp > 1) {
                        const drag = DRAG_COEF * dens * sp * sp;
                        v.vx -= (v.vx / sp) * drag * dt;
                        v.vy -= (v.vy / sp) * drag * dt;
                    }
                }

                v.x += v.vx * dt;
                v.y += v.vy * dt;

                // 撞地：和主船一样的处理 —— 推出地面、分解速度、算撞击损伤
                const hit = lowestCollisionPointFor(v, v.angle);
                if (hit && hit.dist > 0 && hit.dist < planet.radius) {
                    const push = planet.radius - hit.dist;
                    const ux = (hit.world.x - planet.x) / hit.dist;
                    const uy = (hit.world.y - planet.y) / hit.dist;
                    v.x += ux * push;
                    v.y += uy * push;

                    const nx = -ux, ny = -uy;
                    const intoGround = v.vx * nx + v.vy * ny;
                    const slideX = v.vx - intoGround * nx;
                    const slideY = v.vy - intoGround * ny;

                    // 撞击损伤 —— 残骸也会被撞坏
                    if (intoGround > DAMAGE_SPEED) {
                        applyImpact(intoGround, v);
                    }

                    if (intoGround > LANDING_SPEED) {
                        // 弹一下
                        const bounce = intoGround * 0.28;
                        v.vx = slideX * GROUND_FRICTION - nx * bounce;
                        v.vy = slideY * GROUND_FRICTION - ny * bounce;
                    } else {
                        // 停下
                        v.vx = slideX * GROUND_FRICTION;
                        v.vy = slideY * GROUND_FRICTION;
                        if (Math.hypot(v.vx, v.vy) < 12) {
                            v.vx = 0; v.vy = 0; v.landed = true;
                        }
                    }
                }
            }
        }

        // ==================== 船-船碰撞 ====================
        // 主船与残骸、残骸互相之间：包围球粗检 → 沿质心连线推开（按质量分配）
        // → 法向动量交换（恢复系数 0.3）→ 相对速度够大时双方掉血/翻滚。
        // 以前飞船互相穿过 —— 多飞船没有物理存在感的一大来源。
        function collideVessels() {
            for (let i = 0; i < vessels.length; i++) {
                for (let j = i + 1; j < vessels.length; j++) {
                    const va = vessels[i], vb = vessels[j];
                    if (va.landed && vb.landed) continue;   // 两个都停着不动就不管
                    const ra = Math.max(va.spec.width, va.spec.height) * 0.55;
                    const rb = Math.max(vb.spec.width, vb.spec.height) * 0.55;
                    const dx = vb.x - va.x, dy = vb.y - va.y;
                    const dist = Math.hypot(dx, dy) || 0.001;
                    if (dist >= ra + rb) continue;
                    const nx = dx / dist, ny = dy / dist;
                    const ma = Math.max(1, vesselMass(va).total);
                    const mb = Math.max(1, vesselMass(vb).total);
                    // 推开重叠（重的一方少动）
                    const overlap = (ra + rb) - dist;
                    va.x -= nx * overlap * (mb / (ma + mb));
                    va.y -= ny * overlap * (mb / (ma + mb));
                    vb.x += nx * overlap * (ma / (ma + mb));
                    vb.y += ny * overlap * (ma / (ma + mb));
                    // 法向冲量（只在相互接近时）
                    const rv = (vb.vx - va.vx) * nx + (vb.vy - va.vy) * ny;
                    if (rv < 0) {
                        const e = 0.3;
                        const j = -(1 + e) * rv / (1 / ma + 1 / mb);
                        va.vx -= (nx * j) / ma;
                        va.vy -= (ny * j) / ma;
                        vb.vx += (nx * j) / mb;
                        vb.vy += (ny * j) / mb;
                        // 着陆的船被撞醒
                        if (j / ma > 5) va.landed = false;
                        if (j / mb > 5) vb.landed = false;
                        // 自旋扰动（主船姿态归玩家管）
                        if (!va.isMain) va.spin = Math.max(-360, Math.min(360, (va.spin || 0) + (Math.random() - 0.5) * (-rv) * 0.1));
                        if (!vb.isMain) vb.spin = Math.max(-360, Math.min(360, (vb.spin || 0) + (Math.random() - 0.5) * (-rv) * 0.1));
                        // 相对速度够大 → 双方掉血
                        if (-rv > DAMAGE_SPEED) {
                            applyImpact(-rv, va);
                            applyImpact(-rv, vb);
                        }
                    }
                }
            }
        }

        // 任意一艘船的碰撞检测（和主船同一套逻辑，只是换了对象）
        function lowestCollisionPointFor(v, angleDeg) {
            let best = null, bestD = Infinity;
            for (const p of v.spec.corners) {
                const a = (angleDeg - 90) * Math.PI / 180;
                const rx = p.x - v.spec.com.x, ry = p.y - v.spec.com.y;
                const wx = v.x + rx * Math.cos(a) - ry * Math.sin(a);
                const wy = v.y + rx * Math.sin(a) + ry * Math.cos(a);
                const dx = wx - planet.x, dy = wy - planet.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < bestD) { bestD = d; best = { local: p, world: { x: wx, y: wy }, dist: d }; }
            }
            return best;
        }

        // 下面三个都走缓存，不再每次遍历全部部件
        function alivePartCount() { return shipInfo().alive; }
        function hasWorkingEngine() { return shipInfo().engine > 0; }
        function hasWorkingCapsule() { return shipInfo().capsule > 0; }
        // 日志计时器
        let lastLogTime = 0;
        const LOG_INTERVAL = 1000; // 每秒输出一次日志

        // ==== 键盘监听（所有操作都有对应的键）====
        // A/D 旋转、↑/↓ 油门，都用“按住”状态，在 physicsStep 里按时间处理，又快又稳
        const keys = { left: false, right: false, throttleUp: false, throttleDown: false, fine: false, refuel: false, dump: false, zoomIn: false, zoomOut: false };

        // 观战端：除了音乐、成就、协同面板，其它按键一律不生效
        function spectatorAllows(code) {
            return code === 'KeyM' || code === 'KeyC' || code === 'KeyT' || code === 'KeyS' || code === 'KeyL';
        }

        function onKeyDown(e) {
            if (isSpectator() && !spectatorAllows(e.code)) return;
            if (e.code === 'KeyA') { keys.left = true; return; }
            if (e.code === 'KeyD') { keys.right = true; return; }
            if (e.code === 'ArrowUp') { keys.throttleUp = true; e.preventDefault(); return; }
            if (e.code === 'ArrowDown') { keys.throttleDown = true; e.preventDefault(); return; }
            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { keys.fine = true; return; }
            // 燃料：+ 加油、- 卸油（按住会持续加减）
            if (e.code === 'Equal' || e.code === 'NumpadAdd') { keys.refuel = true; return; }
            if (e.code === 'Minus' || e.code === 'NumpadSubtract') { keys.dump = true; return; }
            // 缩放：[ 缩小、] 放大（按住会持续缩放）
            if (e.code === 'BracketLeft') { keys.zoomOut = true; return; }
            if (e.code === 'BracketRight') { keys.zoomIn = true; return; }
            if (e.repeat) return;   // 单次动作键不吃键盘自动重复：长按 . 不该连跳几十档
            if (e.code === 'KeyC') { toggleAchievementPanel(); return; }
            if (e.code === 'KeyM') { toggleBgm(); return; }
            if (e.code === 'KeyR') { respawnOnGround(); return; }
            // 时间加速：逗号减速、句号加速（T 已经被「触控面板」占用）
            if (e.code === 'Comma') { cycleTimeScale(-1); return; }
            if (e.code === 'Period') { cycleTimeScale(1); return; }
            if (e.code === 'KeyT') { toggleTouchPanel(); return; }
            if (e.code === 'KeyV') cycleVessel();
            if (e.code === 'Space') {
                e.preventDefault();   // 防止空格滚动页面
                activateNextStage();
                return;
            }
            if (e.code === 'KeyP') toggleChute();
            if (e.code === 'KeyE') toggleEngine();
            if (e.code === 'KeyS') saveGame();
            if (e.code === 'KeyL') loadGame();
        }

        function onKeyUp(e) {
            if (e.code === 'KeyA') keys.left = false;
            if (e.code === 'KeyD') keys.right = false;
            if (e.code === 'ArrowUp') keys.throttleUp = false;
            if (e.code === 'ArrowDown') keys.throttleDown = false;
            if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.fine = false;
            if (e.code === 'Equal' || e.code === 'NumpadAdd') keys.refuel = false;
            if (e.code === 'Minus' || e.code === 'NumpadSubtract') keys.dump = false;
            if (e.code === 'BracketLeft') keys.zoomOut = false;
            if (e.code === 'BracketRight') keys.zoomIn = false;
        }

        // 键盘和屏幕按键都走这两个函数，两条输入路径永远一致
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        // 切走窗口时松开所有键，免得回来飞船还在自己转、油门自己往上涨
        window.addEventListener('blur', () => {
            keys.left = false;
            keys.right = false;
            keys.throttleUp = false;
            keys.throttleDown = false;
            keys.fine = false;
            keys.refuel = false;
            keys.dump = false;
            keys.zoomIn = false;
            keys.zoomOut = false;
        });

        // ==================== 触控按键 ====================
        // 屏幕按键“按下” = 按下对应的键，所以键鼠和触控能做到的事完全一样
        const touchButtons = [
            ['t-left', 'KeyA'], ['t-right', 'KeyD'],
            ['t-thr-up', 'ArrowUp'], ['t-thr-down', 'ArrowDown'],
            ['t-ignite', 'KeyE'],
            ['t-zoom-in', 'BracketRight'], ['t-zoom-out', 'BracketLeft'],
            ['t-fuel', 'Equal'], ['t-dump', 'Minus'], ['t-chute', 'KeyP'], ['t-vessel', 'KeyV'],
            ['t-sep', 'Space'],
        ];

        touchButtons.forEach((pair) => {
            const btn = document.getElementById(pair[0]);
            if (!btn || !btn.addEventListener) return;
            const code = pair[1];
            const press = (ev) => {
                if (ev && ev.preventDefault) ev.preventDefault();
                if (isSpectator() && !spectatorAllows(code)) return;   // 观战端不能操控
                if (btn.classList) btn.classList.add('active');
                startBgm();     // 手机上第一次摸屏幕，顺便把音乐带起来
                onKeyDown({ code: code, repeat: false, shiftKey: false, preventDefault() {} });
            };
            const release = (ev) => {
                if (ev && ev.preventDefault) ev.preventDefault();
                if (btn.classList) btn.classList.remove('active');
                onKeyUp({ code: code });
            };
            btn.addEventListener('pointerdown', press);
            btn.addEventListener('pointerup', release);
            btn.addEventListener('pointercancel', release);
            btn.addEventListener('pointerleave', release);
            btn.addEventListener('contextmenu', (ev) => { if (ev.preventDefault) ev.preventDefault(); });
        });

        // “微调”是个开关（键盘上是按住 Shift），触控点一下就切换
        const fineBtn = document.getElementById('t-fine');
        if (fineBtn && fineBtn.addEventListener) {
            fineBtn.addEventListener('pointerdown', (ev) => {
                if (ev && ev.preventDefault) ev.preventDefault();
                keys.fine = !keys.fine;
                if (fineBtn.classList) {
                    if (keys.fine) fineBtn.classList.add('active');
                    else fineBtn.classList.remove('active');
                }
            });
        }

        // 触控面板：**默认打开**（桌面、手机都显示，鼠标点也行）。
        // 想收起来按 T 或点右上角「触控」，选择会记住。
        let touchPanelOn = true;
        try {
            // 换了新的存档键：以前记得「关」的旧记录一律作废，保证这次一定显示出来
            const savedTouch = localStorage.getItem('msp2d-touch-v2');
            if (savedTouch === '1') touchPanelOn = true;
            if (savedTouch === '0') touchPanelOn = false;
        } catch (e) {}

        function applyTouchPanel() {
            if (touchControlsEl) touchControlsEl.style.display = touchPanelOn ? 'block' : 'none';
        }

        function toggleTouchPanel() {
            touchPanelOn = !touchPanelOn;
            try { localStorage.setItem('msp2d-touch-v2', touchPanelOn ? '1' : '0'); } catch (e) {}
            applyTouchPanel();
        }

        applyTouchPanel();

        // ==== 发动机状态机（冷启动已去掉：按 E 直接点火 / 关机） ====
        function toggleEngine() {
            if (rocket.state === 'firing') {
                rocket.state = 'idle';        // 关机
                return;
            }
            if (!hasWorkingEngine()) {
                // 点火入口必须拦住死发动机：以前只有「撞击路径」会熄火，
                // 烧毁和分离路径都能让已经不存在的发动机满推力复活。
                toastQueue.push({
                    title: '无 法 点 火',
                    name: '没有能用的发动机',
                    desc: '发动机已被毁坏或随断船分离，按 R 修复飞船重新开始',
                });
                return;
            }
            if (rocket.landed) {
                unlock('first_flight');
                stats.launchX = rocket.x; // 记下起飞点，着陆时用来算飞了多远
                stats.launchY = rocket.y;
                stats.escaped = false;    // “迷路的猫”只算同一次飞行：逃逸了又自己回来
                resetImpactBudget();      // 新的一趟，重新计算能承受的撞击
            }
            rocket.state = 'firing';      // 点火；停在星球上按就是重新起飞
            rocket.landed = false;
        }

        // ==== 缩放（滚轮，或键盘 - / =）====
        // 缩放。步进是「自适应」的：缩得越小，每步跨度越大。
        // 不然从 0.5 缩到 0.012 要滚 35 次，手都要断了。
        // 做法：把 factor 相对 1 的偏差按当前缩放级别放大。
        function zoomBy(factor) {
            const span = Math.log(camera.maxZoom / camera.minZoom);
            // 当前处在整个缩放范围的位置（0 = 最近，1 = 最远）
            const depth = Math.log(camera.zoom / camera.minZoom) / span;
            const boost = 1 + depth * 6;            // 越远步子越大
            const f = 1 + (factor - 1) * boost;
            camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * f));
            // 放宽判定：缩放范围跨了 500 倍，浮点误差会累积，
            // 用 1e-6 这种绝对值判「到底了」根本判不到。
            // 改成按范围比例判：到了最小值的 1.02 倍以内就算到底。
            if (camera.zoom <= camera.minZoom * 1.02) unlock('zoom_min');
        }

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
        }, { passive: false });

        // ==================== 双指捏合缩放（手机 / 触摸屏）====================
        // 和按钮、滚轮走的是同一个 zoomBy，所以三种方式效果完全一样
        const activePointers = new Map();   // 每根手指的当前位置
        let pinchStartDist = 0;
        let pinchStartZoom = 1;

        function pointerDistance() {
            const pts = [...activePointers.values()];
            if (pts.length < 2) return 0;
            const dx = pts[0].x - pts[1].x;
            const dy = pts[0].y - pts[1].y;
            return Math.sqrt(dx * dx + dy * dy);
        }

        canvas.addEventListener('pointerdown', (e) => {
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (activePointers.size === 2) {
                pinchStartDist = pointerDistance();
                pinchStartZoom = camera.zoom;
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!activePointers.has(e.pointerId)) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (activePointers.size >= 2 && pinchStartDist > 0) {
                if (e.preventDefault) e.preventDefault();
                const ratio = pointerDistance() / pinchStartDist;
                // 直接按手指间距的比例缩放，跟手
                camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, pinchStartZoom * ratio));
                if (camera.zoom <= camera.minZoom * 1.02) unlock('zoom_min');
            }
        });

        function endPointer(e) {
            activePointers.delete(e.pointerId);
            if (activePointers.size < 2) pinchStartDist = 0;
        }
        canvas.addEventListener('pointerup', endPointer);
        canvas.addEventListener('pointercancel', endPointer);
        canvas.addEventListener('pointerleave', endPointer);

        // ==================== 降落伞 ====================
        // 状态按部件 id 存（packed/open/cut）——分级系统里每把伞独立展开。
        // 减速 = DRAG_COEF × 伞面积 × 打开数量 × 大气密度 × 速度²，实时按密度算：
        // 高空几乎没用，越往下越猛，和真实降落伞一样。
        const CHUTE_AREA = 1400;          // 等效阻力面积（每伞）
        const CHUTE_MIN_DENSITY = 0.004;  // 密度低于 0.4% 时伞基本没用
        let chuteStates = {};             // { 部件id: packed/open/cut }
        let chuteDragNow = 0;             // 当前伞总减速度（HUD 显示用）
        function chuteStateOf(id) { return chuteStates[id] || 'packed'; }
        function aliveChutes() {
            return shipDef.parts.filter(p => p.type === 'chute' && !destroyed.has(p.id) && !severed.has(p.id));
        }

        // 船上有没有降落伞（决定 P 键有没有意义）
        function hasChute() {
            return shipDef.parts.some(p => p.type === 'chute' && !destroyed.has(p.id));
        }
        // P 键：批量切换——有展开的→全部切断；有包好的→全部展开；全切断→落地重包
        function toggleChute() {
            const chutes = aliveChutes();
            if (chutes.length === 0) {
                toastQueue.push({ title: '没 有 降 落 伞', name: '造船厂里装一个吧', desc: '部件列表 > 降落伞' });
                return;
            }
            const states = chutes.map(p => chuteStateOf(p.id));
            if (states.includes('open')) {
                chutes.forEach(p => { chuteStates[p.id] = 'cut'; });
                toastQueue.push({ title: '降 落 伞 切 断', name: '伞飘走了', desc: '降落回地面后可以重新包伞' });
            } else if (states.includes('packed')) {
                chutes.forEach(p => { chuteStates[p.id] = 'open'; });
                toastQueue.push({
                    title: '降 落 伞 展 开',
                    name: '高度 ' + fmtDistance(Math.hypot(rocket.x - planet.x, rocket.y - planet.y) - planet.radius),
                    desc: '再按 P 可以切断',
                });
                unlock('chute_open');
            } else if (rocket.landed) {
                chutes.forEach(p => { chuteStates[p.id] = 'packed'; });
                toastQueue.push({ title: '重 新 包 伞', name: '降落伞已折好', desc: '按 P 可以再次展开' });
            } else {
                toastQueue.push({ title: '伞 已 切 断', name: '在空中没法重新包', desc: '落地后会自动重新包好' });
            }
        }

        // 落地自动重包（切断的伞也能折回来）
        function repackChuteIfLanded() {
            const chutes = aliveChutes();
            if (chutes.length === 0) return;
            const wasCut = chutes.some(p => chuteStateOf(p.id) === 'cut');
            chutes.forEach(p => { chuteStates[p.id] = 'packed'; });
            if (wasCut) {
                toastQueue.push({
                    title: '降 落 伞 已 重 新 包 好',
                    name: '按 P 可以再次展开',
                    desc: '',
                });
            }
        }

        // HUD 上那行降落伞状态
        function chuteHudLine() {
            const chutes = aliveChutes();
            if (chutes.length === 0) return '无伞';
            const openCount = chutes.filter(p => chuteStateOf(p.id) === 'open').length;
            if (openCount > 0) {
                const dens = atmosphereDensity(rocket.x, rocket.y);
                if (dens < CHUTE_MIN_DENSITY) return '伞: 展开(无大气,无效)';
                const g = SURFACE_GRAVITY_MS2 / M_PER_PX;
                const ratio = chuteDragNow / Math.max(1e-9, g);
                return '伞: 展开 ' + ratio.toFixed(1) + 'x重力 ×' + openCount;
            }
            if (chutes.every(p => chuteStateOf(p.id) === 'cut')) return '伞: 已切断';
            return '伞: 包好(P)';
        }

        // ==== 物理更新 ====
        function physicsStep(dt) {
            // 输入响应速率按真实时间：高倍时间加速下旋转/油门/加泄油不再被放大
            // 上百倍（旧实现 100x 下转一圈只要一帧，根本没法控制）。
            // 物理受力（引力/推力/阻力）仍按游戏时间走。
            const inputDt = dt / timeScale();
            // ==== 全毁锁定 ====
            // 一个活部件都不剩：船已是空壳。熄火、锁死全部操控，弹一次「任务失败」，
            // 按 R 修复重开。以前这里什么都不做 —— 玩家会开着一艘画不出来的
            // 「隐形船」继续飞、继续存档。
            const shipAlive = alivePartCount() > 0;
            if (shipAlive) {
                shipTotalLoss = false;
            } else {
                rocket.state = 'idle';
                rocket.throttle = 0;
                if (!shipTotalLoss) {
                    shipTotalLoss = true;
                    settleMission();   // 这一趟攒下的成就当场结算
                    toastQueue.push({
                        title: '任 务 失 败',
                        name: '航天器已完全损毁',
                        desc: '按 R 修复飞船重新开始',
                    });
                }
            }

            // 旋转放在最前面：停在地上也能先转好方向，再点火起飞
            if (shipAlive && keys.left) rocket.angle -= ROTATE_SPEED * inputDt;
            if (shipAlive && keys.right) rocket.angle += ROTATE_SPEED * inputDt;
            rocket.angle = ((rocket.angle % 360) + 360) % 360;

            // 缩放：按住 [ / ] 持续缩放（和滚轮、双指捏合同一个 zoomBy）
            if (shipAlive && (keys.zoomIn || keys.zoomOut)) {
                const zoomFactor = Math.pow(1 + ZOOM_RATE_PER_SEC, dt);
                if (keys.zoomIn) zoomBy(zoomFactor);
                if (keys.zoomOut) zoomBy(1 / zoomFactor);
            }

            // 节流阀：按住 ↑/↓ 调油门，按住 Shift 变成微调
            const rate = keys.fine ? THROTTLE_FINE_RATE : THROTTLE_RATE;
            if (shipAlive && keys.throttleUp) rocket.throttle = Math.min(1, rocket.throttle + rate * inputDt);
            if (shipAlive && keys.throttleDown) rocket.throttle = Math.max(0, rocket.throttle - rate * inputDt);
            if (shipAlive && keys.fine && (keys.throttleUp || keys.throttleDown)) unlock('fine_tune');

            // 加油 / 卸油：只能停在星球上的时候做（在空中按只会提醒你）
            if (shipAlive && (keys.refuel || keys.dump)) {
                if (rocket.landed) {
                    if (keys.refuel) {
                        for (const p of aliveTanks()) {
                            const t = PART_TYPES[p.type];
                            p.fuel = Math.min(t.fuel, tankFuel(p) + FUEL_FILL_RATE * t.fuel * inputDt);
                        }
                        if (totalRatio() >= 0.999) unlock('refuel_full');
                    }
                    if (keys.dump) {
                        const before = totalFuel();
                        for (const p of aliveTanks()) {
                            const t = PART_TYPES[p.type];
                            p.fuel = Math.max(0, tankFuel(p) - FUEL_FILL_RATE * t.fuel * inputDt);
                        }
                        stats.dumpedFuel += totalCap() > 0 ? (before - totalFuel()) / totalCap() : 0;
                        if (stats.dumpedFuel >= 0.5) unlock('dump_half');
                    }
                    fuelMsgTimer = 0;
                } else {
                    fuelMsgTimer = 2;
                }
            }
            // 引力
            const g = gravityAt(rocket.x, rocket.y);
            rocket.vx += g.ax * dt;
            rocket.vy += g.ay * dt;

            // 发动机烧燃料：油门越大烧得越快；燃料烧完就自动熄火
            let thrusting = false;
            if (rocket.state === 'firing' && rocket.throttle > 0) {
                if (!hasWorkingEngine() || shipInfo().fuelCap <= 0) {
                    // 发动机已烧毁/撞毁/随断船分离，或油箱全毁：想飞也飞不起来
                    rocket.state = 'idle';
                } else if (totalFuel() > 0) {
                    thrusting = true;
                    drainFuel(rocket.throttle * dt / FUEL_BURN_SECONDS);
                    rocket.fuel = totalRatio();   // 兼容镜像（HUD/上报/测试读这个）
                    if (totalFuel() <= 0.0001) {
                        rocket.state = 'idle';                          // 没油了，熄火
                        if (!rocket.landed) unlock('out_of_fuel');      // 在天上烧干 = 弹尽粮绝
                    }
                } else {
                    rocket.state = 'idle';
                }
            }

            if (thrusting) {
                // 推力沿着“船头”方向 (-cos, -sin)，大小 = 满油推力 × 油门 ÷ 当前质量。
                // 油烧掉一半，飞船就轻了，同样油门能推得更猛 —— 这就是“燃料减少重量也减少”。
                const a = rocket.angle * Math.PI / 180;
                const power = thrustAccel(rocket.throttle);
                rocket.vx += -Math.cos(a) * power * dt;
                rocket.vy += -Math.sin(a) * power * dt;
            }

            // ---- 空气阻力：只在大气层内有效，速度越快、密度越大，减速越狠 ----
            const dens = atmosphereDensity(rocket.x, rocket.y);
            let heating = 0;
            chuteDragNow = 0;
            if (dens > 0) {
                const sp = Math.hypot(rocket.vx, rocket.vy);
                if (sp > 1) {
                    // 阻力始终一致 —— 不管发动机开不开，物理都一样。
                    // SFS 里没有「点火时阻力打折」这种 hack。
                    const drag = DRAG_COEF * dens * sp * sp;
                    rocket.vx -= (rocket.vx / sp) * drag * dt;
                    rocket.vy -= (rocket.vy / sp) * drag * dt;

                    // ---- 降落伞：每把打开的伞独立提供减速 ----
                    // 面积 = 单伞面积 × 打开数量；分级系统里各伞可分别展开。
                    const openChutes = aliveChutes().filter(p => chuteStateOf(p.id) === 'open');
                    if (openChutes.length > 0 && dens > CHUTE_MIN_DENSITY) {
                        const chuteDrag = DRAG_COEF * CHUTE_AREA * openChutes.length * dens * sp * sp;
                        chuteDragNow = chuteDrag;
                        rocket.vx -= (rocket.vx / sp) * chuteDrag * dt;
                        rocket.vy -= (rocket.vy / sp) * chuteDrag * dt;
                    }
                }
                // 再入加热辉光：与损毁系统（updateHeat）同一套触发条件——
                // ①密度足够（>1%）②速度超再入阈值 ③确实在朝地面俯冲。
                // 旧实现只看速度：上升段也发光、稀薄高空也发光——出现时机错误。
                // 强度：速度 800→1200 线性爬升，按密度饱和放大（不再 ×3 一步到满）。
                if (dens > 0.01 && sp > REENTRY_SPEED) {
                    const rx = rocket.x - planet.x, ry = rocket.y - planet.y;
                    const r = Math.hypot(rx, ry) || 1;
                    const radialSpeed = (rocket.vx * rx + rocket.vy * ry) / r;
                    if (radialSpeed < -20) {   // 真的在朝地面俯冲
                        heating = Math.min(1, (sp - REENTRY_SPEED) / 400) * Math.min(1, dens * 4);
                    }
                }
            }
            rocket.heat = heating;

            rocket.x += rocket.vx * dt;
            rocket.y += rocket.vy * dt;

            // ==== 着陆判定（按碰撞箱，不再把飞船当成一个点）====
            // 找出整艘船上离星球中心最近的那个点：
            // 船头朝上垂直落地时是喷口先着地，斜着落是侧面先着地，
            // 所以船不会插进地里，也不会悬在半空。
            // 防穿地：一帧位移超过半个船身时，把这一步拆成几个小步走，
            // 免得高速下落时「一步跨过地面」，直接穿到星球里面去。
            // 上面已经按整帧加过一次位移了，所以这里先退回来，再按小步重新走。
            const fullMoveX = rocket.vx * dt;
            const fullMoveY = rocket.vy * dt;
            const moveLen = Math.hypot(fullMoveX, fullMoveY);
            const maxStep = Math.max(4, PART_PX * 0.5);
            if (moveLen > maxStep) {
                rocket.x -= fullMoveX;
                rocket.y -= fullMoveY;
                const sub = Math.min(16, Math.ceil(moveLen / maxStep));
                const sdt = dt / sub;
                for (let i = 0; i < sub; i++) {
                    rocket.x += rocket.vx * sdt;
                    rocket.y += rocket.vy * sdt;
                    const h2 = lowestCollisionPoint(rocket.angle);
                    if (h2 && h2.dist > 0 && h2.dist < planet.radius) break;
                }
            }

            const hit = lowestCollisionPoint(rocket.angle);

            if (hit && hit.dist > 0 && hit.dist < planet.radius) {
                // 1) 把船整体推回去，让那个碰撞点正好贴在地表
                const push = planet.radius - hit.dist;
                const ux = (hit.world.x - planet.x) / hit.dist;   // 从球心指向那个点
                const uy = (hit.world.y - planet.y) / hit.dist;
                rocket.x += ux * push;
                rocket.y += uy * push;

                // 2) 用同一个方向分解速度
                const nx = -ux, ny = -uy;                        // 指回球心
                const intoGround = rocket.vx * nx + rocket.vy * ny;   // >0 表示正在往地里扎
                const slideX = rocket.vx - intoGround * nx;
                const slideY = rocket.vy - intoGround * ny;

                // 结结实实砸了一下 —— 不管接下来是弹起来还是停住，都算数
                if (intoGround > 250) unlock('hard_landing');

                // ---- 撞击损毁：撞太狠就震坏 / 炸掉部件，并吃掉一部分速度 ----
                if (intoGround > DAMAGE_SPEED) {
                    const blew = applyImpact(intoGround);
                    if (blew > 0) {
                        unlock('true_hard_landing');
                        toastQueue.push({
                            title: '撞 击 警 报',
                            name: blew + ' 个部件被撞毁',
                            desc: '还有 ' + alivePartCount() + ' / ' + shipDef.parts.length + ' 个部件完好',
                        });
                    }
                    // 撞击消耗能量：残骸越破，速度掉得越多
                    const wreckRatio = 1 - alivePartCount() / Math.max(1, shipDef.parts.length);
                    const damp = Math.max(0.25, 0.75 - wreckRatio * 0.5);
                    rocket.vx *= damp;
                    rocket.vy *= damp;
                    // 没发动机了就彻底飞不起来
                    if (!hasWorkingEngine() && rocket.state === 'firing') rocket.state = 'idle';
                    // 炸断了吗？
                    if (blew > 0) checkSeparation();
                }

                // ---- 姿态警告：一碰地就检查，不用等停稳 ----
                {
                    const tiltHit = shipTiltDeg(rocket.angle);
                    if (tiltHit > 55 && intoGround > 1.5) {
                        if (!rocket._tiltNotified || Date.now() - rocket._tiltNotified > 4000) {
                            rocket._tiltNotified = Date.now();
                            toastQueue.push({
                                title: '姿 态 不 正',
                                name: '飞船横着砸到地上了',
                                desc: '倾角 ' + Math.round(tiltHit) + '°，要机头朝上才能稳稳着陆',
                            });
                        }
                    }
                }

                if (intoGround > 2 && rocket.state !== 'firing') {
                    // 只要砸到地上就弹一下（以前要 >180 才弹，10~30 的速度
                    // 直接被判成「稳稳停住」，看起来就是瞬间停）。
                    // 恢复系数随速度增长：
                    //   10 → 弹起 0.9 （轻微一跳）  30 → 弹起 4.5（明显一跳）
                    //  150 → 弹起 67 （摔得狠弹得高）
                    const restitution = Math.min(0.45, 0.06 + intoGround * 0.003);
                    // 姿态越歪弹得越猛（不是用「脚」着地）
                    const tiltB = shipTiltDeg(rocket.angle);
                    const tiltFactor = 1 + (tiltB / 90) * 1.5;
                    const bounce = intoGround * restitution * tiltFactor;

                    rocket.vx = slideX * GROUND_FRICTION - bounce * nx;
                    rocket.vy = slideY * GROUND_FRICTION - bounce * ny;

                    // 弹起来一点就别算着陆
                    if (bounce > 0.5) rocket.landed = false;
                } else {
                    // 没点火、稳稳停在地上：扎向地面的速度归零，
                    // 贴着地面滑的速度被摩擦慢慢磨掉，但"向外飞"的速度要留着
                    // —— 不然停在星球上就再也起不来了。
                    const outSpeed = Math.max(0, -intoGround);
                    rocket.vx = slideX * GROUND_FRICTION - outSpeed * nx;
                    rocket.vy = slideY * GROUND_FRICTION - outSpeed * ny;

                    if (!rocket.landed) {
                        // ---- 姿态判定 ----
                        // 机头偏离竖直方向多少度：0 = 完全竖直（正常着陆）
                        //                       >55 = 横躺/倒扣，不算正常着陆
                        const tilt = shipTiltDeg(rocket.angle);

                        if (tilt > 55) {
                            // 横着 / 倒扣着砸下来 —— 不是正常着陆，损失大部分能量
                            rocket.vx = slideX * 0.25;
                            rocket.vy = slideY * 0.25;
                            if (Math.hypot(rocket.vx, rocket.vy) > 2.5) {
                                rocket.landed = false;      // 还在滚
                            } else {
                                rocket.landed = true;
                                if (rocket.state === 'firing') rocket.state = 'idle';
                                repackChuteIfLanded();
                            }
                            if (!rocket._tiltNotified || Date.now() - rocket._tiltNotified > 4000) {
                                rocket._tiltNotified = Date.now();
                                toastQueue.push({
                                    title: '姿 态 不 正',
                                    name: '飞船横着砸到地上了',
                                    desc: '倾角 ' + Math.round(tilt) + '°，要机头朝上才能稳稳着陆',
                                });
                            }
                        } else {
                            // 正常着陆（倾角 <= 55°）
                            rocket.landed = true;
                            if (rocket.state === 'firing') rocket.state = 'idle';
                            repackChuteIfLanded();

                            // ---- 着陆成就（倾角越大越严格）----
                            if (tilt < 30) {
                                if (intoGround < 20) unlock('soft_landing');    // 轻轻落下
                                if (intoGround < 5) unlock('no_scratch');       // 毫发无伤
                            } else if (intoGround < 20) {
                                toastQueue.push({
                                    title: '勉 强 着 陆',
                                    name: '倾角 ' + Math.round(tilt) + '°',
                                    desc: '机头没朝上，下次注意姿态',
                                });
                            }
                            if (alivePartCount() < shipDef.parts.length / 2) unlock('survive_wreck');  // 残骸归来
                            if (rocket.fuel < 0.05) unlock('low_fuel_land');// 快没油了还能落回来
                            if (stats.escaped) unlock('homing_cat');        // 飞出去又自己回来了
                            if (Math.hypot(rocket.x - stats.launchX, rocket.y - stats.launchY) > 3000) {
                                unlock('round_trip');                       // 落点离起飞点很远
                            }
                            stats.escaped = false;

                            // 着陆结算：这一趟任务里拿到的成就一次性揭晓
                            settleMission();
                        }
                    }
                }
            } else {
                // 离开地面 = 自由飞行
                rocket.landed = false;
            }

            // 质心随燃料变化：油烧掉，重心会往船头偏（真实火箭也是这样）。
            // 只在燃料真变了时重算 —— 100x 滑行时这里每帧要白跑 260 次。
            if (totalFuel() !== lastComFuel) {
                SPEC.com = shipCenterOfMass(shipDef, SPEC, q => tankFuel(q));
                lastComFuel = totalFuel();
            }

            // 失控的航天器（惯性飞行，不能操控）
            updateDerelicts(dt);
            collideVessels();

            // 边界保护：飞出行星系统太远时给个提示，别让玩家莫名其妙一直飘
            {
                const r = Math.hypot(rocket.x - planet.x, rocket.y - planet.y);
                const farLimit = planet.radius * 60;
                if (r > farLimit && !stats.escapedFar) {
                    stats.escapedFar = true;
                    toastQueue.push({
                        title: '脱 离 引 力 范 围',
                        name: '你飞出了行星系统',
                        desc: '没有回头路了 —— 回不去的话按 R 重开这一趟',
                    });
                } else if (r < farLimit * 0.8) {
                    stats.escapedFar = false;
                }
            }

            // 再入加热（主船）
            updateHeat(dt, mainView);
            updateDebris(dt);
            // 主船的撞击冷却要随时间恢复。
            // 以前这里减的是另一个没人用的 impactCooldown，而 applyImpact 用的是
            // 每艘船自己的 v._impactCooldown —— 主船这个值一旦被设成 0.35 就永远不归零，
            // 于是第一次撞击之后，后面所有撞击都被判成「还在冷却」而免疫，船就撞不坏了。
            mainView._impactCooldown = Math.max(0, mainView._impactCooldown - dt);
            if (impactCooldown > 0) impactCooldown -= dt;

            // 成就检查（横幅计时已移到渲染循环：用真实时间，不受时间倍率影响）
            checkAchievements(dt);
        }

        // ==================== 画飞船（按部件逐块绘制）====================
        // 船的坐标：以「最底下那条边」为 y=0，向上为正，和造船厂一致。
        // 绘制时把中轴对齐到 rocket 的位置，所以船怎么摆都转得对。
        function drawShip(c, engineOn, now) {
            const spec = SPEC;
            const P = PART_PX;
            // 中轴、底面在船体本地坐标里的位置
            const midX = spec.centerX * P;        // 中轴（格 → 像素）
            const bottomLocal = spec.box.maxY * P; // 底面在本地坐标的 y（向下为正）

            for (const p of shipDef.parts) {
                const t = PART_TYPES[p.type];
                if (!t) continue;
                if (destroyed.has(p.id)) continue;   // 炸掉的部件不再画出来
                // 网格坐标（左下角，y 向上）→ 本地像素（左上角，y 向下）
                const x = p.x * P - midX;
                const y = bottomLocal - (p.y + t.h) * P;
                const w = t.w * P;
                const h = t.h * P;
                drawShipPart(c, p.type, t, x, y, w, h, chuteAnchor(shipDef, p));
            }

            // 点火时在发动机喷口画火焰
            if (engineOn) {
                const engines = shipDef.parts.filter(p => p.type === 'engine' && !destroyed.has(p.id));
                const flick = 0.75 + Math.random() * 0.45;
                for (const p of engines) {
                    const cx = (p.x + PART_TYPES.engine.w / 2) * P - midX;
                    const y = bottomLocal - p.y * P;     // 喷口在部件底面
                    const fw = P * 1.5, fh = P * (2.2 + 1.6 * flick);
                    const g = c.createLinearGradient(cx, y, cx, y + fh);
                    g.addColorStop(0, 'rgba(255, 240, 180, 0.95)');
                    g.addColorStop(0.35, 'rgba(255, 170, 40, 0.85)');
                    g.addColorStop(1, 'rgba(255, 80, 0, 0)');
                    c.beginPath();
                    c.moveTo(cx - fw / 2, y);
                    c.lineTo(cx + fw / 2, y);
                    c.lineTo(cx, y + fh);
                    c.closePath();
                    c.fillStyle = g;
                    c.fill();
                }
            }
        }

        // ==================== 画降落伞 ====================
        // 伞面永远朝「速度的反方向」张开（迎风面）——船往哪掉，伞就撑在哪边。
        // 展开程度随大气密度变化：密度低时伞瘪瘪的，越往下鼓得越圆。
        function drawChute(c, vx, vy, dens, heat, part) {
            if (chuteStateOf(part.id) !== 'open') return;
            const sp = Math.hypot(vx, vy);
            if (sp < 0.5) return;   // 几乎静止时不画（避免抖动）

            // 气流方向（速度反方向 = 伞要找的方向）
            const ux = vx / sp, uy = vy / sp;

            // 伞的“饱满程度”：密度越高越鼓，1.0 = 全开
            const fill = Math.max(0, Math.min(1, dens / 0.35));   // 35% 密度以上全鼓
            const spinNow = 0.35 + fill * 0.65;

            // 伞绳长度随船体尺寸走（整体约为旧版的 60%——旧版伞比船还大一圈）
            const ropeLen = Math.max(SPEC.width, SPEC.height) * 0.6;
            // 伞面半径
            const radius = Math.max(SPEC.width, SPEC.height) * (0.55 + fill * 0.55);

            // 伞心位置：从伞包部件出发，朝速度反方向升起（每把伞锚在自身部件上）
            const pt = PART_TYPES[part.type];
            const partCX = (part.x + pt.w / 2 - SPEC.centerX) * P;
            const partCY = (SPEC.box.maxY - (part.y + pt.h / 2)) * P;
            const hang = ropeLen + radius * 0.25;
            const cx = partCX - ux * hang;
            const cy = partCY - uy * hang;

            c.save();
            if (heat > 0.05) c.globalAlpha = Math.max(0.45, 1 - heat * 0.6);   // 热流中布面变暗

            // ---- 伞绳：从伞包部件连到伞心 ----
            c.strokeStyle = 'rgba(220, 220, 220, 0.85)';
            c.lineWidth = Math.max(0.6, 1.1);
            c.beginPath();
            const anchors = [
                [partCX - pt.w * P * 0.35, partCY],
                [partCX + pt.w * P * 0.35, partCY],
                [partCX, partCY],
            ];
            for (const a of anchors) {
                c.moveTo(a[0], a[1]);
                c.lineTo(cx, cy);
            }
            c.stroke();

            // ---- 伞面：椭圆，短轴沿速度方向（被气流压扁一点） ----
            const ang = Math.atan2(uy, ux);      // 气流方向
            c.translate(cx, cy);
            c.rotate(ang);
            // 伞面：沿气流方向压扁到 0.72，垂直方向保持 1.0
            c.scale(0.72, 1.0);

            c.beginPath();
            c.arc(0, 0, radius * spinNow, 0, Math.PI * 2);
            // 橙色伞布 + 深浅条纹
            const grad = c.createLinearGradient(-radius, -radius, radius, radius);
            grad.addColorStop(0, '#ffb35c');
            grad.addColorStop(0.5, '#ff8f2e');
            grad.addColorStop(1, '#e07018');
            c.fillStyle = grad;
            c.fill();
            c.strokeStyle = '#a8541a';
            c.lineWidth = Math.max(1, radius * 0.055);
            c.stroke();

            // 几条深色分割线（让伞看起来有褶皱）
            c.strokeStyle = 'rgba(150, 70, 20, 0.55)';
            c.lineWidth = Math.max(0.6, radius * 0.035);
            for (let k = -2; k <= 2; k++) {
                const yy = k * radius * 0.38 * spinNow;
                const half = Math.sqrt(Math.max(0, (radius * spinNow) ** 2 - yy * yy));
                c.beginPath();
                c.moveTo(-half, yy);
                c.lineTo(half, yy);
                c.stroke();
            }

            c.restore();
        }

        function shipRoundRect(c, x, y, w, h, r) {
            r = Math.min(r, w / 2, h / 2);
            c.beginPath();
            c.moveTo(x + r, y);
            c.arcTo(x + w, y, x + w, y + h, r);
            c.arcTo(x + w, y + h, x, y + h, r);
            c.arcTo(x, y + h, x, y, r);
            c.arcTo(x, y, x + w, y, r);
            c.closePath();
        }

        // ==================== 指令舱（Spaceflight Simulator 风格）====================
        // 顶部对接环 → 银白锥形舱体 → 侧面舷窗 → 底部黑色隔热盾。全部矢量绘制。
        function drawCapsule(c, x, y, w, h) {
            const cx = x + w / 2;

            // 1) 顶部对接环
            const ringH = h * 0.13, ringW = w * 0.42;
            shipRoundRect(c, cx - ringW / 2, y, ringW, ringH, ringH * 0.35);
            const ringGrad = c.createLinearGradient(cx - ringW / 2, 0, cx + ringW / 2, 0);
            ringGrad.addColorStop(0, '#7d8894'); ringGrad.addColorStop(0.4, '#c3ccd6'); ringGrad.addColorStop(1, '#69737e');
            c.fillStyle = ringGrad; c.fill();
            c.strokeStyle = '#5a636d'; c.lineWidth = 1; c.stroke();

            // 2) 舱体（上窄下宽的圆角梯形）
            const bodyTop = y + ringH * 0.75, bodyBot = y + h * 0.80;
            const topW = w * 0.60, botW = w * 0.98;
            c.beginPath();
            c.moveTo(cx - topW / 2, bodyTop + 3);
            c.quadraticCurveTo(cx - topW / 2 - 2, bodyTop, cx - topW / 2 + 3, bodyTop);
            c.lineTo(cx + topW / 2 - 3, bodyTop);
            c.quadraticCurveTo(cx + topW / 2 + 2, bodyTop, cx + topW / 2, bodyTop + 3);
            c.lineTo(cx + botW / 2, bodyBot - 3);
            c.quadraticCurveTo(cx + botW / 2, bodyBot, cx + botW / 2 - 3, bodyBot);
            c.lineTo(cx - botW / 2 + 3, bodyBot);
            c.quadraticCurveTo(cx - botW / 2, bodyBot, cx - botW / 2, bodyBot - 3);
            c.closePath();
            const bodyGrad = c.createLinearGradient(cx - botW / 2, 0, cx + botW / 2, 0);
            bodyGrad.addColorStop(0.00, '#9aa5b1'); bodyGrad.addColorStop(0.18, '#e9eef4');
            bodyGrad.addColorStop(0.42, '#fbfdff'); bodyGrad.addColorStop(0.72, '#d5dde6');
            bodyGrad.addColorStop(1.00, '#8e99a5');
            c.fillStyle = bodyGrad; c.fill();
            c.strokeStyle = '#6f7a86'; c.lineWidth = 1.2; c.stroke();

            c.save(); c.clip();
            c.strokeStyle = 'rgba(120, 132, 146, 0.55)'; c.lineWidth = 1;
            for (const f of [0.32, 0.68]) {
                const px = cx - botW / 2 + botW * f;
                c.beginPath(); c.moveTo(px, bodyTop); c.lineTo(px, bodyBot); c.stroke();
            }
            c.fillStyle = 'rgba(255,255,255,0.35)';
            c.fillRect(cx - botW / 2, bodyBot - h * 0.06, botW, h * 0.025);
            c.restore();

            // 3) 舷窗
            const winR = w * 0.115, winY = bodyTop + (bodyBot - bodyTop) * 0.42;
            for (const ox of [-w * 0.16, w * 0.16]) {
                c.beginPath(); c.arc(cx + ox, winY, winR, 0, Math.PI * 2);
                const wg = c.createRadialGradient(cx + ox - winR * 0.3, winY - winR * 0.3, winR * 0.1, cx + ox, winY, winR);
                wg.addColorStop(0, '#7fc4ff'); wg.addColorStop(0.55, '#2f7fc4'); wg.addColorStop(1, '#123a5e');
                c.fillStyle = wg; c.fill();
                c.strokeStyle = '#4a5a6a'; c.lineWidth = 1.4; c.stroke();
                c.beginPath(); c.arc(cx + ox - winR * 0.3, winY - winR * 0.32, winR * 0.28, 0, Math.PI * 2);
                c.fillStyle = 'rgba(255,255,255,0.6)'; c.fill();
            }

            // 4) 底部隔热盾
            c.beginPath();
            c.moveTo(cx - botW / 2, bodyBot - 1);
            c.lineTo(cx + botW / 2, bodyBot - 1);
            c.lineTo(cx + botW * 0.44, y + h);
            c.lineTo(cx - botW * 0.44, y + h);
            c.closePath();
            const shieldGrad = c.createLinearGradient(cx - botW / 2, 0, cx + botW / 2, 0);
            shieldGrad.addColorStop(0.00, '#2a2f36'); shieldGrad.addColorStop(0.30, '#565e68');
            shieldGrad.addColorStop(0.55, '#454c55'); shieldGrad.addColorStop(1.00, '#22262b');
            c.fillStyle = shieldGrad; c.fill();
            c.strokeStyle = '#1a1d21'; c.lineWidth = 1; c.stroke();
            c.save(); c.clip();
            c.strokeStyle = 'rgba(15, 17, 20, 0.8)'; c.lineWidth = 0.9;
            for (const f of [0.25, 0.5, 0.75]) {
                const px = cx - botW * 0.44 + botW * 0.88 * f;
                c.beginPath(); c.moveTo(px, bodyBot); c.lineTo(px, y + h); c.stroke();
            }
            c.restore();
        }

        // 和造船厂里是同一套画法，只是尺寸参数不同
        // 伞包自动吸附：探测四边/四角的相邻部件，返回吸附方向。
        // 伞包画得小（格内 55%），若总是居中会在自己的格子里悬空——
        // 贴向有结构的那一侧/那个角，视觉上才算装在船上。
        function chuteAnchor(def, part) {
            const t = PART_TYPES[part.type];
            const band = (x0, x1, y0, y1) => def.parts.some(q => {
                if (q.id === part.id) return false;
                const qt = PART_TYPES[q.type];
                return x0 < q.x + qt.w && x1 > q.x && y0 < q.y + qt.h && y1 > q.y;
            });
            const W = part.x, E = part.x + t.w, S = part.y, N = part.y + t.h;
            // 注意网格 y 轴向上：S-1..S 是网格下方（屏幕上也是下方），
            // N..N+1 是网格上方。字段名用 below/above（网格语义），避免与屏幕方向混淆。
            return {
                below: band(W - 1, E + 1, S - 1, S),
                above: band(W - 1, E + 1, N, N + 1),
                left:  band(W - 1, W, S - 1, N + 1),
                right: band(E, E + 1, S - 1, N + 1),
            };
        }

        function drawShipPart(c, type, t, x, y, w, h, anchor) {
            if (type === 'capsule') {
                drawCapsule(c, x, y, w, h);

            } else if (type === 'tank') {
                const grad = c.createLinearGradient(x, 0, x + w, 0);
                grad.addColorStop(0, '#cfd9e4'); grad.addColorStop(0.35, t.body); grad.addColorStop(1, '#b9c6d4');
                shipRoundRect(c, x, y, w, h, w * 0.18);
                c.fillStyle = grad; c.fill();
                c.strokeStyle = t.edge; c.lineWidth = 1; c.stroke();
                c.fillStyle = t.accent;
                const bandH = Math.max(2, h * 0.07);
                c.fillRect(x + 2, y + h * 0.32, w - 4, bandH);
                c.fillRect(x + 2, y + h * 0.60, w - 4, bandH);

            } else if (type === 'engine') {
                const bodyH = h * 0.58;
                const grad = c.createLinearGradient(x, 0, x + w, 0);
                grad.addColorStop(0, '#6f7b89'); grad.addColorStop(0.4, t.body); grad.addColorStop(1, '#616c78');
                shipRoundRect(c, x, y, w, bodyH, w * 0.14);
                c.fillStyle = grad; c.fill();
                c.strokeStyle = t.edge; c.lineWidth = 1; c.stroke();
                c.beginPath();
                c.moveTo(x + w * 0.22, y + bodyH);
                c.lineTo(x + w * 0.78, y + bodyH);
                c.lineTo(x + w * 0.92, y + h);
                c.lineTo(x + w * 0.08, y + h);
                c.closePath();
                c.fillStyle = '#4e5863'; c.fill();
                c.strokeStyle = t.edge; c.lineWidth = 1; c.stroke();
                c.beginPath();
                c.moveTo(x + w * 0.32, y + bodyH + 1.5);
                c.lineTo(x + w * 0.68, y + bodyH + 1.5);
                c.lineTo(x + w * 0.78, y + h - 1);
                c.lineTo(x + w * 0.22, y + h - 1);
                c.closePath();
                c.fillStyle = '#2b323a'; c.fill();

            } else if (type === 'chute') {
                // 包好的降落伞：格内 55% 的暗橙伞包 + 捆扎带
                // （自动吸附：贴向相邻结构那一侧/那个角，不悬空）
                const pw = w * 0.55, ph = h * 0.55;
                const sx = (w - pw) / 2, sy = (h - ph) / 2;
                const anc = anchor || {};
                const px = x + sx + (anc.right ? sx : 0) - (anc.left ? sx : 0);
                // 网格下方 = 屏幕下方：有结构就贴下去
                const py = y + sy + (anc.below ? sy : 0) - (anc.above ? sy : 0);
                const grad = c.createLinearGradient(px, 0, px + pw, 0);
                grad.addColorStop(0, '#7a4a16'); grad.addColorStop(0.4, '#b5762a'); grad.addColorStop(1, '#8a5a20');
                shipRoundRect(c, px, py, pw, ph, pw * 0.28);
                c.fillStyle = grad; c.fill();
                c.strokeStyle = '#5a3a10'; c.lineWidth = 1; c.stroke();
                // 十字捆扎带（暗卡其）
                c.strokeStyle = '#c9b48a';
                c.lineWidth = Math.max(1, pw * 0.09);
                c.beginPath();
                c.moveTo(px + pw / 2, py + 1); c.lineTo(px + pw / 2, py + ph - 1);
                c.moveTo(px + 1, py + ph * 0.45); c.lineTo(px + pw - 1, py + ph * 0.45);
                c.stroke();
                // 顶部开伞扣
                c.fillStyle = '#c9b48a';
                c.fillRect(px + pw * 0.35, py - 1, pw * 0.3, Math.max(2, ph * 0.08));

            } else if (type === 'decoupler') {
                // 分离器：深灰扁环 + 黄色警示条纹（按空格切断）
                const grad = c.createLinearGradient(x, 0, x + w, 0);
                grad.addColorStop(0, '#31383f'); grad.addColorStop(0.4, t.body); grad.addColorStop(1, '#3a424a');
                shipRoundRect(c, x, y, w, h, Math.min(3, h * 0.3));
                c.fillStyle = grad; c.fill();
                c.strokeStyle = t.edge; c.lineWidth = 1; c.stroke();
                c.fillStyle = t.accent;
                const bandH = Math.max(1.5, h * 0.18);
                c.fillRect(x + 1, y + h * 0.2, w - 2, bandH);
                c.fillRect(x + 1, y + h * 0.62, w - 2, bandH);
            }
        }

        // ==== 渲染循环 ====
        function gameLoopInner(now) {
            const frameTime = (now - lastTime) / 1000;
            lastTime = now;

            // 横幅/提示计时走真实时间：100x 加速下提示不该一闪而过
            updateAchievementToast(frameTime);
            if (fuelMsgTimer > 0) fuelMsgTimer -= frameTime;

            if (isSpectator()) {
                // 观战端：不跑物理，只把操控端的状态插值渲染出来
                applyRemoteWorld();
                resetInterp();   // 观战端不做物理插值，直接渲染服务器插值结果
                accumulator = 0;
            } else {
                // 时间加速：把这一帧代表的「游戏时间」乘上倍率
                accumulator += Math.min(frameTime, 0.25) * timeScale();
                // 单帧最多跑这么多步，防止高倍率下卡死（超过就丢弃剩余时间）
                const MAX_STEPS_PER_FRAME = 260;
                let steps = 0;
                if (accumulator >= FIXED_DT) {
                    snapInterp();    // prev ← 本帧步进前的状态
                    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
                        physicsStep(FIXED_DT);
                        accumulator -= FIXED_DT;
                        steps++;
                    }
                    snapInterp();    // curr ← 本帧步进后的状态
                }
                if (accumulator > FIXED_DT * MAX_STEPS_PER_FRAME) {
                    accumulator = 0;   // 追不上就丢弃，避免越积越多
                }
                interp.alpha = Math.max(0, Math.min(1, accumulator / FIXED_DT));
            }

            // 和服务器同步：操控端上报，观战端拉取
            if (netMode) { sendState(); fetchState(); }

            // 相机对准质心 —— 原点在船底，直接跟原点的话大船会偏在屏幕下方看不全
            // 相机硬锁「渲染位置」（插值后的船）：锁的是画出来的那艘船。
            // 硬锁原因：任何平滑系数的滞后都与速度成正比（见 4243a2a），
            // 而连续性现在由渲染插值保证 —— 两件事各司其职。
            const rr = rocketRenderPos();
            camera.x = rr.x;
            camera.y = rr.y;

            ctx.fillStyle = '#050510';
            ctx.fillRect(0, 0, canvasW, canvasH);

            // ---- 世界层 1：星球本体 + 大气（只做 fill）----
            // 描边全部移到屏幕空间：world 空间里「px/zoom」的线宽在缩小视野时会
            // 膨胀成几万 px 宽的描边路径（星球描边 2 万 px、预测虚线 2 万 px 还带
            // dash），渲染成本随 1/zoom 爆炸 —— 就是「某些缩放奇卡」的元凶。
            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.scale(camera.zoom, camera.zoom);
            ctx.translate(-camera.x, -camera.y);

            // 星球
            ctx.beginPath();
            ctx.arc(planet.x, planet.y, planet.radius, 0, Math.PI * 2);
            ctx.fillStyle = '#4a90d9';
            ctx.fill();

            // ---- 大气层：由内到外指数衰减的渐变光晕 ----
            // 大气改成指数模型后，视觉上也跟着来：
            // 用多层渐变模拟 exp(-alt/H)，而不是「一整块蓝色到边界截断」。
            // 最外面画到 3 倍标高（密度约 5%），看着就是「渐渐消失」。
            {
                const h = ATMO_SCALE_HEIGHT;             // 标高
                const outer = Math.min(atmoThickness() * 1.6, h * 6);   // 画到多远
                const atmoGrad = ctx.createRadialGradient(
                    planet.x, planet.y, planet.radius,
                    planet.x, planet.y, planet.radius + outer
                );
                // 按 exp 曲线布色标，越往外越透明
                for (let i = 0; i <= 8; i++) {
                    const f = i / 8;
                    const altPx = outer * f;
                    const dens = Math.exp(-altPx / h);
                    const alpha = 0.40 * dens;
                    atmoGrad.addColorStop(f, 'rgba(120, 190, 255, ' + alpha.toFixed(3) + ')');
                }
                ctx.beginPath();
                ctx.arc(planet.x, planet.y, planet.radius + outer, 0, Math.PI * 2);
                ctx.fillStyle = atmoGrad;
                ctx.fill();

            }
            ctx.restore();   // 世界层 1 结束

            // ---- 屏幕层：描边与预测线（线宽恒定屏幕像素，任意缩放成本恒定）----
            const psx = (planet.x - camera.x) * camera.zoom + canvasW / 2;
            const psy = (planet.y - camera.y) * camera.zoom + canvasH / 2;
            const prs = planet.radius * camera.zoom;
            if (prs > 8 && prs < 40000) {          // 星球边缘太小看不清/大到出屏时都不描
                ctx.beginPath();
                ctx.arc(psx, psy, prs, 0, Math.PI * 2);
                ctx.strokeStyle = '#2a5f9a';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            const ars = (planet.radius + atmoThickness()) * camera.zoom;
            if (ars > 8 && ars < 40000) {          // 参考线：大气顶，帮助判断「出大气了没」
                ctx.beginPath();
                ctx.arc(psx, psy, ars, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(120, 190, 255, 0.22)';
                ctx.lineWidth = 1.2;
                ctx.setLineDash([6, 8]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // 轨道预测线（蓝色虚线，像 SFS 里那条线）。
            // 语义是「假设此刻关机滑行」：稳定绕轨走解析椭圆，点火/再入走数值积分。
            const path = predictPath({
                x: rocket.x, y: rocket.y, vx: rocket.vx, vy: rocket.vy,
            }, rocket.state === 'firing' && rocket.throttle > 0 && rocket.fuel > 0, now);
            if (path.length >= 4) {
                // 线按「计算时的逻辑位置」生成，船画在「插值渲染位置」（最多落后
                // 一个物理步）—— 把整条线平移 (渲染船位 - 锚点)，线头才贴着
                // 画出来的船，否则轨道线会甩在船前面来回游。
                const po = predictPathOrigin();
                const oxd = rr.x - po.x, oyd = rr.y - po.y;
                const sx = (wx) => (wx + oxd - camera.x) * camera.zoom + canvasW / 2;
                const sy = (wy) => (wy + oyd - camera.y) * camera.zoom + canvasH / 2;
                ctx.setLineDash([14, 10]);
                ctx.lineWidth = 2;
                ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
                ctx.beginPath();
                ctx.moveTo(sx(path[0]), sy(path[1]));
                for (let i = 2; i < path.length; i += 2) ctx.lineTo(sx(path[i]), sy(path[i + 1]));
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // ---- 世界层 2：残骸 / 碎片 / 飞船 ----
            ctx.save();
            ctx.translate(canvasW / 2, canvasH / 2);
            ctx.scale(camera.zoom, camera.zoom);
            ctx.translate(-camera.x, -camera.y);

            // ---- 失控的航天器（残骸）：画成暗色的部件块 ----
            for (const v of vessels) {
                if (v.id === activeVesselId) continue;
                const rv = vesselRenderPos(v);
                ctx.save();
                ctx.translate(rv.x, rv.y);
                ctx.rotate((rv.angle - 90) * Math.PI / 180);
                ctx.translate(-v.spec.com.x, -v.spec.com.y);
                ctx.globalAlpha = 0.85;
                for (const p of v.def.parts) {
                    if (v.destroyed.has(p.id)) continue;
                    const t = PART_TYPES[p.type];
                    if (!t) continue;
                    const P = PART_PX;
                    const x = p.x * P - v.spec.centerX * P;
                    const y = v.spec.box.maxY * P - (p.y + t.h) * P;
                    drawShipPart(ctx, p.type, t, x, y, t.w * P, t.h * P, chuteAnchor(v.def, p));
                }
                ctx.globalAlpha = 1;
                ctx.restore();
            }

            // 爆炸碎片（画在飞船下面，看起来像从船体飞出来的）
            for (let di = 0; di < debris.length; di++) {
                const d = debris[di];
                const dp = debrisRenderPos(di) || d;
                const alpha = Math.max(0, Math.min(1, d.life / 0.8));
                ctx.globalAlpha = alpha * 0.5;
                ctx.fillStyle = '#ffaa33';
                ctx.beginPath();
                ctx.arc(dp.x, dp.y, d.size * 2.0, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = d.color;
                ctx.beginPath();
                ctx.arc(dp.x, dp.y, d.size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            // 飞船：按你在造船厂拼的部件逐块画出来
            // 旋转中心 = 质心（和物理判定用的是同一个中心，不会出现"转起来错位"）
            ctx.save();
            ctx.translate(rr.x, rr.y);
            ctx.rotate((rr.angle - 90) * Math.PI / 180);
            ctx.translate(-SPEC.com.x, -SPEC.com.y);
            drawShip(ctx, rocket.state === 'firing' && rocket.fuel > 0, performance.now());

            // ---- 再入加热：高速冲进大气时，船体外面裹一层火光 ----
            const heat = rocket.heat || 0;
            if (heat > 0.01) {
                ctx.globalAlpha = Math.min(0.85, heat);
                const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, SPEC.height * 0.9);
                glow.addColorStop(0.0, 'rgba(255, 240, 190, 0.95)');
                glow.addColorStop(0.4, 'rgba(255, 150, 40, 0.60)');
                glow.addColorStop(1.0, 'rgba(255, 80, 0, 0.00)');
                ctx.beginPath();
                ctx.arc(0, 0, SPEC.height * 0.9, 0, Math.PI * 2);
                ctx.fillStyle = glow;
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // ---- 降落伞（画在辉光之后：每把打开的伞各自一顶，锚在自身部件上）----
            for (const cp of aliveChutes()) {
                drawChute(ctx, rocket.vx, rocket.vy, atmosphereDensity(rocket.x, rocket.y), rocket.heat || 0, cp);
            }
            ctx.restore();

            ctx.restore();

            // 星球屏幕外箭头
            const screenX = (planet.x - camera.x) * camera.zoom + canvasW / 2;
            const screenY = (planet.y - camera.y) * camera.zoom + canvasH / 2;
            const margin = 80;
            if (screenX < margin || screenX > canvasW - margin || screenY < margin || screenY > canvasH - margin) {
                const dx = screenX - canvasW / 2;
                const dy = screenY - canvasH / 2;
                const angle = Math.atan2(dy, dx);
                const halfW = canvasW / 2 - margin;
                const halfH = canvasH / 2 - margin;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const scale = Math.min(halfW / Math.abs(cos || 0.0001), halfH / Math.abs(sin || 0.0001));
                const arrowX = canvasW / 2 + cos * scale;
                const arrowY = canvasH / 2 + sin * scale;

                ctx.save();
                ctx.translate(arrowX, arrowY);
                ctx.rotate(angle);
                ctx.beginPath();
                ctx.moveTo(20, 0);
                ctx.lineTo(-10, -12);
                ctx.lineTo(-10, 12);
                ctx.closePath();
                ctx.fillStyle = '#4a90d9';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.restore();

                ctx.fillStyle = '#4a90d9';
                ctx.font = '14px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('星球', arrowX, arrowY + 30);
            }

            // ==== 距离计算 ====
            const dx = rocket.x - planet.x;
            const dy = rocket.y - planet.y;
            const centerDist = Math.sqrt(dx*dx + dy*dy);
            // 离地高度量到船底（碰撞点），停在地上就是 0，不再虚高半个船身
            const surfaceDist = surfaceAltitudePx();

            const speedNum = Math.sqrt(rocket.vx**2 + rocket.vy**2);
            const speed = speedNum.toFixed(1);
            // 圆轨道速度：在这个高度上“一直绕着不掉下来”需要的横向速度
            // v = sqrt(μ / r) = R·sqrt(g0 / r)，全部用**同一个** G0_PX 口径。
            // （以前这里用了 planet.surfaceGravity=19.6，比真实 g0 大 32 倍，
            //   提示玩家加速到 626 px/s —— 那早就飞出引力范围了。）
            const vCirc = planet.radius * Math.sqrt(G0_PX / centerDist);
            const vEsc = vCirc * Math.SQRT2;      // 逃逸速度 = 圆轨道速度 × √2（超了就会飞出引力范围）
            let orbitHint = '';
            // 判定容差按 vCirc 的比例给（15%），这样高低轨道都好用；
            // 固定 15 px/s 在低轨时比 vCirc 本身还大，等于永远显示「差不多是圆轨道」。
            const vTol = Math.max(0.5, vCirc * 0.15);
            if (speedNum > vEsc) orbitHint = '  ⚠️ 超过逃逸速度，要飞走了！';
            else if (Math.abs(speedNum - vCirc) < vTol) orbitHint = '  ← 差不多是圆轨道了！';
            let statusText = rocket.landed ? '已着陆（按 E 起飞）' : '关机';
            if (rocket.state === 'firing') statusText = '点火中';
            if (alivePartCount() === 0) statusText = '已完全损毁（按 R 重开）';

            // 观战端显示角标
            const badge = document.getElementById('spectator-badge');
            if (badge) badge.style.display = isSpectator() ? 'block' : 'none';

            // 节流阀条（左边那根竖条）
            throttleFill.style.height = (rocket.throttle * 100).toFixed(1) + '%';
            throttleText.innerText = '油门 ' + Math.round(rocket.throttle * 100) + '%';

            // 燃料条（右边那根）：快没油的时候变红
            fuelFill.style.height = (totalRatio() * 100).toFixed(1) + '%';
            fuelFill.style.background = totalRatio() < 0.2
                ? 'linear-gradient(#ff7777, #cc2222)'
                : 'linear-gradient(#66ddff, #2288cc)';
            let fuelLine2 = '';
            if (fuelMsgTimer > 0) fuelLine2 = '要先降落到星球上才能加油 / 卸油';
            else if (rocket.landed) fuelLine2 = '+ 补充 / - 卸掉';
            // 质量随燃料变化 —— 让“飞船变轻”看得见
            const massNow = shipMass();
            // 推重比 = 当前推力加速度 ÷ 地面引力加速度。
            // 分子是像素制加速度，分母也必须是像素制引力 —— 两边同一口径。
            // （以前分母用 planet.surfaceGravity=19.6，算是算出了 0.09:1，
            //   显示「推不起来」，可实际物理余量是 88 倍，把人吓一跳。）
            const twrNow = thrustAccel(1) / G0_PX;
            const massInfo = shipInfo();
            const massTip = `质量 ${massNow.toFixed(0)}（空船 ${massInfo.dryMass}）· 推重比 ${twrNow.toFixed(2)}:1`
                + (totalRatio() < 0.999 ? `  已减重 ${(totalCap() - totalFuel()).toFixed(0)}` : '');
            fuelText.innerText =
                `燃料 ${Math.round(totalRatio() * 100)}% · 满油门还能烧 ${Math.round(totalRatio() * FUEL_BURN_SECONDS)} 秒`
                + '\n' + massTip
                + (fuelLine2 ? '\n' + fuelLine2 : '');

            // 当前轨道：近地点 / 远地点（就像 SFS 地图里那两个数）
            // 和 GRAVITY_MU 同源，保证 HUD 与成就判定不会互相打架。
            const MU = GRAVITY_MU;
            const v2 = rocket.vx * rocket.vx + rocket.vy * rocket.vy;
            const energy = v2 / 2 - MU / centerDist;
            let orbitLine;
            if (rocket.landed) {
                orbitLine = '轨道: 停在地面上';
            } else if (energy >= 0) {
                orbitLine = '轨道: 已逃逸，要飞出引力范围了 ⚠️';
            } else {
                const hAng = dx * rocket.vy - dy * rocket.vx;   // 角动量
                const a = -MU / (2 * energy);                   // 轨道半长轴
                const ecc = Math.sqrt(Math.max(0, 1 + 2 * energy * hAng * hAng / (MU * MU)));
                const rp = a * (1 - ecc) - planet.radius;
                const ra = a * (1 + ecc) - planet.radius;
                orbitLine = `近地点: ${fmtDistance(rp)} | 远地点: ${fmtDistance(ra)}` + (rp < 0 ? '  ← 会撞上星球' : '');
            }

            // —— 飞行数据 HUD：经典终端风文本块。布局按信息层级重排：
            // 飞行主数据（速度/高度）→ 状态 → 姿态/进度 → 轨道 → 大气 → 飞船 → 统计/协同，
            // 每行控制在 ~30 字符内，窄屏折行也不丢信息。 ——
            hud.innerText =
                `速度: ${fmtSpeed(speedNum)}　高度: ${fmtDistance(surfaceDist)}\n` +
                `状态: ${statusText}　油门: ${Math.round(rocket.throttle * 100)}%　燃料: ${Math.round(rocket.fuel * 100)}%\n` +
                `角度: ${Math.round(rocket.angle)}°　缩放: ${camera.zoom.toFixed(2)}x　已绕: ${stats.orbits} 圈\n` +
                orbitLine + '\n' +
                `圆轨道: ${fmtSpeed(vCirc)}　逃逸: ${fmtSpeed(vEsc)}${orbitHint}\n` +
                `${atmoStatusText()}${heatLine()}\n` +
                `飞船: ${shipSizeMeters().w.toFixed(2)} × ${shipSizeMeters().h.toFixed(2)} m　质量: ${shipMass(rocket.fuel).toFixed(0)}　${chuteHudLine()}\n` +
                `成就: ${achieved.size} / ${achievements.length}（按 C 查看）　音乐: ${bgmMuted ? '关' : '开'}\n` +
                coopLine();


            // 顶部的部件清单 + 右上角时间倍率 + 左下分级堆栈
            renderPartsBar();
            renderTimeBtn();
            renderStageStack();

            // ==== 本局任务自动存档（每秒一次；观战端不存，免得用别人的画面覆盖自己的局）====
            if (!isSpectator() && now - lastMissionSave > 1000) {
                lastMissionSave = now;
                saveMission();
            }

            // ==== 终端日志（每秒输出一次） ====
            if (now - lastLogTime > LOG_INTERVAL) {
                lastLogTime = now;
                console.log(
                    `[${new Date().toLocaleTimeString()}] ` +
                    `状态=${statusText} | 速度=${speed} | 角度=${Math.round(rocket.angle)}° | ` +
                    `高度=${fmtDistance(surfaceDist)} | 坐标=(${rocket.x.toFixed(1)}, ${rocket.y.toFixed(1)})`
                );
            }

        }

        // 渲染循环不能因为一帧的异常整个停摆：记录错误、继续下一帧。
        // 无头桩测不出真 canvas 的运行时差异，靠 window.__lastGameError 暴露问题。
        function gameLoop(now) {
            try {
                gameLoopInner(now);
            } catch (e) {
                console.error('[gameLoop] 本帧出错:', e);
                window.__lastGameError = e;
            }
            requestAnimationFrame(gameLoop);
        }

        // 观战端在 HUD 上显示自己的角色
        function coopLine() {
            if (!netMode) return '单机模式';
            const role = isSpectator() ? '观战' : '操控';
            let line = `协同: ${role} | 在线 ${onlineCount} 端`;
            if (isSpectator()) line += '（你只能看，服主可把操控权交给你）';
            return line;
        }

        function showCoopInfo() {
            const role = !netMode ? "单机" : (isSpectator() ? "观战" : "操控");
            let msg = `当前模式：${role}\n在线端数：${netMode ? onlineCount : 1}`;
            if (netMode && isSpectator()) msg += "\n\n你现在是观战端，画面跟着操控端走。\n想自己操作？让服主在管理面板里把你设成「操控」。";
            if (netMode && !isSpectator()) msg += "\n\n你现在是操控端，其他端都在看你的操作。";
            if (!netMode) msg += "\n\n（没连上服务器，现在是本地单机模式）";
            if (isAdmin) msg += "\n\n你是服主，管理面板：http://localhost:" + location.port + "/admin";
            alert(msg);
        }

        // 游戏主循环启动 + 和服务器建立协同
        requestAnimationFrame(gameLoop);
        pollControl();

        // 建立统一视图，并把玩家这艘登记进航天器列表。
        // 关键：登记的就是 mainView 本身（字段直接映射到 rocket/shipDef/SPEC），
        // 不再是另一个「快照对象」—— 以前那个快照不会跟着主船更新，是各种不同步的来源。
        bindMainView();
        (function registerMainVessel() {
            const v = mainView;
            v.id = 'v0';
            v._impactCooldown = 0;
            v._impactBudget = {};
            activeVesselId = 'v0';
            vessels.push(v);
            vesselSeq = 1;
        })();
        // 有上一局的任务存档（含损毁、残骸）就接着玩；没有才把船摆到地面上。
        if (!loadMission()) {
            // 把飞船稳稳放在星球表面（按碰撞箱算，船形怎么变都对）
            placeOnSurface();
            // 相机直接对准飞船，别从 (0,0) 慢慢飘过来（那样前几帧像黑屏）
            const camPt = shipPointWorld(SPEC.com.x, SPEC.com.y, rocket.angle);
            camera.x = camPt.x; camera.y = camPt.y;
        }
        resetInterp();   // 开局初始化插值状态（无论是否从任务档恢复）

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
        setInterval(pollControl, CTRL_INTERVAL_MS);

        // 如果服务器上有造船厂存的飞船，就用它（手机造的船电脑也能飞）
        (async function loadShipFromServer() {
            try {
                // 带 cid：让服务器知道这是哪个端，而不是折叠成一个 anon-IP 幽灵端
                const r = await fetch(apiUrl('/api/ship'));
                const d = await r.json();
                if (!d || !d.ship || !Array.isArray(d.ship.parts) || d.ship.parts.length === 0) return;
                let parts = d.ship.parts.filter(p => p && PART_TYPES[p.type]);
                if (parts.length === 0) return;
                const fix = sanitizeShipDef({ version: 1, name: d.ship.name || '无名', parts });
                parts = fix.def.parts;
                if (parts.length === 0) return;
                if (fix.dropped > 0) {
                    toastQueue.push({ title: '船 体 修 整', name: `已移除 ${fix.dropped} 个悬空部件`,
                                      desc: '悬空零件连不上船体，无法作为一个整体飞行' });
                }
                // 这一局若是从任务存档恢复的，而且服务器上的船和它是同一艘，
                // 就**不要**用完好的船去覆盖当前这艘 —— 否则刚恢复的损毁状态又被抹平了。
                if (missionRestored && shipPartsSig(parts) === missionSig) return;
                // —— 多船共存：换船发射不再覆盖旧船 ——
                // 当前船若还活着，整体归档为世界里可接管的船（原位保留）。
                if (alivePartCount() > 0 && !archiveCurrentShip()) return;
                // 换了一艘船（或在造船厂造了新的搭配）—— 旧任务作废
                clearMission();
                // 走唯一入口换船：SPEC / 血量表 / 温度表 / 已毁集合全部按新船重建，
                // 再把新船摆回地面。（以前只换了 shipDef，SPEC 还是旧船的 —— 缝合船。）
                // 发射台被占（旧船停在那）就沿表面挪一个身位
                const padBusy = vessels.some(v => v.id !== activeVesselId && v.landed &&
                    Math.hypot(v.x - planet.x, v.y - (planet.y - planet.radius)) < 500);
                setShipDef({ version: 1, name: d.ship.name || '无名', parts },
                           { offsetDeg: padBusy ? 12 : 0 });
                try { localStorage.setItem('msp2d-ship', JSON.stringify(shipDef)); } catch (e) {}
                toastQueue.push({
                    name: shipDef.name,
                    desc: `控制舱 ${parts.filter(p=>p.type==='capsule').length}　燃料箱 ${parts.filter(p=>p.type==='tank').length}　发动机 ${parts.filter(p=>p.type==='engine').length}　质量 ${SPEC.dryMass + SPEC.fuelCap}`,
                    title: '飞 船 已 装 载'
                });
            } catch (e) { /* 没服务器就用本地的 */ }
        })();

        // 离开页面（刷新 / 跳去观察站）前，赶紧把这一局存一下，
        // 这样进观察站再回来，飞船还是走之前那个样子（不会奇迹复原）。
        window.addEventListener('pagehide', () => { if (!isSpectator()) saveMission(); });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && !isSpectator()) saveMission();
        });

        // ==== 存档/读档 ====
        function saveGame() {
            // 观战端保存的是插值出来的「别人的世界」，覆盖共享存档等于存进去一份假数据
            if (isSpectator()) {
                toastQueue.push({
                    title: '观 战 模 式',
                    name: '观战端不能存档',
                    desc: '只有操控端能覆盖共享存档',
                });
                return;
            }
            unlock('save_game');
            const data = { planet, rocket, camera };
            fetch(apiUrl('/api/save'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
                .then(res => {
                    if (!res.ok) throw new Error('服务器返回 ' + res.status);
                    return res.json();
                })
                .then(() => alert('存档成功！'))
                .catch(err => {
                    console.error('[存档] 失败', err);
                    alert('存档失败：' + err.message + '\n请确认是用 python server.py 启动的（不要直接双击 html）');
                });
        }

        function loadGame() {
            fetch(apiUrl('/api/load'))
                .then(res => {
                    if (!res.ok) throw new Error('服务器返回 ' + res.status);
                    return res.json();
                })
                .then(data => {
                    if (!data || !data.rocket) {
                        alert('没有找到存档！');
                        return;
                    }
                    Object.assign(rocket, data.rocket);
                    lastComFuel = -1;
                    // 星球参数只信代码里的：旧存档里的半径是旧比例（50000 / 20000），
                    // 一旦覆盖会把整个世界缩小几十倍，位置也全乱。所以不读存档的 planet。
                    // 相机只取 x/y/zoom：旧存档的 minZoom/maxZoom 会悄悄改掉当前
                    // 缩放边界（实测旧档 minZoom 0.0008，代码 0.0001，缩野缩水 8 倍）
                    if (data.camera && typeof data.camera === 'object') {
                        if (Number.isFinite(data.camera.x)) camera.x = data.camera.x;
                        if (Number.isFinite(data.camera.y)) camera.y = data.camera.y;
                        if (Number.isFinite(data.camera.zoom)) {
                            camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, data.camera.zoom));
                        }
                    }
                    // 老存档里可能带着旧的引力字段（gravity / surfaceGravity）。
                    // 这些字段已经废弃，而且**必须删掉** —— 留着会覆盖掉新的
                    // 单一数据源，又把单位混用的 bug 带回来。
                    if ('gravity' in planet) delete planet.gravity;
                    if ('surfaceGravity' in planet) delete planet.surfaceGravity;
                    // 兼容老存档：以前有“冷启动 cold”和“传送中 teleporting”，现在都没了
                    if (rocket.state === 'cold') rocket.state = 'firing';
                    if (typeof rocket.landed !== 'boolean') rocket.landed = false;
                    if (typeof rocket.throttle !== 'number') rocket.throttle = 1;
                    rocket.throttle = Math.max(0, Math.min(1, rocket.throttle));
                    if (typeof rocket.fuel !== 'number') rocket.fuel = 1;
                    rocket.fuel = Math.max(0, Math.min(1, rocket.fuel));
                    delete rocket.thrustPower;   // 老存档里的固定推力已经不用了（现在按质量算）
                    if (typeof rocket.teleporting === 'boolean') delete rocket.teleporting;
                    rocket.angle = ((rocket.angle % 360) + 360) % 360;
                    // 旧比例的存档位置可能落在星球内部（数值也异常）—— 直接放回地面
                    const rr = Math.hypot(rocket.x - planet.x, rocket.y - planet.y);
                    if (!isFinite(rr) || rr < planet.radius) {
                        placeOnSurface();
                    }
                    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom));
                    resetInterp();   // 读档是传送：插值状态归位
                    chuteStates = {};   // 读档的船伞全部重新包好
                    setFuelRatio(rocket.fuel);   // 旧档的燃料比作用到各油箱
                    alert('读档成功！');
                })
                .catch(err => {
                    console.error('[读档] 失败', err);
                    alert('读档失败：' + err.message);
                });
        }
    
        // ==================== 模块化桥接 ====================
        // HTML 里的 onclick="..." 走全局作用域，而 ES Module 的顶层函数不是全局的，
        // 所以按钮引用到的函数必须手动挂到 window 上。
        Object.assign(window, {
            saveGame, loadGame, toggleAchievementPanel, toggleBgm, showCoopInfo, toggleTouchPanel,
        });

        // ==================== 测试钩子 ====================
        // 仅供 tools/tests/ 的无头回归脚本使用，浏览器内不会读取这些导出。
        // 模块级 let 变量（shipDef/destroyed/vessels...）会被 setShipDef/splitVessel
        // 重新绑定，所以一律用 getter 取最新值，不能导出快照。
        export const __test = {
            get rocket() { return rocket; },
            get planet() { return planet; },
            get camera() { return camera; },
            get keys() { return keys; },
            get stats() { return stats; },
            get shipDef() { return shipDef; },
            get pristineShip() { return pristineShip; },
            get SPEC() { return SPEC; },
            get partHP() { return partHP; },
            get partTemp() { return partTemp; },
            get destroyed() { return destroyed; },
            get vessels() { return vessels; },
            get mainView() { return mainView; },
            get toastQueue() { return toastQueue; },
            get achieved() { return achieved; },
            get debris() { return debris; },
            get timeScaleIdx() { return timeScaleIdx; },
            set timeScaleIdx(v) { timeScaleIdx = v; },   // 测试直接设档，避免按键推 toast 污染队列
            shipInfo, shipMass, thrustAccel, shipSpec, gravityAt, atmosphereDensity,
            setShipDef, placeOnSurface, applyImpact, splitVessel, checkSeparation,
            toggleEngine, physicsStep, invalidateShipCache, shipPartsSig, fmtDistance, fmtSpeed,
            onKeyDown, blowUpPart, predictPath, rocketRenderPos, resetInterp,
            toggleChute, hasChute, shipTiltDeg, sanitizeShipDef, activateVessel, cycleVessel, vesselHasCapsule,
            archiveCurrentShip, activateNextStage, computeStageActions, stagePending,
            get severed() { return severed; },
            chuteStateOf, aliveChutes, totalFuel, totalCap, totalRatio,
            get chuteStates() { return chuteStates; },
            get chuteDragNow() { return chuteDragNow; },
            resetToasts,   // 测试用：清掉正在显示 + 排队中的全部横幅
        };
