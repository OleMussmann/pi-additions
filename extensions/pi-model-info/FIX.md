# FIX.md — pi-model-info Issues Fix Plan

## Issues to Fix

### 1. Debug messages during pi start
**File:** `annotate.ts`  
**Problem:** `debugNameCount` counter + `console.log` in `buildAnnotatedName()` outputs debug messages  
**Fix:** Remove `debugNameCount` variable and the `if (debugNameCount < 20) { console.log(...) }` block

---

### 2. Paid models not marked "available"
**Files:** `catalog.ts`, `annotate.ts`, `config.ts`, `prober.ts`  
**Problem:** Only free models (`is_free=true`) get availability tracking; paid models get no glyph/status  
**Fix:**  
- `catalog.ts`: In `emptyProviderEntry()`, default status to `"green"` (available) for all models, not `"unverified"`
- `config.ts`: Add `"available": "✓"` to `STATUS_GLYPHS` and add `STATUS_COLORS` map with ANSI codes
- `annotate.ts`: Show paid models with cyan `✓` glyph (colorized)
- `prober.ts`: Skip probing paid models (only probe free models)

---

### 3. No colorized model descriptions
**Files:** `config.ts`, `annotate.ts`  
**Problem:** Plain glyphs without ANSI color codes  
**Fix:**  
- `config.ts`: Add `STATUS_COLORS` object:
  ```ts
  export const STATUS_COLORS = {
    green: "32",       // green
    yellow: "33",      // yellow
    red: "31",         // red
    restricted: "35",  // magenta
    unverified: "90",  // gray
    available: "36",   // cyan (for paid models)
  } as const;
  ```
- `annotate.ts`: Import `STATUS_COLORS`, add `colorize(glyph, color)` helper, wrap all glyphs

---

### 4. PLAN.md still references `pi-free-models`
**File:** `PLAN.md`  
**Problem:** Project renamed to `pi-model-info` but plan not updated  
**Fix:** Replace throughout:
- Title: `pi-free-models` → `pi-model-info`
- Catalog path: `free-models-catalog.json` → `model-catalog.json`
- Directory: `pi-free-models` → `pi-model-info`
- `generated_by`: `"pi-free-models"` → `"pi-model-info"`

---

### 5. Catalog file path / creation
**File:** `config.ts`  
**Status:** Already correct — `CATALOG_PATH = ~/.pi/agent/extensions/pi-model-info/model-catalog.json` (US spelling)  
**Behavior:** File created on first `scheduleWrite()` call in `index.ts:session_start` via `writeCatalogAtomic()` which creates directory recursively.  
**Action:** Verify on first run — no code change needed.

---

## Implementation Order

1. **config.ts** — Add `STATUS_COLORS`, add `"available"` to `STATUS_GLYPHS`
2. **catalog.ts** — Change default provider status from `"unverified"` to `"green"`
3. **annotate.ts** — Remove debug logging, add colorization, handle paid models with cyan `✓`
4. **prober.ts** — Ensure only free models are probed (already skips non-free via `if (!entry.is_free) continue`)
5. **PLAN.md** — Global rename

---

## Testing Checklist

- [ ] Start pi — no debug messages in console
- [ ] Run `/model` — paid models show cyan `✓` prefix
- [ ] Run `/model` — free models show colored glyphs (green/yellow/red/magenta/gray)
- [ ] Run `/refresh-models` — catalog file created at `~/.pi/agent/extensions/pi-model-info/model-catalog.json`
- [ ] Verify PLAN.md reads correctly with new project name

---

## Risk Notes

- **ANSI codes in model names**: Verified working with pi's model picker (user confirmed)
- **Catalog schema change**: Default status change from `"unverified"` → `"green"` is backward compatible (existing entries keep their status)
- **Prober behavior**: Already skips non-free models; no change needed