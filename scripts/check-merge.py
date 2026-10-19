"""
osszeolvasztas-ellenorzo.

nem helyettesiti a tsc-t, hanem pont azt nezi, ami MERGE-nel szokott eltorni,
es amit a tipusellenorzo a hianyzo npm csomagok miatt ugysem latna:

  1. minden relativ import letezo fajlra mutat-e
  2. minden IPC csatorna, amit a preload hiv, letezik-e a shared.ts-ben
  3. minden IPC csatornahoz, amit a preload hiv, van-e handler a main.ts-ben
  4. maradt-e hivatkozas a kivezetett regi API-kra
  5. a bridge.d.ts es a preload.ts fedik-e egymast
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []
warnings = []


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def walk(exts=(".ts", ".tsx")):
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", "dist-electron", ".git")]
        for name in files:
            if name.endswith(exts):
                yield os.path.relpath(os.path.join(base, name), ROOT)


# ---------------------------------------------------------------- 1. importok
print("1. relativ importok feloldasa")
import_re = re.compile(r"""(?:from|import)\s+['"](\.[^'"]+)['"]""")
for rel in walk():
    src = read(rel)
    base = os.path.dirname(os.path.join(ROOT, rel))
    for target in import_re.findall(src):
        resolved = os.path.normpath(os.path.join(base, target))
        candidates = [
            resolved + ".ts",
            resolved + ".tsx",
            resolved + ".d.ts",
            os.path.join(resolved, "index.ts"),
            os.path.join(resolved, "index.tsx"),
            resolved,
        ]
        if not any(os.path.isfile(c) for c in candidates):
            errors.append(f"[import] {rel}: nem talalhato '{target}'")

# ------------------------------------------------------------------- 2-3. IPC
print("2-3. IPC csatornak: shared.ts <-> preload.ts <-> main.ts")
shared = read("electron/shared.ts")
preload = read("electron/preload.ts")
main = read("electron/main.ts")

declared = set(re.findall(r"^\s+([A-Z][A-Z0-9_]*):\s*'", shared, re.M))
used_in_preload = set(re.findall(r"IPC\.([A-Z][A-Z0-9_]*)", preload))
handled_in_main = set(re.findall(r"(?:ipcMain\.handle|\bhandle)\(\s*IPC\.([A-Z][A-Z0-9_]*)", main))
sent_from_main = set(re.findall(r"send\(IPC\.([A-Z][A-Z0-9_]*)", main))

for name in sorted(used_in_preload - declared):
    errors.append(f"[ipc] a preload IPC.{name}-t hasznal, de a shared.ts-ben nincs ilyen")

# a push csatornaknak (on/send) nincs handle-je, azokat kivesszuk
push_channels = {"OLLAMA_CHAT_CHUNK", "SETTINGS_CHANGED", "APP_NOTICE", "TOOL_CONFIRM_REQUEST"}
for name in sorted(used_in_preload - handled_in_main - push_channels):
    errors.append(f"[ipc] a preload IPC.{name}-t hivja, de a main.ts-ben NINCS handler")

for name in sorted(handled_in_main - used_in_preload):
    warnings.append(f"[ipc] a main.ts kezeli IPC.{name}-t, de a preload nem hivja (holt csatorna)")

for name in sorted(declared - used_in_preload - handled_in_main - sent_from_main):
    warnings.append(f"[ipc] IPC.{name} deklaralva, de sehol nincs hasznalva")

# ------------------------------------------------------- 4. kivezetett API-k
print("4. kivezetett regi API-k maradvanyai")
legacy = {
    r"IPC\.GET_MEMORY": "a regi string-alapu memoria csatorna",
    r"IPC\.SAVE_MEMORY": "a regi string-alapu memoria csatorna",
    r"companion\?\.getMemory\(\)": "a regi bridge memoria metodus",
    r"companion\.getMemory\(\)": "a regi bridge memoria metodus",
    r"companion\?\.saveMemory\(": "a regi bridge memoria metodus",
    r"windowMode": "a kivezetett ablak-mod beallitas",
    r"'qwen3:8b'": "regi alapertelmezett modell (csak tesztben/scriptben megengedett)",
}
for rel in walk():
    src = read(rel)
    for pattern, why in legacy.items():
        if re.search(pattern, src):
            # Windowson a rel fordított perjelet hasznal, ezert normalizalunk.
            norm = rel.replace("\\", "/")
            if "test" in norm or norm.startswith("scripts/"):
                continue
            errors.append(f"[legacy] {rel}: maradt hivatkozas -> {why} ({pattern})")

# --------------------------------------------- 5. bridge.d.ts <-> preload.ts
print("5. bridge.d.ts es preload.ts fedese")
bridge = read("src/types/bridge.d.ts")

# a bridge namespace-ek metodusai
def methods_of(text, namespace):
    m = re.search(namespace + r":\s*\{(.*?)\n  \};", text, re.S)
    if not m:
        return set()
    return set(re.findall(r"^\s{4}(\w+)[\(<]", m.group(1), re.M))

for ns in ["memory", "conversations", "index", "artifacts", "compaction", "tools", "router", "skills", "diagnostics"]:
    in_bridge = methods_of(bridge, ns)
    pm = re.search(ns + r":\s*\{(.*?)\n  \},?\n", preload, re.S)
    in_preload = set(re.findall(r"^\s{4}(\w+):", pm.group(1), re.M)) if pm else set()
    for name in sorted(in_bridge - in_preload):
        errors.append(f"[bridge] a bridge.d.ts szerint van {ns}.{name}(), de a preload nem teszi ki")

# ------------------------------------------------------------------ eredmeny
print()
print("=" * 68)
if errors:
    print(f"HIBA: {len(errors)}")
    for e in errors:
        print("  " + e)
else:
    print("HIBA: nincs")
print()
if warnings:
    print(f"figyelmeztetes: {len(warnings)}")
    for w in warnings:
        print("  " + w)
print("=" * 68)
sys.exit(1 if errors else 0)
