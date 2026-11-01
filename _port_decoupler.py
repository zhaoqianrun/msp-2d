# -*- coding: utf-8 -*-
# 一次性移植脚本：分离器（main.js 部分 + 其余文件），跑完即删
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8', newline=None).read()
    for old, new in pairs:
        assert s.count(old) == 1, path + ' marker x%d: %s' % (s.count(old), old[:60])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('patched', path)

# ============ js/main.js ============
main_pairs = []

# 1) severed 集合声明
main_pairs.append((
"""        let destroyed = new Set();    // 已经炸掉的部件 id""",
"""        let destroyed = new Set();    // 已经炸掉的部件 id
        let severed = new Set();      // 已被分离器切断的部件 id：还活着还画着，
                                      // 但不再把两侧粘在一起（与 destroyed 分开算）"""
))

# 2) allDead 助手 + 调用点
main_pairs.append((
"""        // 炸完之后检查：船是不是断成几截了
        function checkSeparation() {
            if (findConnectedGroups(shipDef.parts, destroyed).length > 1) {""",
"""        // 炸毁 ∪ 切断：两者都不再把部件粘在一起（分离器切断用）
        function allDead() { return new Set([...destroyed, ...severed]); }

        // 炸完之后检查：船是不是断成几截了
        function checkSeparation() {
            if (findConnectedGroups(shipDef.parts, allDead()).length > 1) {"""
))
main_pairs.append((
"""        function splitVessel() {
            const groups = findConnectedGroups(shipDef.parts, destroyed);""",
"""        function splitVessel(axial) {
            const groups = findConnectedGroups(shipDef.parts, allDead());"""
))

# 3) 轴向分离冲量
main_pairs.append((
"""            // 分离本身给两边一点推开的力
            const push = 30;
            rocket.vx += (Math.random() - 0.5) * push;
            rocket.vy += (Math.random() - 0.5) * push;
            for (const v of born) {
                v.vx -= (Math.random() - 0.5) * push;
                v.vy -= (Math.random() - 0.5) * push;
            }""",
"""            // 分离本身给两边一点推开的力
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
            }"""
))

# 4) activateDecoupler + detachSeveredParts
main_pairs.append((
"""            toastQueue.push({
                title: '没 有 其 他 船',
                name: '没有可接管的航天器',
                desc: '只有带控制舱的船可以接管（炸断船体可获得多截）',
            });
        }""",
"""            toastQueue.push({
                title: '没 有 其 他 船',
                name: '没有可接管的航天器',
                desc: '只有带控制舱的船可以接管（炸断船体可获得多截）',
            });
        }

        // ==================== 分离器（分级火箭）====================
        // 空格：切断最下面一根「切得断船体」的分离器——下级沿船轴抛离，
        // 上面级继续飞。切断 ≠ 炸毁：分离器本体还活着，只是不再把两侧
        // 粘在一起（severed 集合），并跟随被抛离的那一级走。
        function activateDecoupler() {
            const candidates = shipDef.parts
                .filter(p => p.type === 'decoupler' && !destroyed.has(p.id) && !severed.has(p.id))
                .sort((a, b) => a.y - b.y);          // 分级惯例：先抛最下面一级
            if (candidates.length === 0) {
                toastQueue.push({ title: '没 有 分 离 器', name: '造船厂里装一个吧', desc: '部件列表 > 分离器' });
                return;
            }
            // 找出真能把船体切成两截的那根（侧挂的切不断 → 整根自己飘走）
            let chosen = null;
            for (const d of candidates) {
                severed.add(d.id);
                if (findConnectedGroups(shipDef.parts, allDead()).length > 1) { chosen = d; break; }
                severed.delete(d.id);
            }
            if (!chosen) {
                severed.add(candidates[0].id);
                detachSeveredParts();
                toastQueue.push({ title: '分 离 器 脱 离', name: '它不在连接位置上', desc: '整根自己飘走了' });
                unlock('first_staging');
                return;
            }
            const before = vessels.length;
            splitVessel(true);
            if (vessels.length > before) {
                unlock('first_staging');
                toastQueue.push({
                    title: '级 间 分 离',
                    name: '下级已抛离',
                    desc: '上面级继续飞行，按 V 可切换目标',
                });
            } else {
                severed.delete(chosen.id);   // 兜底：没分成就不算切断
            }
        }

        // 侧挂 / 末端的分离器切不断船体：整个脱离成一艘单件小船
        function detachSeveredParts() {
            const loose = shipDef.parts.filter(p => severed.has(p.id));
            if (loose.length === 0) return;
            shipDef.parts = shipDef.parts.filter(p => !severed.has(p.id));
            SPEC = shipSpec(shipDef);
            const v = makeVessel(loose, rocket.x, rocket.y, rocket.vx, rocket.vy, rocket.angle, rocket.fuel);
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
        }"""
))

# 5) severed 重置点：切船（setShipDef）/ 重开（respawn）
main_pairs.append((
"""            shipDef = def;
            pristineShip = JSON.parse(JSON.stringify(def));   // 重置（R）时回到这艘
            SPEC = shipSpec(shipDef);
            destroyed = new Set();""",
"""            shipDef = def;
            pristineShip = JSON.parse(JSON.stringify(def));   // 重置（R）时回到这艘
            SPEC = shipSpec(shipDef);
            destroyed = new Set();
            severed.clear();   // 新船没有已切断的分离器"""
))
main_pairs.append((
"""            // 修好所有部件
            destroyed.clear();""",
"""            // 修好所有部件
            destroyed.clear();
            severed.clear();"""
))

