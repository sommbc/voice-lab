#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env.local");
const VENV_DIR = path.join(os.homedir(), ".venvs", "voice-lab-voxcpm");
const PYTHON_BIN = path.join(VENV_DIR, os.platform() === "win32" ? "Scripts/python.exe" : "bin/python");
const REQUIREMENTS_PATH = path.join(REPO_ROOT, "services/voxcpm/requirements.txt");
const HEALTH_TIMEOUT_MS = 60_000;
const NEXT_TIMEOUT_MS = 60_000;
const REQUIRED_NODE = [20, 9, 0];
const PYTHON_MODULES = [
  "fastapi",
  "pydantic",
  "numpy",
  "soundfile",
  "uvicorn",
  "voxcpm",
  "torch",
  "torchaudio"
];

const checkOnly = process.argv.includes("--check");
const children = new Set();
let shuttingDown = false;

main().catch((error) => {
  if (error instanceof Error) {
    console.error(`[local] fail: ${error.message}`);
  } else {
    console.error("[local] fail: unknown error");
  }
  process.exitCode = 1;
});

async function main() {
  process.chdir(REPO_ROOT);

  log(`repo: ${REPO_ROOT}`);
  verifyNodeAndNpm();
  await ensureNodeDependencies();

  const platformPlan = detectPlatformPlan();
  const envValues = await ensureEnvLocal(platformPlan);
  const selectedDevice = normalizeDevice(envValues.VOXCPM_DEVICE || platformPlan.device);
  const selectedPlan = resolveSelectedPlan(selectedDevice, platformPlan);

  warnForCpuFallback(selectedDevice, platformPlan);

  const python = await ensurePythonEnvironment();
  await ensurePythonDependencies(python, selectedPlan, envValues);
  await runRuntimeCheck(python, envValues);
  await verifySelectedDevice(python, selectedDevice, envValues);

  if (checkOnly) {
    log("local:check complete");
    return;
  }

  await assertPortAvailable(8809, "VoxCPM2 service");
  await assertPortAvailable(3000, "Next app");

  installShutdownHandlers();
  const service = startVoxcpmService(python, envValues);
  await waitForHealth(envValues);
  const next = startNextApp(envValues);
  await waitForNext();

  log("ready: http://localhost:3000");
  await waitForChildren([service, next]);
}

function verifyNodeAndNpm() {
  const nodeVersion = process.versions.node;
  if (!versionAtLeast(nodeVersion, REQUIRED_NODE)) {
    throw new Error(`Node ${formatVersion(REQUIRED_NODE)} or newer is required. Current Node is ${nodeVersion}.`);
  }
  log(`node ${nodeVersion}`);

  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (npm.status !== 0) {
    throw new Error("npm is required but was not available on PATH.");
  }
  log(`npm ${npm.stdout.trim()}`);
}

async function ensureNodeDependencies() {
  const nextBin = path.join(REPO_ROOT, "node_modules/.bin/next");
  if (existsSync(nextBin)) {
    log("npm dependencies present");
    return;
  }

  log("npm dependencies missing; installing");
  await run("npm", ["install"], { label: "npm", cwd: REPO_ROOT });
}

function detectPlatformPlan() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin" && arch === "arm64") {
    return {
      device: "mps",
      optimize: "false",
      torch: { kind: "default" },
      note: "Apple Silicon detected; using PyTorch default wheels and VOXCPM_DEVICE=mps."
    };
  }

  if (platform === "linux") {
    const cuda = detectCuda();
    if (cuda.status === "detected") {
      const wheel = resolveCudaWheel(cuda.version);
      if (!wheel) {
        return {
          device: "cuda",
          optimize: "true",
          torch: { kind: "cuda-unknown", cudaVersion: cuda.version },
          note: `CUDA ${cuda.version} detected, but no safe PyTorch wheel mapping is configured.`
        };
      }

      return {
        device: "cuda",
        optimize: "true",
        torch: { kind: "cuda", indexUrl: `https://download.pytorch.org/whl/${wheel}` },
        note: `CUDA ${cuda.version} detected; using PyTorch ${wheel} wheels.`
      };
    }

    if (cuda.status === "unknown") {
      return {
        device: "cuda",
        optimize: "true",
        torch: { kind: "cuda-unknown", cudaVersion: null },
        note: "NVIDIA tooling was found, but CUDA version could not be safely detected."
      };
    }

    return {
      device: "cpu",
      optimize: "false",
      torch: { kind: "cpu" },
      note: "No CUDA device detected; using CPU for wiring checks only."
    };
  }

  return {
    device: "cpu",
    optimize: "false",
    torch: { kind: "cpu" },
    note: `${platform}/${arch} detected; using CPU for wiring checks only.`
  };
}

