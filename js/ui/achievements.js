// ==================== 成就 + 横幅提示（toast）====================
// 成就的判定散在物理各处，但记录/弹出/面板全部收敛在这一个模块里。
// 注意：toast 计时目前跑在物理步里（updateAchievementToast(dt)），
// 高倍时间加速下横幅会一闪而过 —— 这是 Phase 3 要修的已知问题。

const achievementEl = document.getElementById('achievement');
const achievementTitleEl = document.getElementById('achievement-title');
const achievementNameEl = document.getElementById('achievement-name');
const achievementDescEl = document.getElementById('achievement-desc');
const achievementPanelEl = document.getElementById('achievement-panel');

// ==================== 成就系统 ====================
export const achievements = [
    { id: 'first_flight',  name: '首飞',       desc: '第一次点火离开星球表面' },
    { id: 'soft_landing',  name: '稳如老猫',   desc: '着陆时垂直速度低于 20 px/s' },
    { id: 'hard_landing',  name: '硬着陆',     desc: '以超过 250 px/s 的速度砸在星球上还活着' },
    { id: 'true_hard_landing', name: '真·硬着陆', desc: '着陆时把至少一个部件撞炸了' },
    { id: 'survive_wreck',     name: '残骸归来',   desc: '撞掉一半以上部件，还成功着陆' },
    { id: 'no_scratch',        name: '毫发无伤',   desc: '一次着陆，垂直速度低于 5 px/s' },
    { id: 'burned_up',         name: '火烧眉毛',   desc: '再入时部件被高温烧毁' },
    { id: 'capsule_survives',  name: '返回舱幸存', desc: '其它部件全烧光，控制舱还挺着' },
    { id: 'chute_open',        name: '空中开花',   desc: '第一次展开降落伞' },
    { id: 'first_staging',     name: '分级飞行',   desc: '第一次用分离器抛离下级' },
    { id: 'meteor',            name: '流星',       desc: '以超过 400 px/s 冲进大气层' },
    { id: 'split_vessel',      name: '断成两截',   desc: '飞船在太空中分离成多个航天器' },
    { id: 'derelict_keeper',   name: '太空垃圾场', desc: '同时存在 3 个以上航天器' },
    { id: 'refuel_full',   name: '补给完毕',   desc: '在地面上把燃料加满' },
    { id: 'dump_half',     name: '减负',       desc: '在地面上卸掉一半以上的燃料' },
    { id: 'save_game',     name: '存档习惯',   desc: '用 S 存一次档' },
    { id: 'zoom_min',      name: '极目远眺',   desc: '把视野缩到最小' },
    { id: 'fine_tune',     name: '精细操作',   desc: '用 Shift 微调过油门' },
    { id: 'speed_300',     name: '三百俱乐部', desc: '速度达到 300 px/s' },
    { id: 'speed_600',     name: '六百俱乐部', desc: '速度达到 600 px/s' },
    { id: 'alt_1000',      name: '一千高空',   desc: '离地高度超过 1000 px' },
    { id: 'alt_5000',      name: '越飞越高',   desc: '离地高度超过 5000 px' },
    { id: 'orbit',         name: '入轨',       desc: '绕星球完整转满一圈不掉下来' },
    { id: 'orbit3',        name: '三圈',       desc: '累计绕满三圈' },
    { id: 'orbit5',        name: '环球旅行',   desc: '累计绕满五圈' },
    { id: 'escape',        name: '脱离摇篮',   desc: '达到逃逸速度' },
    { id: 'homing_cat',    name: '迷路的猫',   desc: '飞出引力范围后又自己飞回来着陆' },
    { id: 'out_of_fuel',   name: '弹尽粮绝',   desc: '在空中把燃料烧到 0', instant: true },
    { id: 'low_fuel_land', name: '油表见底',   desc: '燃料不到 5% 还能平安着陆' },
    { id: 'hover_king',    name: '悬停大师',   desc: '把离地高度稳定在 200 px 附近连续 3 秒' },
    { id: 'round_trip',    name: '环游半球',   desc: '着陆点离起飞点超过 3000 px' },
];

export const achieved = new Set();
const pendingSettlement = [];   // 这一趟任务拿到、还没结算的成就
export const toastQueue = [];
let toastCurrent = null;
let toastTimer = 0;
let achievementPanelOpen = false;


