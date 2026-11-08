// ==================== 自动更新检查 ====================
// 游戏启动时去官网拉 version.json，和本地 GAME_VERSION 比。
// 有新版本就弹窗问一句：更新 / 不更新。
//
// 更新流程（玩家什么都不用做）：
//   1. 下载 msp2d.zip
//   2. 交给本地 server.py 的 /api/update 接口
//   3. 服务端解压 + 覆盖文件，但**绝不碰**存档和玩家自己造的东西
//   4. 提示「更新完成，刷新页面」
//
// 关键：整个流程在 server.py 里做，浏览器只负责发指令。
// 因为浏览器没有权限写本地磁盘，必须借服务端的力。

const UPDATE_FEED = 'https://zhaoqianrun.github.io/msp-2d/version.json';

// 当前版本。发版时改这里（和 docs/version.json 保持一致）
export const GAME_VERSION = '1.0.0';

/**
 * 比较两个版本号，返回 1 / 0 / -1
 * 支持 "1.2.3" 这种三段式，缺的段按 0 算
 */
export function compareVersion(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length, 3);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

/**
 * 去官网查最新版本。
 * 任何失败都当成「没有更新」，绝不打断游戏启动。
 * 返回 { ok, latest, notes, zip, error }
 */
export async function checkForUpdate(timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(UPDATE_FEED + '?t=' + Date.now(), {
            signal: ctrl.signal,
            cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const info = await res.json();
        if (!info || typeof info.version !== 'string') throw new Error('version.json 格式不对');
        return {
            ok: true,
            latest: info.version,
            notes: info.notes || '',
            zip: info.zip || '',
            released: info.released || '',
            hasUpdate: compareVersion(info.version, GAME_VERSION) > 0,
        };
    } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 让服务端执行真正的更新（下载 + 解压 + 覆盖）。
 * 浏览器自己做不了 —— 需要服务端有写文件的权限。
 */
export async function applyUpdate(zipUrl) {
    const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: zipUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || ('服务端返回 ' + res.status));
    }
    return data;
}

/**
 * 查一下服务端支不支持自动更新。
 * 单机直接开 html 的时候没有服务端，这时候只能给下载链接。
 */
export async function serverSupportsUpdate() {
    try {
        const res = await fetch('/api/update', { method: 'OPTIONS' });
        return res.ok;
    } catch (err) {
        return false;
    }
}
