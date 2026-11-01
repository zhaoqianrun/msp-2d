# -*- coding: utf-8 -*-
# 一次性脚本：分级面板（游戏内堆栈 + 造船厂可调），跑完即删
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8', newline=None).read()
    for old, new in pairs:
        assert s.count(old) == 1, path + ' marker x%d: %s' % (s.count(old), old[:60])
        s = s.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    print('patched', path)

# ============ play-main.html ============
patch('play-main.html', [

# 1) CSS：分级堆栈面板
(
"""        /* 飞行数据 HUD：经典终端风文本块（js/main.js 写 innerText，按信息
           层级分行；宽度自适应、超长自动折行不丢字） */
        #hud {""",
"""        /* 分级堆栈面板（KSP 式，自底向上；:empty 自动隐藏） */
        #stage-stack {
            position: absolute; left: 14px; bottom: 385px;
            display: flex; flex-direction: column; gap: 4px;
            font-family: var(--mono); font-size: 11px;
            pointer-events: none;
        }
        #stage-stack:empty { display: none; }
        #stage-stack .stg {
            background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
            padding: 3px 9px; color: var(--dim);
            display: flex; align-items: center; gap: 8px;
        }
        #stage-stack .stg .stg-n {
            font-weight: 600; color: var(--text); min-width: 14px; text-align: center;
        }
        #stage-stack .stg.next {
            border-color: var(--amber); color: var(--amber);
        }
        #stage-stack .stg.done { opacity: .38; text-decoration: line-through; }

        /* 飞行数据 HUD：经典终端风文本块（js/main.js 写 innerText，按信息
           层级分行；宽度自适应、超长自动折行不丢字） */
        #hud {"""
),

# 2) HTML：堆栈容器
(
"""    <div id="throttle-text">油门 100%</div>""",
"""    <div id="throttle-text">油门 100%</div>
    <div id="stage-stack"></div>"""
),

# 3) 小屏媒体查询：短屏隐藏堆栈
(
"""            #hud { font-size: 11px; line-height: 1.5; width: calc(100vw - 20px); }""",
"""            #hud { font-size: 11px; line-height: 1.5; width: calc(100vw - 20px); }
            #stage-stack { display: none; }"""
)])

# ============ js/main.js ============
main_pairs = [

# 1) 元素引用
(
"""        const partsBarEl = document.getElementById('parts-bar');""",
"""        const partsBarEl = document.getElementById('parts-bar');
        const stageStackEl = document.getElementById('stage-stack');"""
),

# 2) renderStageStack（插在 renderTimeBtn 的监听绑定之后）
(
"""        if (timeDownEl) timeDownEl.addEventListener('click', () => cycleTimeScale(-1));
        if (timeUpEl) timeUpEl.addEventListener('click', () => cycleTimeScale(1));""",
"""        if (timeDownEl) timeDownEl.addEventListener('click', () => cycleTimeScale(-1));
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
        }"""
)

# 3) 渲染循环调用
(
"""            // 顶部的部件清单 + 右上角时间倍率
            renderPartsBar();
            renderTimeBtn();""",
"""            // 顶部的部件清单 + 右上角时间倍率 + 左下分级堆栈
            renderPartsBar();
            renderTimeBtn();
            renderStageStack();"""
)]

patch('js/main.js', main_pairs)

