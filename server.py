import http.server
import json
import os
import socket
import subprocess
import threading
import time

PORT = 8080

# 服务端口令：谁在服务器那台电脑上运行 server.py，谁就是服主。
# 打开 http://localhost:8080/admin 就能管理所有连接端。
ADMIN_TOKEN = "msp2d-admin"

# 以“本文件所在目录”为基准：双击运行、或在别的目录里运行，都能找到网页和存档
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAVE_PATH = os.path.join(BASE_DIR, "savegame.json")
SHIP_PATH = os.path.join(BASE_DIR, "ship.json")   # 造船厂造的飞船

# ==================== 多端协同（服主分配操控 / 观战）====================
# 核心思路：操控端算物理，每 100ms 把飞船状态报上来；
# 服务器只负责保存、转发给观战端。物理只有一份，两边手感永远一致。
STATE_FILE = os.path.join(BASE_DIR, "shared-state.json")
CLIENTS_FILE = os.path.join(BASE_DIR, "clients.json")

CLIENT_TIMEOUT = 15        # 超过这么久没心跳，就算这个端掉线了
CONTROL_TIMEOUT = 8        # 操控端超过这么久没上报，就认为操控断了

STATE_LOCK = threading.Lock()

# 所有连接端：{client_id: {...}}
clients = {}
# 共享世界状态（由操控端上报）
world_state = {"rev": 0, "t": 0, "data": None}


def _load_clients():
    """重启服务器后，角色设置还在（方便固定某台设备当操控端）"""
    try:
        with open(CLIENTS_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        for cid, info in saved.items():
            clients[cid] = {
                "id": cid,
                "role": info.get("role", "spectate"),
                "note": info.get("note", ""),
                "last_seen": 0,
                "online": False,
                "ip": "",
            }
    except (OSError, json.JSONDecodeError, AttributeError):
        pass


def _save_clients():
    """只把角色和备注存盘，在线状态不存"""
    try:
        snapshot = {cid: {"role": c["role"], "note": c.get("note", "")}
                    for cid, c in clients.items()}
        tmp = CLIENTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CLIENTS_FILE)
    except OSError:
        pass


_load_clients()


def _now():
    return time.time()


def _touch(client_id, ip, observe=False):
    """记下这个端还活着；需要时自动接管操控权。
    observe=True 表示这是观察站（只看不玩），不参与操控权争夺。"""
    with STATE_LOCK:
        c = clients.get(client_id)
        if c is None:
            # 新设备：默认先给观战，下面再决定要不要接管操控
            c = {"id": client_id, "role": "spectate", "note": "", "last_seen": 0,
                 "online": True, "ip": ip, "observe": observe}
            clients[client_id] = c
        c["observe"] = observe

        c["last_seen"] = _now()
        c["online"] = True
        c["ip"] = ip

        # 没有任何人在操控（第一次开服 / 操控端掉了 / 服主把操控端撤了）
        # → 这个端自动接管，保证总有人能玩（但观察站不接管）
        if not observe and not any(x["role"] == "control" and _is_online(x) for x in clients.values()):
            if c["role"] != "control":
                c["role"] = "control"
                print(f"[协同] {client_id} 自动接管操控权（当前没有操控端）")
            _save_clients()
        return c


def _is_online(c):
    """真正在线：标记为在线，而且最近有心跳"""
    return bool(c.get("online")) and c.get("last_seen", 0) > 0


def _sweep_offline():
    """把超时没心跳的端标成离线（last_seen=0 的端从没心跳过，不算在内）"""
    cut = _now() - CLIENT_TIMEOUT
    with STATE_LOCK:
        for c in clients.values():
            if c["online"] and c["last_seen"] > 0 and c["last_seen"] < cut:
                c["online"] = False


def _control_client():
    """当前在线的操控端（只能有一个）"""
    for c in clients.values():
        if c["role"] == "control" and _is_online(c):
            return c
    return None


# ==================== 端口清理 ====================
def listening_pids(port):
    """找出正在“监听”指定端口的进程 PID（Windows）"""
    pids = set()
    try:
        result = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, errors="ignore",
        )
        for line in result.stdout.splitlines():
            # 典型输出： TCP    0.0.0.0:8080    0.0.0.0:0    LISTENING    1234
            parts = line.split()
            if len(parts) < 5 or parts[0].upper() != "TCP":
                continue
            local_addr, state, pid = parts[1], parts[3].upper(), parts[4]
            if state != "LISTENING" or not pid.isdigit():
                continue
            # 只认端口号完全相同的，避免把 :80800 这种也误伤
            if local_addr.rsplit(":", 1)[-1] != str(port):
                continue
            pids.add(pid)
    except Exception as e:
        print(f"[SERVER] 查找端口占用时出错（不影响启动）: {e}")
    return pids


