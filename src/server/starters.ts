import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __owndir = dirname(fileURLToPath(import.meta.url));
import type { ModuleFiles } from "../ai/engine.js";

export interface StarterTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  contentType?: "page" | "email";
  modules: ModuleFiles[];
  moduleOrder: string[];
  sharedCss: string;
  sharedJs: string;
}

export interface StarterMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  contentType?: "page" | "email";
  moduleCount: number;
}

let _cache: StarterTemplate[] | null = null;

function resolveStartersDir(): string | null {
  const candidates = [
    join(__owndir, "../../starters"),
    join(__owndir, "../starters"),
    join(process.cwd(), "starters"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadAll(): StarterTemplate[] {
  if (_cache !== null) return _cache;

  const dir = resolveStartersDir();
  if (!dir) { _cache = []; return _cache; }

  const starters: StarterTemplate[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      starters.push({
        id: data.id,
        name: data.name,
        description: data.description,
        category: data.category || "General",
        contentType: data.contentType === "email" ? "email" : undefined,
        modules: data.modules || [],
        moduleOrder: data.moduleOrder || [],
        sharedCss: data.sharedCss || "",
        sharedJs: data.sharedJs || "",
      });
    } catch { /* skip corrupt files */ }
  }

  _cache = starters;
  return _cache;
}

export function listStarters(): StarterMeta[] {
  return loadAll().map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    contentType: s.contentType,
    moduleCount: s.modules.length,
  }));
}

export function getStarter(id: string): StarterTemplate | null {
  return loadAll().find((s) => s.id === id) || null;
}