function resolveSelectedPlan(device, platformPlan) {
  if (device === "cpu") {
    return {
      ...platformPlan,
      device,
      optimize: "false",
      torch: platformPlan.torch.kind === "default" ? { kind: "default" } : { kind: "cpu" }
    };
  }

  if (device === "mps") {
    return {
      ...platformPlan,
      device,
      optimize: "false",
      torch: { kind: "default" }
    };
  }

  if (device === "cuda") {
    const torch =
      platformPlan.torch.kind === "cuda" || platformPlan.torch.kind === "cuda-unknown"
        ? platformPlan.torch
        : { kind: "cuda-unknown", cudaVersion: null };

    return {
      ...platformPlan,
      device,
      optimize: "true",
      torch
    };
  }

  return platformPlan;
}

function detectCuda() {
  const nvidiaSmi = commandPath("nvidia-smi");
  if (!nvidiaSmi) {
    return { status: "missing" };
  }

  const result = spawnSync(nvidiaSmi, [], { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/CUDA Version:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) {
    return { status: "unknown" };
  }

  return { status: "detected", version: match[1] };
}

function resolveCudaWheel(version) {
  const [major, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }

  if (major > 12 || (major === 12 && minor >= 8)) return "cu128";
  if (major === 12 && minor >= 6) return "cu126";
  if (major === 12 && minor >= 4) return "cu124";
  if (major > 11 || (major === 11 && minor >= 8)) return "cu118";
  return null;
}

async function ensureEnvLocal(platformPlan) {
  const defaults = {
    VOICE_LAB_DATA_DIR: "$HOME/.voice-lab",
    VOXCPM_ENABLED: "true",
    VOXCPM_ENDPOINT_URL: "http://127.0.0.1:8809/generate",
    VOXCPM_HEALTH_URL: "http://127.0.0.1:8809/health",
    VOXCPM_API_KEY: randomBytes(32).toString("base64url"),
    VOXCPM_ENDPOINT_MODE: "native-wrapper",
    VOXCPM_MODEL: "openbmb/VoxCPM2",
    VOXCPM_DEVICE: platformPlan.device,
    VOXCPM_OPTIMIZE: platformPlan.optimize
  };

  let content = "";
  let existed = false;
  try {
    content = await fs.readFile(ENV_PATH, "utf8");
    existed = true;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const result = mergeEnvContent(content, defaults);
  if (result.changed) {
    await fs.writeFile(ENV_PATH, result.content, "utf8");
    log(existed ? ".env.local updated with missing safe local defaults" : ".env.local created with safe local defaults");
    if (result.generatedApiKey) {
      log("generated local VOXCPM_API_KEY in .env.local");
    }
  } else {
    log(".env.local present");
  }

  const envValues = parseEnvContent(result.content);
  const expanded = expandEnvValues(envValues);
  log(platformPlan.note);
  return expanded;
}

function mergeEnvContent(content, defaults) {
  const lines = content ? content.replace(/\r\n/g, "\n").split("\n") : [];
  const keyLines = new Map();
  let changed = false;
  let generatedApiKey = false;

  for (let index = 0; index < lines.length; index += 1) {
    const key = parseEnvLine(lines[index])?.key;
    if (key && !keyLines.has(key)) {
      keyLines.set(key, index);
    }
  }

  if (lines.length === 0) {
    lines.push("# Voice Lab local configuration generated by npm run local.");
    lines.push("# Keep this file private. It is ignored by git.");
    lines.push("");
    changed = true;
  }

  for (const [key, value] of Object.entries(defaults)) {
    const existingIndex = keyLines.get(key);
    if (existingIndex === undefined) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(`${key}=${value}`);
      changed = true;
      if (key === "VOXCPM_API_KEY") {
        generatedApiKey = true;
      }
      continue;
    }

    const parsed = parseEnvLine(lines[existingIndex]);
    if (parsed && parsed.value.trim() === "") {
      lines[existingIndex] = `${key}=${value}`;
      changed = true;
      if (key === "VOXCPM_API_KEY") {
        generatedApiKey = true;
      }
    }
  }

  const nextContent = `${lines.join("\n").replace(/\n*$/, "")}\n`;
  return { content: nextContent, changed, generatedApiKey };
}

function parseEnvContent(content) {
  const env = {};
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const parsed = parseEnvLine(line);
    if (parsed) {
      env[parsed.key] = unquote(parsed.value.trim());
    }
  }
  return env;
}

