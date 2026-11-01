// ==================== 部件定义 ====================
// 注意：build.html / station.html 里还有同款副本，Phase 3 会收敛成三方共用。
// 推力 1000 配合物理尺度 1px=1m、默认船质量 115、重力 3.71 m/s²，
// 推重比 1000/115/3.71 ≈ 2.35 : 1。
// ==================== 部件（和 build.html 的定义必须一致）====================
export const PART_TYPES = {
    capsule: { name: '控制舱', w: 2, h: 2, mass: 30, fuel: 0, thrust: 0,
               body: '#d8e4f2', edge: '#8fa8c4', accent: '#4a90d9' },
    tank:    { name: '燃料箱', w: 2, h: 3, mass: 20, fuel: 40, thrust: 0,
               body: '#e8eef6', edge: '#9db2c9', accent: '#ff8800' },
    // 推力 1000（配合物理尺度 1px=1m、质量 115、重力 3.71 m/s²）
    // 推重比 1000/115/3.71 = 2.35 : 1
    //
    // 比例从 1px=50m 改成 1px=1m 后，引力像素加速度大了 50 倍，
    // 所以推力也要×50（20 → 1000）才能保持同样的推重比和飞行时间。
    // 注意：推力必须和 build.html / station.html / index.html 保持一致。
    // 降落伞：只在大气层里有减速作用。游戏中按 P 展开，再按 P 切断。
    // 切断的伞不能再展开，必须降落到地面才能重新包好。
    chute:   { name: '降落伞', w: 2, h: 2, mass: 8, fuel: 0, thrust: 0,
               body: '#ff9a3c', edge: '#c46a1a', accent: '#ffe0a0' },
    // 分离器：夹在两级之间的扁环。游戏中按空格切断——下级沿船轴抛离，
    // 上面级继续飞（分级火箭）。切断 ≠ 炸毁：本体还活着，跟着被抛的那级走。
    decoupler: { name: '分离器', w: 2, h: 2, mass: 4, fuel: 0, thrust: 0,
                 body: '#5a6570', edge: '#3a424a', accent: '#ffd23c' },
    engine:  { name: '发动机', w: 2, h: 2, mass: 25, fuel: 0, thrust: 1000,
               body: '#8d99a8', edge: '#5c6874', accent: '#ff5544' },
};
export const PART_PX = 7;           // 游戏里一格画多少像素（调小 = 飞船看着更小；建造页是 20）

