// A memory cap for one plugin process, from Linux control groups. workerd has no memory setting of its own, and an
// address-space limit (prlimit --as) stops it from starting (tech stack research, test 3), so the operating system
// must do it. Where it cannot (macOS, Windows, a host without rights), the runner says so: `memoryLimit` is "none".
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryLimitSupport = "cgroup-v1" | "cgroup-v2" | "none";

const V1 = "/sys/fs/cgroup/memory";
const V2 = "/sys/fs/cgroup";

// The group whose children get the memory controller (set by v2Ready). Caps live here, next to the leaf that holds the
// processes, never inside the leaf: a leaf has no controller for its own children.
let v2Base = "";

export function detectMemoryLimit(): MemoryLimitSupport {
  if (process.platform !== "linux" || (process.getuid?.() ?? 1) !== 0) return "none";
  try {
    if (existsSync(join(V2, "cgroup.controllers"))) return v2Ready() ? "cgroup-v2" : "none";
    if (existsSync(join(V1, "cgroup.procs")) && writable(V1)) return "cgroup-v1";
  } catch {
    /* fall through */
  }
  return "none";
}

function writable(dir: string): boolean {
  try {
    const probe = join(dir, `oks_probe_${process.pid}`);
    mkdirSync(probe);
    rmdirSync(probe); // a control group folder is removed with rmdir
    return true;
  } catch {
    return false;
  }
}

/** In version 2, the memory controller must be switched on for the children of our group, and a group that has children must hold no processes itself. */
function v2Ready(): boolean {
  try {
    const own =
      readFileSync("/proc/self/cgroup", "utf8")
        .trim()
        .split("\n")
        .find((l) => l.startsWith("0::"))
        ?.slice(3) ?? "/";
    const base = join(V2, own);
    if (!readFileSync(join(base, "cgroup.controllers"), "utf8").split(/\s+/).includes("memory"))
      return false;
    const holder = join(base, "oks-host");
    mkdirSync(holder, { recursive: true });
    // A group that hands out a controller may hold no processes itself: move every process in it (this one, the shell
    // and the test runner that started it) into a leaf first.
    for (const pid of readFileSync(join(base, "cgroup.procs"), "utf8")
      .split(/\s+/)
      .filter(Boolean)) {
      try {
        writeFileSync(join(holder, "cgroup.procs"), pid);
      } catch {
        /* a process that has just ended */
      }
    }
    writeFileSync(join(base, "cgroup.subtree_control"), "+memory");
    v2Base = base;
    return true;
  } catch {
    return false;
  }
}

export interface MemoryCap {
  attach(pid: number): void;
  remove(): void;
}

export function createMemoryCap(
  support: MemoryLimitSupport,
  name: string,
  megabytes: number,
): MemoryCap | null {
  if (support === "none" || megabytes <= 0) return null;
  const bytes = String(megabytes * 1048576);
  if (support === "cgroup-v1") {
    const dir = join(V1, `oks_${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.limit_in_bytes"), bytes);
    try {
      writeFileSync(join(dir, "memory.memsw.limit_in_bytes"), bytes); // no swap either, where the system counts it
    } catch {
      /* not available */
    }
    return {
      attach: (pid) => writeFileSync(join(dir, "cgroup.procs"), String(pid)),
      remove: () => rmdirSync(dir),
    };
  }
  const dir = join(v2Base, `oks_${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.max"), bytes);
  try {
    writeFileSync(join(dir, "memory.swap.max"), "0");
  } catch {
    /* not available */
  }
  return {
    attach: (pid) => writeFileSync(join(dir, "cgroup.procs"), String(pid)),
    remove: () => rmdirSync(dir),
  };
}