function parseEnvLine(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) {
    return null;
  }
  return { key: match[1], value: match[2] };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function expandEnvValues(values) {
  const expanded = {};
  const base = { ...process.env, HOME: os.homedir() };
  for (const [key, value] of Object.entries(values)) {
    expanded[key] = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name) => {
      if (Object.prototype.hasOwnProperty.call(expanded, name)) {
        return expanded[name];
      }
      if (Object.prototype.hasOwnProperty.call(base, name)) {
        return base[name] || "";
      }
      return match;
    });
  }
  return expanded;
}

async function ensurePythonEnvironment() {
  assertVenvOutsideRepo();

  if (existsSync(PYTHON_BIN)) {
    const version = pythonVersion(PYTHON_BIN);
    if (version === "3.11") {
      log(`Python venv present: ${displayPath(VENV_DIR)}`);
      return PYTHON_BIN;
    }

    throw new Error(
      `Python venv at ${displayPath(VENV_DIR)} uses Python ${version || "unknown"}, not 3.11. ` +
        `Remove or rename that venv, then rerun npm run local.`
    );
  }

  await fs.mkdir(path.dirname(VENV_DIR), { recursive: true });
  const uv = commandPath("uv");

  if (uv) {
    log("creating Python 3.11 venv with uv");
    await run(uv, ["python", "install", "3.11"], { label: "python", cwd: REPO_ROOT });
    await run(uv, ["venv", VENV_DIR, "--python", "3.11"], { label: "python", cwd: REPO_ROOT });
  } else {
    const python311 = commandPath("python3.11");
    if (!python311) {
      throw new Error(
        "Python 3.11 is required and uv is not installed. Install Python 3.11 or uv, then rerun npm run local."
      );
    }
    log("creating Python 3.11 venv with python venv");
    await run(python311, ["-m", "venv", VENV_DIR], { label: "python", cwd: REPO_ROOT });
  }

  const version = pythonVersion(PYTHON_BIN);
  if (version !== "3.11") {
    throw new Error(`Created venv uses Python ${version || "unknown"}, not 3.11.`);
  }

  await run(PYTHON_BIN, ["-m", "ensurepip", "--upgrade"], { label: "python", cwd: REPO_ROOT });
  return PYTHON_BIN;
}

async function ensurePythonDependencies(python, plan, envValues) {
  const missing = await missingPythonModules(python);
  const torchStatus = await inspectTorch(python);
  const needsCudaTorch =
    plan.device === "cuda" && (!torchStatus.ok || torchStatus.cudaAvailable !== true);
  const needsTorch = missing.includes("torch") || missing.includes("torchaudio") || needsCudaTorch;
  const needsServiceDeps = missing.some((moduleName) => moduleName !== "torch" && moduleName !== "torchaudio");

  if (!needsTorch && !needsServiceDeps) {
    log("Python dependencies present");
    return;
  }

  if (needsTorch) {
    await installTorch(python, plan);
  }

  const missingAfterTorch = await missingPythonModules(python);
  if (missingAfterTorch.some((moduleName) => moduleName !== "torch" && moduleName !== "torchaudio")) {
    log("installing VoxCPM2 service dependencies");
    await pipInstall(python, ["-r", REQUIREMENTS_PATH], envValues);
  }

  const stillMissing = await missingPythonModules(python);
  if (stillMissing.length > 0) {
    throw new Error(
      `Python dependencies are still missing in ${displayPath(VENV_DIR)}: ${stillMissing.join(", ")}. ` +
        "Rerun npm run local:check after fixing the package install error above."
    );
  }
}

async function installTorch(python, plan) {
  if (plan.torch.kind === "cuda-unknown") {
    throw new Error(
      "CUDA was detected, but the runner could not safely choose a PyTorch CUDA wheel. " +
        `Install torch in ${displayPath(VENV_DIR)} with the matching PyTorch index URL, then rerun npm run local. ` +
        "Common choices are https://download.pytorch.org/whl/cu128, cu126, cu124, or cu118."
    );
  }

  if (plan.torch.kind === "cuda") {
    log(`installing CUDA PyTorch wheels from ${plan.torch.indexUrl}`);
    await pipInstall(python, ["torch", "torchaudio", "--index-url", plan.torch.indexUrl]);
    return;
  }

  if (plan.torch.kind === "cpu") {
    log("warning: installing CPU PyTorch wheels; generation will be slow and is for wiring checks only");
    await pipInstall(python, ["torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cpu"]);
    return;
  }

  log("installing default PyTorch wheels");
  await pipInstall(python, ["torch", "torchaudio"]);
}