# 6) 空格键
main_pairs.append((
"""            if (e.code === 'KeyV') cycleVessel();""",
"""            if (e.code === 'KeyV') cycleVessel();
            if (e.code === 'Space') {
                e.preventDefault();   // 防止空格滚动页面
                activateDecoupler();
                return;
            }"""
))

# 7) 触控按钮映射
main_pairs.append((
"""            ['t-fuel', 'Equal'], ['t-dump', 'Minus'], ['t-chute', 'KeyP'], ['t-vessel', 'KeyV'],""",
"""            ['t-fuel', 'Equal'], ['t-dump', 'Minus'], ['t-chute', 'KeyP'], ['t-vessel', 'KeyV'],
            ['t-sep', 'Space'],"""
))

# 8) drawShipPart：分离器画法
main_pairs.append((
"""                // 顶部开伞扣
                c.fillStyle = t.accent;
                c.fillRect(x + w * 0.35, y - 1, w * 0.3, Math.max(2, h * 0.08));
            }
        }""",
"""                // 顶部开伞扣
                c.fillStyle = t.accent;
                c.fillRect(x + w * 0.35, y - 1, w * 0.3, Math.max(2, h * 0.08));

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
        }"""
))

# 9) __test 导出
main_pairs.append((
"""            toggleChute, hasChute, shipTiltDeg, sanitizeShipDef, activateVessel, cycleVessel, vesselHasCapsule,
            archiveCurrentShip,""",
"""            toggleChute, hasChute, shipTiltDeg, sanitizeShipDef, activateVessel, cycleVessel, vesselHasCapsule,
            archiveCurrentShip, activateDecoupler,
            get severed() { return severed; },"""
))

patch('js/main.js', main_pairs)

# ============ js/ui/achievements.js ============
patch('js/ui/achievements.js', [(
"""    { id: 'chute_open',        name: '空中开花',   desc: '第一次展开降落伞' },""",
"""    { id: 'chute_open',        name: '空中开花',   desc: '第一次展开降落伞' },
    { id: 'first_staging',     name: '分级飞行',   desc: '第一次用分离器抛离下级' },"""
)])

# ============ build.html ============
patch('build.html', [
(
"""    chute: {
        // 降落伞：减速发生在游戏内（按大气密度实时算），这里只负责放置。
        name: '降落伞', w: 2, h: 2, mass: 8, fuel: 0, thrust: 0,
        body: '#ff9a3c', edge: '#c46a1a', accent: '#ffe0a0',
        info: '减速伞：游戏中按 P 展开 / 切断',
    },""",
"""    chute: {
        // 降落伞：减速发生在游戏内（按大气密度实时算），这里只负责放置。
        name: '降落伞', w: 2, h: 2, mass: 8, fuel: 0, thrust: 0,
        body: '#ff9a3c', edge: '#c46a1a', accent: '#ffe0a0',
        info: '减速伞：游戏中按 P 展开 / 切断',
    },
    decoupler: {
        // 分离器：游戏中按空格切断，下级沿船轴抛离（分级火箭）。
        name: '分离器', w: 2, h: 1, mass: 4, fuel: 0, thrust: 0,
        body: '#5a6570', edge: '#3a424a', accent: '#ffd23c',
        info: '分级分离：游戏中按 空格 切断',
    },"""
),
(
"""        // 顶部开伞扣
        ctx.fillStyle = t.accent;
        ctx.fillRect(r.x + r.w * 0.35, r.y - 1, r.w * 0.3, Math.max(2, r.h * 0.08));
    }""",
"""        // 顶部开伞扣
        ctx.fillStyle = t.accent;
        ctx.fillRect(r.x + r.w * 0.35, r.y - 1, r.w * 0.3, Math.max(2, r.h * 0.08));

    } else if (p.type === 'decoupler') {
        // 分离器：深灰扁环 + 黄色警示条纹
        const grad = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
        grad.addColorStop(0, '#31383f'); grad.addColorStop(0.4, t.body); grad.addColorStop(1, '#3a424a');
        roundRect(ctx, r.x, r.y, r.w, r.h, 3);
        ctx.fillStyle = grad; ctx.fill();
        ctx.strokeStyle = t.edge; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = t.accent;
        const bandH = Math.max(2, r.h * 0.18);
        ctx.fillRect(r.x + 2, r.y + r.h * 0.2, r.w - 4, bandH);
        ctx.fillRect(r.x + 2, r.y + r.h * 0.62, r.w - 4, bandH);
    }"""
),
])

# ============ station.html ============
patch('station.html', [(
"""    chute:   { name: '降落伞', w: 2, h: 2, mass: 8, fuel: 0, thrust: 0 },""",
"""    chute:   { name: '降落伞', w: 2, h: 2, mass: 8, fuel: 0, thrust: 0 },
    decoupler: { name: '分离器', w: 2, h: 1, mass: 4, fuel: 0, thrust: 0 },"""
)])

# ============ play-main.html：操作提示 ============
patch('play-main.html', [(
"""+ 加油 / - 卸油(要着陆)　S 存档""",
"""+ 加油 / - 卸油(要着陆)　空格 分离　S 存档"""
)])
