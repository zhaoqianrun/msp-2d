// ==================== 无头浏览器桩 ====================
// js/main.js 是给浏览器写的；这里用最少的桩把它在 Node 里跑起来，
// 这样回归测试测的就是真实的物理/损毁/换船代码，而不是一份复制品。
// 零依赖：不引入 jsdom，全部手写最小桩。
//
// 用法：
//   import { installBrowserStubs } from './headless.mjs';
//   const env = installBrowserStubs();
//   const t = (await import('../../js/main.js')).__test;
//   env.pumpFrames(60);   // 泵 60 帧 ≈ 1 秒游戏时间

const noop = () => {};
const gradientStub = { addColorStop() {} };

function makeCtxStub() {
    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
                return () => gradientStub;
            }
            if (!(prop in target)) target[prop] = noop;
            return target[prop];
        },
        set(target, prop, value) { target[prop] = value; return true; },
    });
}

function makeElement(id) {
    return {
        id, style: {}, innerText: '', className: '',
        classList: { add: noop, remove: noop, contains: () => false },
        addEventListener: noop, removeEventListener: noop,
        appendChild: noop, focus: noop,
        width: 0, height: 0,
        getContext: () => ctxShared,
    };
}

const ctxShared = makeCtxStub();

export function installBrowserStubs() {
    const elements = new Map();
    const store = new Map();          // localStorage 内容，测试可以直接断言
    let rafCallback = null;
    let fakeNow = (typeof performance !== 'undefined' ? performance.now() : 0);

    // 游戏主循环每秒打一条遥测日志，测试输出里是噪音：把以 "[HH:MM:SS]" 开头的行滤掉
    const origLog = console.log.bind(console);
    console.log = (...args) => {
        if (typeof args[0] === 'string' && /^\[\d{2}:\d{2}:\d{2}\]/.test(args[0])) return;
        origLog(...args);
    };

    const documentStub = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        addEventListener: noop,
        removeEventListener: noop,
        hidden: false,
    };

    const win = {
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 1,
        addEventListener: noop,
        removeEventListener: noop,
    };

    globalThis.window = win;
    globalThis.document = documentStub;
    globalThis.location = { search: '', port: '' };   // main.js 顶层会读 location.search
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    globalThis.Audio = class Audio {
        constructor() { this.volume = 1; this.loop = false; }
        play() { return Promise.resolve(); }
        pause() {}
    };
    // 一律断网：协同相关代码走 catch 分支，等于稳定可复现的单机模式
    globalThis.fetch = async () => { throw new TypeError('headless: offline'); };
    globalThis.alert = noop;
    globalThis.confirm = () => false;
    globalThis.setInterval = () => 0;   // 不跑真实定时器，测试手动泵帧
    globalThis.requestAnimationFrame = (cb) => { rafCallback = cb; return 1; };

    return {
        elements,
        store,
        win,
        // 泵 n 帧，每帧 dtMs 毫秒（默认 60fps）
        pumpFrames(n = 1, dtMs = 1000 / 60) {
            for (let i = 0; i < n; i++) {
                const cb = rafCallback;
                rafCallback = null;
                if (!cb) throw new Error('没有待执行的动画帧回调（主循环断了吗？）');
                fakeNow += dtMs;
                cb(fakeNow);
            }
        },
    };
}