async function pipInstall(python, args, envValues = {}) {
  const uv = commandPath("uv");
  if (uv) {
    await run(uv, ["pip", "install", "--python", python, ...args], {
      label: "python",
      cwd: REPO_ROOT,
      env: childEnv(envValues)
    });
    return;
  }

  await run(python, ["-m", "pip", "install", ...args], {
    label: "python",
    cwd: REPO_ROOT,
    env: childEnv(envValues)
  });
}

async function missingPythonModules(python) {
  const code = [
    "import importlib.util, json",
    `modules = ${JSON.stringify(PYTHON_MODULES)}`,
    "print(json.dumps([name for name in modules if importlib.util.find_spec(name) is None]))"
  ].join("\n");
  const output = await runCapture(python, ["-c", code], { cwd: REPO_ROOT });
  return JSON.parse(output.stdout.trim() || "[]");
}

async function inspectTorch(python) {
  const code = [
    "import json",
    "try:",
    "    import torch",
    "    print(json.dumps({",
    "        'ok': True,",
    "        'cudaAvailable': bool(torch.cuda.is_available()),",
    "        'mpsAvailable': bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available()),",
    "    }))",
    "except Exception as exc:",
    "    print(json.dumps({'ok': False, 'error': f'{exc.__class__.__name__}: {exc}'}))"
  ].join("\n");
  const output = await runCapture(python, ["-c", code], { cwd: REPO_ROOT });
  return JSON.parse(output.stdout.trim() || '{"ok":false}');
}

async function runRuntimeCheck(python, envValues) {
  try {
    await run(python, ["services/voxcpm/check_runtime.py"], {
      label: "python",
      cwd: REPO_ROOT,
      env: childEnv(envValues)
    });
  } catch (error) {
    const device = normalizeDevice(envValues.VOXCPM_DEVICE);
    const deviceHelp =
      device === "mps"
        ? " On Apple Silicon, try VOXCPM_DEVICE=cpu for wiring checks or use CUDA Linux for practical generation."
        : device === "cuda"
          ? " Confirm the NVIDIA driver and PyTorch CUDA wheel match, then rerun npm run local:check."
          : " CPU mode is only for wiring checks; use CUDA Linux for practical generation.";
    throw new Error(`VoxCPM runtime check failed.${deviceHelp}`);
  }
}

async function verifySelectedDevice(python, device, envValues) {
  const torch = await inspectTorch(python);
  if (!torch.ok) {
    throw new Error(`PyTorch import failed: ${torch.error || "unknown error"}`);
  }

  if (device === "cuda" && torch.cudaAvailable !== true) {
    throw new Error(
      "VOXCPM_DEVICE=cuda is selected, but PyTorch does not report CUDA availability. " +
        "Fix the CUDA PyTorch install or set VOXCPM_DEVICE=cpu for wiring checks, then rerun npm run local:check."
    );
  }

  if (device === "mps" && torch.mpsAvailable !== true) {
    log(
      "warning: VOXCPM_DEVICE=mps is selected, but PyTorch does not report MPS availability. " +
        "Try VOXCPM_DEVICE=cpu for wiring checks or use CUDA Linux for practical generation."
    );
  }

  if (device === "cpu") {
    log("warning: VOXCPM_DEVICE=cpu is selected; generation is expected to be slow and is for wiring checks only");
  }
}

async function assertPortAvailable(port, label) {
  const available = await isPortAvailable(port);
  if (!available) {
    throw new Error(`${label} port ${port} is already in use. Stop the process using port ${port}, then rerun npm run local.`);
  }
}

function startVoxcpmService(python, envValues) {
  log("starting VoxCPM2 service on http://127.0.0.1:8809");
  return spawnManaged(
    "voxcpm",
    python,
    ["-m", "uvicorn", "services.voxcpm.server:app", "--host", "127.0.0.1", "--port", "8809"],
    { cwd: REPO_ROOT, env: childEnv(envValues) }
  );
}