def kill_port(port):
    """杀掉占用指定端口的进程（只动真正在监听这个端口的进程）"""
    pids = listening_pids(port)
    if not pids:
        print(f"[SERVER] 端口 {port} 空闲，可以直接启动")
        return

    for pid in sorted(pids):
        print(f"[SERVER] 正在杀掉占用端口 {port} 的进程 PID={pid}")
        try:
            subprocess.run(["taskkill", "/PID", pid, "/F"],
                           capture_output=True, text=True, errors="ignore")
        except Exception as e:
            print(f"[SERVER] 结束进程 {pid} 失败: {e}")

    time.sleep(0.5)
    rest = listening_pids(port)
    if rest:
        print(f"[SERVER] 端口 {port} 仍被占用: {', '.join(sorted(rest))}")
    else:
        print(f"[SERVER] 端口 {port} 清理完成")


def get_local_ip():
    """获取本机局域网 IP，方便手机访问"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ==================== HTTP 处理器 ====================
class GameHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # 明确指定网页目录，不受“从哪个目录启动”影响
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):
        """自定义日志格式，带时间戳；只记录 API 请求和错误，避免刷屏"""
        timestamp = time.strftime("%H:%M:%S")
        status = args[1] if len(args) > 1 else "?"
        if "/api/" in self.path or status != "200":
            print(f"[{timestamp}] {self.client_address[0]} | {fmt % args}")

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 网页文件也一律不许缓存：改完代码，刷新一下就能看到新版，
        # 不用按 Ctrl+F5 去清缓存（以前静态文件没设 Cache-Control，
        # 浏览器会拿旧页面，改了等于没改）。
        try:
            buf = b"".join(self._headers_buffer or [])
            if b"Cache-Control" not in buf:
                self.send_header("Cache-Control", "no-store, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
        except Exception:
            pass
        super().end_headers()

    # ==================== 协同接口 ====================
    def _client_id(self):
        """每个浏览器标签一个 id（存 localStorage，刷新也不变）"""
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        cid = (q.get("cid") or [""])[0].strip()
        if not cid or len(cid) > 64:
            cid = "anon-" + self.client_address[0]
        return cid

    def _is_observer(self):
        """观察站这类"只看不玩"的端：不抢操控权，也不给操控权"""
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        return (q.get("observe") or [""])[0] == "1" 

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _is_admin(self):
        """服主：在服务器那台电脑上打开，或者带上正确口令"""
        host = self.client_address[0]
        if host in ("127.0.0.1", "::1", "localhost"):
            return True
        return self.headers.get("X-MSP-Admin") == ADMIN_TOKEN

    def handle_ctrl(self):
        """这个端是什么角色？"""
        _sweep_offline()
        cid = self._client_id()
        me = _touch(cid, self.client_address[0], self._is_observer())
        ctrl = _control_client()
        with STATE_LOCK:
            payload = {
                "id": cid,
                "role": me["role"],                     # control / spectate
                "is_admin": self._is_admin(),
                "controller": ctrl["id"] if ctrl else None,
                "controller_online": ctrl is not None,
                "online_count": sum(1 for c in clients.values() if _is_online(c)),
                "rev": world_state["rev"],
            }
        self.send_json(payload)

    def handle_state_get(self):
        """观战端拉取世界状态"""
        _sweep_offline()
        _touch(self._client_id(), self.client_address[0], self._is_observer())
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query)
        try:
            since = int((q.get("since") or ["0"])[0])
        except ValueError:
            since = 0

        with STATE_LOCK:
            rev = world_state["rev"]
            data = world_state["data"]
        # 版本没变就不传数据，省流量
        if data is None or rev == since:
            self.send_json({"rev": rev, "changed": False})
            return
        self.send_json({"rev": rev, "changed": True, "world": data})

    def handle_state_post(self):
        """操控端上报世界状态"""
        _sweep_offline()
        cid = self._client_id()
        me = _touch(cid, self.client_address[0], self._is_observer())
        if me["role"] != "control":
            self.send_json({"ok": False, "error": "not-controller", "role": me["role"]}, status=403)
            return
        body = self._read_body()
        if not isinstance(body, dict):
            self.send_json({"ok": False, "error": "bad-json"}, status=400)
            return
        with STATE_LOCK:
            world_state["rev"] += 1
            world_state["t"] = _now()
            world_state["data"] = body
            world_state["from"] = cid
        self.send_json({"ok": True, "rev": world_state["rev"]})

    def handle_clients(self):
        """列出所有连接端（管理面板用）"""
        _sweep_offline()
        if not self._is_admin():
            self.send_json({"ok": False, "error": "forbidden"}, status=403)
            return
        now = _now()
        with STATE_LOCK:
            rows = []
            for c in clients.values():
                rows.append({
                    "id": c["id"],
                    "ip": c["ip"],
                    "role": c["role"],
                    "note": c.get("note", ""),
                    "online": _is_online(c),
                    "idle_sec": round(now - c["last_seen"], 1) if c["last_seen"] else None,
                })
            rows.sort(key=lambda r: (not r["online"], r["id"]))
            ctrl = _control_client()
            payload = {
                "ok": True,
                "clients": rows,
                "online_count": sum(1 for c in clients.values() if _is_online(c)),
                "controller": ctrl["id"] if ctrl else None,
                "rev": world_state["rev"],
            }
        self.send_json(payload)

    def handle_role_set(self):
        """服主给某个端分配角色：control / spectate"""
        _sweep_offline()
        if not self._is_admin():
            self.send_json({"ok": False, "error": "forbidden"}, status=403)
            return
        body = self._read_body()
        if not isinstance(body, dict):
            self.send_json({"ok": False, "error": "bad-json"}, status=400)
            return
        target = str(body.get("id") or "").strip()
        role = str(body.get("role") or "").strip()
        if role not in ("control", "spectate"):
            self.send_json({"ok": False, "error": "bad-role"}, status=400)
            return
        with STATE_LOCK:
            if target not in clients:
                self.send_json({"ok": False, "error": "no-such-client"}, status=404)
                return
            if role == "control":
                # 操控端同时只能有一个：先把别人降成观战
                for c in clients.values():
                    if c["role"] == "control" and c["id"] != target:
                        c["role"] = "spectate"
                        print(f"[协同] {c['id']} 已改为观战（操控权交给别人）")
            clients[target]["role"] = role
            _save_clients()
        print(f"[协同] 服主把 {target} 设为 {'操控' if role == 'control' else '观战'}")
        self.send_json({"ok": True, "id": target, "role": role})

    def handle_kick(self):
        """服主把某个端踢下线"""
        _sweep_offline()
        if not self._is_admin():
            self.send_json({"ok": False, "error": "forbidden"}, status=403)
            return
        body = self._read_body()
        target = str((body or {}).get("id") or "").strip()
        with STATE_LOCK:
            if target not in clients:
                self.send_json({"ok": False, "error": "no-such-client"}, status=404)
                return
            clients[target]["online"] = False
            clients[target]["last_seen"] = 0
            clients[target]["role"] = "spectate"
            _save_clients()
        print(f"[协同] 服主把 {target} 踢下线了")
        self.send_json({"ok": True, "id": target})

    def handle_admin_page(self):
        """管理面板（只有服主能打开）"""
        if not self._is_admin():
            self.send_json({"ok": False, "error": "只有服务器那台电脑能打开管理面板"}, status=403)
            return
        body = ADMIN_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
    # ---------- 飞船（造船厂产物）----------
    def handle_ship_get(self):
        """play-main.html 读飞船；没有就返回空，前端会用默认船"""
        _touch(self._client_id(), self.client_address[0], self._is_observer())
        if not os.path.exists(SHIP_PATH):
            self.send_json({"ok": True, "ship": None})
            return
        try:
            with open(SHIP_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"[飞船] 读取失败: {e}")
            self.send_json({"ok": True, "ship": None})
            return
        self.send_json({"ok": True, "ship": data})

    def handle_ship_post(self):
        """build.html 保存飞船"""
        _touch(self._client_id(), self.client_address[0], self._is_observer())
        body = self._read_body()
        if not isinstance(body, dict) or not isinstance(body.get("parts"), list):
            self.send_json({"ok": False, "error": "bad-ship"}, status=400)
            return
        tmp = SHIP_PATH + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
            os.replace(tmp, SHIP_PATH)
        except OSError as e:
            print(f"[飞船] 保存失败: {e}")
            self.send_json({"ok": False, "error": "write-failed"}, status=500)
            return
        n = len(body["parts"])
        print(f"[{time.strftime('%H:%M:%S')}] [飞船] 已保存 {body.get('name', '无名')}（{n} 个部件）")
        self.send_json({"ok": True, "parts": n})

    # ---------- 读档 ----------
    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/load":
            self.handle_load()
            return
        if route == "/api/ship":
            self.handle_ship_get()
            return
        if route == "/api/ctrl":
            self.handle_ctrl()
            return
        if route == "/api/state":
            self.handle_state_get()
            return
        if route == "/api/clients":
            self.handle_clients()
            return
        if route == "/admin":
            self.handle_admin_page()
            return
        super().do_GET()

    def handle_load(self):
        _touch(self._client_id(), self.client_address[0], self._is_observer())
        stamp = time.strftime("%H:%M:%S")
        if not os.path.exists(SAVE_PATH):
            print(f"[{stamp}] [读档] 没有存档，返回空对象")
            self.send_json({})
            return
        try:
            with open(SAVE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            # 存档坏了就当没有存档，不要让网页那边报一堆看不懂的错
            print(f"[{stamp}] [读档] 存档损坏，已忽略: {e}")
            self.send_json({})
            return
        print(f"[{stamp}] [读档] 已发送存档 ({os.path.getsize(SAVE_PATH)} 字节)")
        self.send_json(data)

    # ---------- 存档 ----------
    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/api/save":
            self.handle_save()
            return
        if route == "/api/ship":
            self.handle_ship_post()
            return
        if route == "/api/state":
            self.handle_state_post()
            return
        if route == "/api/role":
            self.handle_role_set()
            return
        if route == "/api/kick":
            self.handle_kick()
            return
        super().do_POST()

    def handle_save(self):
        _touch(self._client_id(), self.client_address[0], self._is_observer())
        stamp = time.strftime("%H:%M:%S")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""

        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            print(f"[{stamp}] [存档] 收到无效数据，已拒绝: {e}")
            self.send_json({"ok": False, "error": "invalid json"}, status=400)
            return

        # 先写临时文件再改名替换：写到一半崩溃也不会把好存档弄坏
        tmp_path = SAVE_PATH + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp_path, SAVE_PATH)
        except OSError as e:
            print(f"[{stamp}] [存档] 写入失败: {e}")
            self.send_json({"ok": False, "error": "write failed"}, status=500)
            return

        print(f"[{stamp}] [存档] 已保存 ({os.path.getsize(SAVE_PATH)} 字节)")
        self.send_json({"ok": True, "bytes": os.path.getsize(SAVE_PATH)})


class GameServer(http.server.ThreadingHTTPServer):
    """多线程 + 端口可立即重用：一个卡住的浏览器连接不会把服务器堵死"""
    allow_reuse_address = True
    daemon_threads = True


# ==================== 管理面板（服主专用）====================
ADMIN_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MSP-2D 服主控制台</title>
<style>
  body { margin:0; background:#0b1220; color:#dce8f7; font-family:"Segoe UI",monospace,sans-serif; padding:24px; }
  h1 { color:#4a90d9; letter-spacing:3px; font-size:22px; margin:0 0 4px; }
  .sub { color:#6b86a6; font-size:13px; margin-bottom:20px; }
  .bar { display:flex; gap:12px; align-items:center; margin-bottom:16px; flex-wrap:wrap; }
  .pill { background:#16233a; border:1px solid #2c4468; border-radius:20px; padding:6px 14px; font-size:13px; }
  table { width:100%; border-collapse:collapse; background:#101a2c; border-radius:8px; overflow:hidden; }
  th, td { padding:11px 14px; text-align:left; font-size:13px; border-bottom:1px solid #1c2a42; }
  th { background:#16233a; color:#8fb4dc; font-weight:normal; letter-spacing:1px; }
  tr:last-child td { border-bottom:none; }
  .on { color:#5fd68a; } .off { color:#5a6b80; }
  .ctrl { color:#ffc35c; font-weight:bold; }
  button { background:#1d3050; border:1px solid #3a5a80; color:#cfe2f7; border-radius:6px;
           padding:6px 12px; cursor:pointer; font-size:12px; margin-right:6px; font-family:inherit; }
  button:hover { background:#2a4a72; }
  button.primary { border-color:#d08a2a; color:#ffd48a; }
  button.danger { border-color:#8a3a3a; color:#ff9a9a; }
  button:disabled { opacity:.35; cursor:not-allowed; }
  .me { color:#4a90d9; }
  #msg { margin-top:14px; font-size:13px; color:#7fe0a8; min-height:20px; }
  .hint { margin-top:22px; color:#5a6b80; font-size:12px; line-height:1.7; }
</style>
</head>
<body>
  <h1>MSP-2D 服主控制台</h1>
  <div class="sub">你是服主。可以决定每个连接端是「操控」还是「观战」。</div>
  <div class="bar">
    <span class="pill">在线：<b id="online">-</b></span>
    <span class="pill">当前操控端：<b id="ctrl" class="ctrl">-</b></span>
    <span class="pill">状态版本：<b id="rev">-</b></span>
  </div>
  <table>
    <thead><tr><th>设备</th><th>IP</th><th>状态</th><th>空闲</th><th>角色</th><th>操作</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6">加载中...</td></tr></tbody>
  </table>
  <div id="msg"></div>
  <div class="hint">
    游戏地址：<b>http://本机IP:8080/play-main.html</b>（手机连同一个 WiFi 就能进）<br>
    操控端同一时间只能有一个 —— 你把某一端设成操控，原来的操控端会自动变成观战。<br>
    角色设置会保存，重启服务器后依然有效。这个页面刷新即可看到最新的连接情况。
  </div>
<script>
let admin = "";
try { admin = localStorage.getItem("msp2d-admin-token") || ""; } catch (e) {}
if (!admin) { admin = prompt("服主口令：") || ""; try { localStorage.setItem("msp2d-admin-token", admin); } catch (e) {} }

function say(t, ok) {
  const el = document.getElementById("msg");
  el.style.color = ok ? "#7fe0a8" : "#ff9a9a";
  el.innerText = t;
  setTimeout(() => { if (el.innerText === t) el.innerText = ""; }, 3000);
}

async function api(path, body) {
  const opt = { headers: { "X-MSP-Admin": admin } };
  if (body) { opt.method = "POST"; opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  return await r.json();
}

async function refresh() {
  try {
    const d = await api("/api/clients");
    if (!d.ok) { document.getElementById("rows").innerHTML = '<tr><td colspan="6">无权限：' + (d.error || "") + '</td></tr>'; return; }
    document.getElementById("online").innerText = d.online_count;
    document.getElementById("ctrl").innerText = d.controller || "（无）";
    document.getElementById("rev").innerText = d.rev;
    document.getElementById("rows").innerHTML = d.clients.map(c => {
      const isCtrl = (c.id === d.controller);
      return '<tr>' +
        '<td class="' + (c.online ? 'me' : 'off') + '">' + (c.note || c.id.slice(0, 10)) + '</td>' +
        '<td>' + (c.ip || "-") + '</td>' +
        '<td class="' + (c.online ? 'on' : 'off') + '">' + (c.online ? "在线" : "离线") + '</td>' +
        '<td>' + (c.idle_sec === null ? "-" : c.idle_sec + "s") + '</td>' +
        '<td class="' + (isCtrl ? 'ctrl' : '') + '">' + (isCtrl ? "操控" : "观战") + '</td>' +
        '<td>' +
          '<button class="primary" ' + (isCtrl ? "disabled" : "") + ' onclick="setRole(\'' + c.id + '\',\'control\')">设为操控</button>' +
          '<button ' + (!isCtrl ? "disabled" : "") + ' onclick="setRole(\'' + c.id + '\',\'spectate\')">设为观战</button>' +
          '<button class="danger" onclick="kick(\'' + c.id + '\')">踢出</button>' +
        '</td></tr>';
    }).join("");
  } catch (e) { say("连接失败：" + e.message, false); }
}

async function setRole(id, role) {
  const d = await api("/api/role", { id, role });
  say(d.ok ? "已设置" : ("失败：" + (d.error || "")), d.ok);
  refresh();
}

async function kick(id) {
  if (!confirm("确定把这一端踢下线吗？")) return;
  const d = await api("/api/kick", { id });
  say(d.ok ? "已踢出" : ("失败：" + (d.error || "")), d.ok);
  refresh();
}

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>
"""

# ==================== 启动 ====================
if __name__ == "__main__":
    print("=" * 50)
    print("  MSP-2D 服务器启动中...")
    print("=" * 50)

    # 先清理端口
    kill_port(PORT)

    # 再启动
    try:
        with GameServer(("", PORT), GameHandler) as httpd:
            ip = get_local_ip()
            print("[SERVER] 服务器已启动！")
            print(f"[SERVER] 网页目录: {BASE_DIR}")
            print(f"[SERVER] 存档文件: {SAVE_PATH}")
            print(f"[SERVER] 本机访问: http://localhost:{PORT}")
            print(f"[SERVER] 局域网访问: http://{ip}:{PORT}")
            print("[SERVER] 按 Ctrl+C 停止服务")
            print("=" * 50)
            httpd.serve_forever()
    except OSError as e:
        print(f"[SERVER] 启动失败: {e}")
        print(f"[SERVER] 提示: 端口 {PORT} 可能仍被占用，请手动检查")
