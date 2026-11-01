// ==================== ESC 暂停菜单 ====================
// 一面板一文件：本模块只管菜单的 DOM 与开合。
// 「暂停」是物理侧的事，paused 状态住在 main.js —— 这里每次关闭都通过
// actions.onResume 通知它解除。存档/读档等动作由 main.js 经 initPauseMenu
// 注入，避免 UI 模块反向依赖组合根。

const scrimEl = document.getElementById('pause-menu');
const listEl = document.getElementById('pause-list');

// 菜单项：key 对应 initPauseMenu 注入的动作名；kbd 是右侧快捷键提示。
// 除 resume 外的项执行时都会先关菜单再调动作（成就面板要盖上来、
// alert 要弹在最前），见 runItem。
const ITEMS = [
    { key: 'resume',       label: '继续游戏',   kbd: 'ESC' },
    { key: 'save',         label: '存档',       kbd: 'S' },
    { key: 'load',         label: '读档',       kbd: 'L' },
    { key: 'restart',      label: '重新起飞',   kbd: 'R' },
    { key: 'achievements', label: '成就',       kbd: 'C' },
    { key: 'music',        label: '音乐',       kbd: 'M' },
    { key: 'coop',         label: '协同信息' },
    { key: 'touch',        label: '触控面板',   kbd: 'T' },
    { key: 'quit',         label: '返回主菜单', danger: true },
];

let isOpen = false;
let actions = null;

function render() {
    listEl.innerHTML = ITEMS.map((item) =>
        '<button class="pm-btn' + (item.danger ? ' danger' : '') + '" data-item="' + item.key + '">'
        + '<span>' + item.label + '</span>'
        + (item.kbd ? '<kbd>' + item.kbd + '</kbd>' : '')
        + '</button>'
    ).join('');
}

// 所有关闭路径（ESC 之外）都汇到这里：关 DOM + 通知 main.js 解除暂停
function closeAndResume() {
    setPauseMenuOpen(false);
    if (actions && actions.onResume) actions.onResume();
}

export function initPauseMenu(a) {
    actions = a;
    render();
    // 点遮罩空白处 = 继续（点卡片本身不会命中遮罩）
    scrimEl.addEventListener('click', (e) => {
        if (isOpen && e.target === scrimEl) closeAndResume();
    });
    // 按钮是 innerHTML 生成的，点击统一走列表容器上的事件委托
    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.pm-btn');
        if (!btn || !isOpen) return;
        const item = ITEMS.find((it) => it.key === btn.dataset.item);
        if (!item) return;
        closeAndResume();
        if (item.key !== 'resume' && actions[item.key]) actions[item.key]();
    });
}

export function isPauseMenuOpen() { return isOpen; }

// 返回开合后的状态，main.js 用它同步 paused
export function setPauseMenuOpen(open) {
    if (open !== isOpen) {
        isOpen = open;
        scrimEl.hidden = !open;
    }
    return isOpen;
}