async function waitForHealth(envValues) {
  const healthUrl = envValues.VOXCPM_HEALTH_URL || "http://127.0.0.1:8809/health";
  const apiKey = envValues.VOXCPM_API_KEY;
  if (!apiKey) {
    throw new Error("VOXCPM_API_KEY is required for the health check.");
  }

  log("waiting for VoxCPM2 /health");
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000)
      });

      if (response.status === 200) {
        log("VoxCPM2 /health ok");
        return;
      }

      lastError = `HTTP ${response.status}`;
      if (response.status === 401) {
        throw new Error("VoxCPM2 /health returned 401. Confirm the same VOXCPM_API_KEY is used by the runner and service.");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.startsWith("VoxCPM2 /health returned 401")) {
        throw error;
      }
    }

    await sleep(1_000);
  }

  throw new Error(`VoxCPM2 /health did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s. Last error: ${lastError}`);
}

function startNextApp(envValues) {
  log("starting Next app on http://127.0.0.1:3000");
  return spawnManaged(
    "next",
    "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3000"],
    { cwd: REPO_ROOT, env: childEnv(envValues) }
  );
}

async function waitForNext() {
  log("waiting for Next app");
  const deadline = Date.now() + NEXT_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3000", {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.status < 500) {
        log("Next app ok");
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }

  throw new Error(`Next app did not become ready within ${NEXT_TIMEOUT_MS / 1000}s. Last error: ${lastError}`);
}

function spawnManaged(label, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  prefixStream(child.stdout, label, process.stdout);
  prefixStream(child.stderr, label, process.stderr);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[local] ${label} exited (${signal || (code ?? "unknown")}). Stopping local runner.`);
      void stopChildren().finally(() => {
        process.exitCode = code && code !== 0 ? code : 1;
        process.exit();
      });
    }
  });
  child.once("error", (error) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[local] ${label} failed to start: ${error.message}`);
      void stopChildren().finally(() => {
        process.exitCode = 1;
        process.exit();
      });
    }
  });
  return child;
}

function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      log(`received ${signal}; stopping child processes`);
      void stopChildren().finally(() => process.exit(0));
    });
  }
}

async function waitForChildren(activeChildren) {
  await Promise.race(
    activeChildren.map(
      (child) =>
        new Promise((resolve) => {
          child.once("exit", resolve);
        })
    )
  );
}

async function stopChildren() {
  shuttingDown = true;
  const active = Array.from(children).filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of active) {
    child.kill("SIGTERM");
  }

  await Promise.race([
    Promise.all(active.map((child) => onceExit(child))),
    sleep(5_000).then(() => {
      for (const child of active) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    })
  ]);
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
  });
}

function childEnv(envValues = {}) {
  return {
    ...process.env,
    ...envValues,
    PYTHONUNBUFFERED: "1"
  };
}

async function run(command, args, { cwd = REPO_ROOT, env = process.env, label = "local" } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    prefixStream(child.stdout, label, process.stdout);
    prefixStream(child.stderr, label, process.stderr);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${signal || code}`));
      }
    });
  });
}

async function runCapture(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${signal || code}: ${stderr || stdout}`));
      }
    });
  });
}

function prefixStream(stream, label, destination) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      destination.write(`[${label}] ${line}\n`);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      destination.write(`[${label}] ${buffer}\n`);
      buffer = "";
    }
  });
}

function commandPath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function pythonVersion(python) {
  const result = spawnSync(python, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function assertVenvOutsideRepo() {
  const relative = path.relative(REPO_ROOT, VENV_DIR);
  const insideRepo = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (insideRepo) {
    throw new Error(`Refusing to create Python venv inside the repo: ${VENV_DIR}`);
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function versionAtLeast(version, minimum) {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const current = parts[index] || 0;
    if (current > minimum[index]) return true;
    if (current < minimum[index]) return false;
  }
  return true;
}

function formatVersion(parts) {
  return parts.join(".");
}

function normalizeDevice(value) {
  const device = String(value || "").trim().toLowerCase();
  if (device === "cuda" || device === "mps" || device === "cpu") {
    return device;
  }
  return "cpu";
}

function warnForCpuFallback(selectedDevice, platformPlan) {
  if (selectedDevice !== "cpu") {
    return;
  }
  log(`warning: ${platformPlan.note}`);
}

function displayPath(value) {
  return value.replace(os.homedir(), "~");
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[local] ${message}`);
}