// 成就记录存在浏览器里，下次打开还在
try {
    const savedList = JSON.parse(localStorage.getItem('msp2d-achievements') || '[]');
    if (Array.isArray(savedList)) savedList.forEach((id) => achieved.add(id));
} catch (err) { /* 浏览器不给用 localStorage 就当没存过 */ }

export function saveAchievements() {
    try { localStorage.setItem('msp2d-achievements', JSON.stringify([...achieved])); } catch (err) {}
}

// ==================== 成就跟存档走 ====================
// localStorage 只活在这台浏览器里，换台电脑就没了。
// 存档（savegame.json）是跟人走的，所以成就也塞进去一份。
//
// 两条路同时保留：
//   · localStorage —— 不开服务器（直接开 html）时也能记住
//   · 存档文件    —— 换电脑/换浏览器、给朋友看进度都带着
export function exportAchievements() {
    return [...achieved];
}

// 从存档恢复成就。和现有的取并集 ——
// 存档里没有的（比如刚在浏览器里拿到的）不会被抹掉。
export function importAchievements(list) {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    list.forEach((id) => {
        if (typeof id === 'string' && !achieved.has(id)) {
            // 只认确实存在的成就 id，防止脏数据
            if (achievements.some((a) => a.id === id)) {
                achieved.add(id);
                added++;
            }
        }
    });
    if (added > 0) saveAchievements();
    return added;
}

export function unlock(id) {
    if (achieved.has(id) || pendingSettlement.some((a) => a.id === id)) return;
    const a = achievements.find((x) => x.id === id);
    if (!a) return;
    // 弹尽粮绝当场就弹（不然万一回不来，永远等不到结算）
    if (a.instant) {
        achieved.add(id);
        saveAchievements();
        toastQueue.push(a);
        return;
    }
    pendingSettlement.push(a);   // 其它都攒着，等着陆结算
}

// 着陆结算：这一趟任务里拿到的成就一次性揭晓
export function settleMission() {
    if (pendingSettlement.length === 0) return;
    pendingSettlement.forEach((a) => {
        if (achieved.has(a.id)) return;
        achieved.add(a.id);
        toastQueue.push({ name: a.name, desc: a.desc, title: '任 务 结 算' });
    });
    pendingSettlement.length = 0;
    saveAchievements();
}

// 一次达成好几个的时候排队一个一个弹
export function updateAchievementToast(dt) {
    if (toastTimer > 0) {
        toastTimer -= dt;
        if (toastTimer <= 0) {
            achievementEl.style.opacity = '0';
            achievementEl.style.transform = 'translateX(-50%) translateY(-24px)';
            toastCurrent = null;
        }
        return;
    }
    if (toastCurrent === null && toastQueue.length > 0) {
        toastCurrent = toastQueue.shift();
        achievementTitleEl.innerText = toastCurrent.title || '成 就 达 成';
        achievementNameEl.innerText = toastCurrent.name;
        achievementDescEl.innerText = toastCurrent.desc;
        achievementEl.style.opacity = '1';
        achievementEl.style.transform = 'translateX(-50%) translateY(0)';
        toastTimer = 3;
    }
}

// 测试钩子：清掉正在显示 + 排队中的全部横幅（tools/tests 无头回归用）
export function resetToasts() {
    toastQueue.length = 0;
    toastCurrent = null;
    toastTimer = 0;
    achievementEl.style.opacity = '0';
}

export function toggleAchievementPanel() {
    achievementPanelOpen = !achievementPanelOpen;
    if (achievementPanelOpen) {
        const rows = achievements.map((a) => {
            const got = achieved.has(a.id);
            return '<div class="ach-row ' + (got ? 'got' : 'locked') + '">'
                + '<span class="ach-mark">' + (got ? '●' : '○') + '</span>'
                + '<span class="ach-name">' + a.name + '</span>'
                + '<span class="ach-desc">' + a.desc + '</span></div>';
        }).join('');
        achievementPanelEl.innerHTML =
            '<div class="ach-head">成就　' + achieved.size + ' / ' + achievements.length + '　（按 C 关闭）</div>' + rows;
    }
    achievementPanelEl.style.display = achievementPanelOpen ? 'block' : 'none';
}

