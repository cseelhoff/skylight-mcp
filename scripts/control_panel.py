"""Tk control panel for running skylight-mcp over ngrok.

Shows the public MCP URL (secret included), edits the Skylight login in .env,
tests credentials, and restarts the server. Needs `npm run build` first, plus
`node` and `ngrok` on PATH (with an ngrok authtoken configured).

    python scripts/control_panel.py
"""
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.request
from pathlib import Path
from tkinter import ttk

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
BUNDLE = ROOT / "dist" / "bundle.js"
LOG_FILE = ROOT / "server.log"
PORT = "3000"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def read_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"`":
                    value = value[1:-1]
                env[key.strip()] = value
    return env


def quote(value):
    # Quoted so '#', spaces and '=' in a password survive dotenv parsing.
    q = next((c for c in "'\"`" if c not in value), "'")
    return f"{q}{value}{q}"


def write_env(updates):
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    pending = dict(updates)
    for i, line in enumerate(lines):
        key = line.partition("=")[0].strip()
        if key in pending:
            lines[i] = f"{key}={quote(pending.pop(key))}"
    lines += [f"{k}={quote(v)}" for k, v in pending.items()]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def ngrok_url():
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as r:
            tunnels = json.load(r)["tunnels"]
        return next((t["public_url"] for t in tunnels if t["public_url"].startswith("https")), None)
    except OSError:
        return None


def healthcheck(email, password):
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "control-panel", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "skylight_healthcheck", "arguments": {}}},
    ]
    env = {**os.environ, "SKYLIGHT_EMAIL": email, "SKYLIGHT_PASSWORD": password,
           "SKYLIGHT_REFRESH_TOKEN": "", "SKYLIGHT_TOKEN_CACHE": "false"}
    out = subprocess.run(["node", str(BUNDLE)], input="\n".join(map(json.dumps, messages)) + "\n",
                         capture_output=True, text=True, env=env, cwd=ROOT, timeout=90,
                         creationflags=NO_WINDOW).stdout
    for line in out.splitlines():
        msg = json.loads(line)
        if msg.get("id") == 2:
            result = json.loads(msg["result"]["content"][0]["text"])
            return result["ok"], result.get("error", {}).get("message", "")
    return False, "no response from server"


class App:
    def __init__(self, root):
        self.root = root
        self.server = self.ngrok = None
        env = read_env()
        self.secret = env.get("MCP_HTTP_SECRET") or secrets.token_hex(32)
        if "MCP_HTTP_SECRET" not in env:
            write_env({"MCP_HTTP_SECRET": self.secret})

        root.title("Skylight MCP")
        frame = ttk.Frame(root, padding=12)
        frame.grid(sticky="nsew")
        root.columnconfigure(0, weight=1)
        frame.columnconfigure(1, weight=1)

        self.url = tk.StringVar(value="starting…")
        self.email = tk.StringVar(value=env.get("SKYLIGHT_EMAIL", ""))
        self.password = tk.StringVar(value=env.get("SKYLIGHT_PASSWORD", ""))
        self.status = tk.StringVar()

        ttk.Label(frame, text="MCP URL").grid(row=0, column=0, sticky="w")
        ttk.Entry(frame, textvariable=self.url, state="readonly", width=100).grid(row=0, column=1, sticky="ew")
        ttk.Button(frame, text="Copy", command=self.copy).grid(row=0, column=2, padx=(6, 0))
        ttk.Label(frame, text="Skylight email").grid(row=1, column=0, sticky="w", pady=(8, 0))
        ttk.Entry(frame, textvariable=self.email).grid(row=1, column=1, columnspan=2, sticky="ew", pady=(8, 0))
        ttk.Label(frame, text="Skylight password").grid(row=2, column=0, sticky="w", pady=(8, 0))
        ttk.Entry(frame, textvariable=self.password, show="*").grid(row=2, column=1, columnspan=2, sticky="ew", pady=(8, 0))

        buttons = ttk.Frame(frame)
        buttons.grid(row=3, column=0, columnspan=3, pady=(12, 0), sticky="w")
        ttk.Button(buttons, text="Test", command=self.test).pack(side="left")
        ttk.Button(buttons, text="Save", command=self.save).pack(side="left", padx=6)
        ttk.Button(buttons, text="Restart server", command=self.restart).pack(side="left")
        ttk.Label(frame, textvariable=self.status).grid(row=4, column=0, columnspan=3, sticky="w", pady=(8, 0))

        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.restart()
        threading.Thread(target=self.start_ngrok, daemon=True).start()

    def set_status(self, text):
        self.root.after(0, self.status.set, text)

    def copy(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.url.get())
        self.status.set("URL copied")

    def save(self):
        write_env({"SKYLIGHT_EMAIL": self.email.get().strip(), "SKYLIGHT_PASSWORD": self.password.get()})
        self.status.set("Saved to .env. Restart the server to use the new login.")

    def test(self):
        self.status.set("Testing…")
        email, password = self.email.get().strip(), self.password.get()

        def run():
            try:
                ok, error = healthcheck(email, password)
                self.set_status("Success: Skylight accepted the login." if ok else f"Failed: {error}")
            except Exception as e:
                self.set_status(f"Failed: {e}")
        threading.Thread(target=run, daemon=True).start()

    def restart(self):
        if not BUNDLE.exists():
            self.status.set("dist/bundle.js not found. Run `npm run build` first.")
            return
        if self.server:
            self.server.terminate()
            self.server.wait()
        env = {**os.environ, **read_env(), "MCP_HTTP_PORT": PORT}
        log = open(LOG_FILE, "a", encoding="utf-8")
        self.server = subprocess.Popen(["node", str(BUNDLE), "--http"], env=env, cwd=ROOT,
                                       stdout=log, stderr=log, creationflags=NO_WINDOW)
        self.status.set(f"Server started (log: {LOG_FILE.name})")

    def start_ngrok(self):
        # Reuse a tunnel that is already running so the public URL stays the same.
        if not ngrok_url():
            try:
                self.ngrok = subprocess.Popen(["ngrok", "http", PORT], stdout=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
            except FileNotFoundError:
                self.root.after(0, self.url.set, "ngrok not found on PATH")
                return
        for _ in range(30):
            url = ngrok_url()
            if url:
                self.root.after(0, self.url.set, f"{url}/mcp/{self.secret}")
                return
            time.sleep(1)
        self.root.after(0, self.url.set, "ngrok did not start. Is its authtoken configured?")

    def quit(self):
        for proc in (self.server, self.ngrok):
            if proc:
                proc.terminate()
        self.root.destroy()


if __name__ == "__main__":
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    root = tk.Tk()
    App(root)
    root.mainloop()