# ============ build.html：造船厂分级面板（可调） ============
patch('build.html', [

# 1) HTML：#corner 里加分级面板
(
"""    <div id="stats"></div>
</div>""",
"""    <div id="stats"></div>
    <div id="staging">
        <h3>分 级</h3>
        <div id="stage-list"></div>
    </div>
</div>"""
),

# 2) CSS
(
"""    #stats .ok { color: #7fe0a8; }""",
"""    #stats .ok { color: #7fe0a8; }
    #staging {
        background: rgba(10, 18, 32, 0.94); border: 1px solid #24395a;
        border-radius: 10px; padding: 10px 14px; font-size: 12px;
    }
    #staging h3 { color: #6b86a6; font-size: 11px; font-weight: normal; letter-spacing: 2px; margin: 0 0 6px; }
    #staging .stg-row {
        display: flex; align-items: center; gap: 6px;
        padding: 3px 0; border-bottom: 1px solid #16233a;
    }
    #staging .stg-row:last-child { border-bottom: none; }
    #staging .stg-n { color: #ffc35c; font-family: monospace; min-width: 34px; }
    #staging .stg-item { color: #cfe2f7; display: inline-flex; align-items: center; gap: 4px; }
    #staging .stg-btn {
        background: #16233a; color: #8fb4dc; border: 1px solid #35506e;
        border-radius: 4px; cursor: pointer; font-size: 10px; padding: 1px 5px;
        font-family: inherit;
    }
    #staging .stg-btn:hover { background: #2a6db5; color: #fff; }
    #staging .stg-empty { color: #5a6b80; }"""
),

# 3) JS：分级计算 + 移动 + 渲染（挂在 updateStats 末尾）
(
"""    statsEl.innerHTML = rows.map(([k, val]) => '<div><span class="k">' + k + '</span><span class="v">' + val + '</span></div>').join('')
        + '<div style="margin-top:6px" class="' + (v.ok ? 'ok' : 'warn') + '">' + (v.ok ? '可以发射' : v.msg) + '</div>';
}""",
"""    statsEl.innerHTML = rows.map(([k, val]) => '<div><span class="k">' + k + '</span><span class="v">' + val + '</span></div>').join('')
        + '<div style="margin-top:6px" class="' + (v.ok ? 'ok' : 'warn') + '">' + (v.ok ? '可以发射' : v.msg) + '</div>';
    rebuildStaging();
}

// ==================== 分级面板（可调）====================
// 自动规则：分离器按 y 降序（自底向上先抛）= 第 0..n 级；
// 降落伞默认「所在段 +1」级（段抛离后下一回合开伞）。
// 每个动作部件可用 ◀ ▶ 在相邻分级间移动，stage 字段随船保存。
function stageIdxOf(p) {
    if (typeof p.stage === 'number') return p.stage;
    const decs = ship.parts.filter(q => q.type === 'decoupler').sort((a, b) => b.y - a.y);
    if (p.type === 'decoupler') return decs.indexOf(p);
    return Math.min(decs.filter(d => d.y < p.y).length, decs.length);
}
function shiftStage(id, dir) {
    const p = ship.parts.find(q => q.id === id);
    if (!p) return;
    const decs = ship.parts.filter(q => q.type === 'decoupler').sort((a, b) => b.y - a.y);
    p.stage = Math.max(0, Math.min(decs.length, stageIdxOf(p) + dir));
    saveShip();
    updateStats();
    draw();
}
function shiftStageBtn(btn) { shiftStage(btn.dataset.id, Number(btn.dataset.dir)); }
function rebuildStaging() {
    const el = document.getElementById('stage-list');
    if (!el) return;
    const acts = [];
    for (const p of ship.parts) {
        if (p.type === 'decoupler') acts.push({ stage: stageIdxOf(p), kind: '分离', id: p.id });
        else if (p.type === 'chute') acts.push({ stage: stageIdxOf(p), kind: '开伞', id: p.id });
    }
    if (acts.length === 0) {
        el.innerHTML = '<div class="stg-empty">装分离器 / 降落伞后自动生成分级</div>';
        return;
    }
    const stages = [];
    for (const a of acts) (stages[a.stage] = stages[a.stage] || []).push(a);
    let html = '';
    for (let i = stages.length - 1; i >= 0; i--) {
        const items = stages[i] || [];
        html += '<div class="stg-row"><span class="stg-n">级 ' + (i + 1) + '</span>';
        for (const a of items) {
            html += '<span class="stg-item">' + a.kind
                + '<button class="stg-btn" data-id="' + a.id + '" data-dir="-1" onclick="shiftStageBtn(this)">◀</button>'
                + '<button class="stg-btn" data-id="' + a.id + '" data-dir="1" onclick="shiftStageBtn(this)">▶</button></span>';
        }
        html += '</div>';
    }
    el.innerHTML = html;
}"""
)])
