// ==================== 显示格式化（纯函数）====================
import { M_PER_PX, DIST_M_PER_PX } from './constants.js';

// 像素 → 距离文字。距离换算与缩放无关（缩放只影响看起来多大）。
export function fmtDistance(px) {
    const m = px * DIST_M_PER_PX;
    if (Math.abs(m) >= 1000) return (m / 1000).toFixed(m >= 100000 ? 0 : 2) + ' km';
    if (Math.abs(m) >= 1) return m.toFixed(m >= 100 ? 0 : 1) + ' m';
    return (m * 100).toFixed(0) + ' cm';
}
// 像素/秒 → 速度文字
export function fmtSpeed(pxPerSec) {
    const ms = pxPerSec * M_PER_PX;
    if (Math.abs(ms) >= 1000) return (ms / 1000).toFixed(2) + ' km/s';
    return ms.toFixed(ms >= 100 ? 0 : 1) + ' m/s';
}
