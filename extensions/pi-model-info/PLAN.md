# PLAN.md — `pi-model-info` extension

## 1. Goal

Build a `pi` extension, `pi-model-info`, that maintains a locally-cached,
periodically-refreshed catalog of free-tier LLM models (across OpenRouter and
other configured gateways/foundation-model free tiers) and annotates pi's
`/model` list so the user can see, at a glance, which free models are
currently alive and how tight their usage limits are.

A second, already-existing extension (subagent dispatcher, which spawns
light/medium/heavy subagents for different task types) should **optionally**
consume this catalog to prefer highly-available models within whatever tier
it has already selected — without requiring `pi-model-info` to be installed.

This document is the spec for an implementing agent. It captures not just
*what* to build but *why*, since several design decisions here were reached
by ruling out simpler alternatives (see "Rejected/deferred approaches").

---

## 2. Component boundaries

Two independent pi extensions, coupled only through a shared file on disk —
**not** through any in-process extension-to-experience API, because pi does
not appear to expose a documented inter-extension service registry. Coupling
through a file keeps both extensions independently installable/removable.

### 2.1 `pi-model-info` (this project)
Owns:
- Discovering which free models exist across configured providers.
- Pinging them (lightly, see §5) to determine live/dead/rate-limited status.
- Classifying each into an availability tier (green/yellow/red/unverified).
- Persisting all of this to a catalog file.
- Annotating pi's `/model` list via `modelOverrides` (light-touch, see §7).
- Exposing a manual refresh command.

Does **not** own:
- Task-to-tier mapping (light/medium/heavy) — that's the other extension's
  job entirely. `pi-model-info` only answers "is X alive and how
  rate-limited is it," never "what kind of task is X good for."
- Coding-performance benchmarking — leaderboard scores (e.g. Aider Polyglot)
  are looked up/joined during catalog building, not computed locally.

### 2.2 Subagent dispatcher (existing extension, modified)
Add a **soft optional dependency** on `pi-model-info`'s catalog file:
- If the file exists and is fresh enough to parse, use it to prefer
  green > yellow > red/unavailable within whatever tier (light/medium/heavy)
  it already picked for the task.
- If the file is missing, stale beyond a sanity bound, or malformed: fall
  back to current tier-only behavior, unmodified. This must fail open —
  never block or error a subagent spawn because the optional catalog is
  absent.
- This soft dependency, and its exact fallback behavior, **must be
  documented in the dispatcher's README.md** in a dedicated section (see
  §10) so it's clear to any user (or future maintainer) that
  `pi-model-info` is optional, what happens if it's missing, and what
  file/schema it reads.

---

## 3. Catalog file

### 3.1 Location
`~/.pi/agent/extensions/pi-model-info/model-catalog.json`

Well-known, fixed path, inside the extension's own directory package
(consistent with the user's existing convention of extension data living
under `~/.pi/agent/extensions/`). This is the sole coupling surface between
the two extensions. No env var indirection needed initially — keep it
simple; a config override can be added later if needed.

### 3.2 Schema (per-entry)

A model can be exposed by more than one provider/gateway (e.g. the same
weights reachable via OpenRouter and via OpenCode's own routing), and
availability is fundamentally a **per-provider** fact, not a per-model one —
one gateway's route to a model can die while another's stays fine. The
schema therefore splits **model-level** metadata (assumed shared across
whatever providers expose it) from **provider-level** liveness/limit data
(independent per provider, keyed by provider id):

```jsonc
{
  "schema_version": 1,
  "generated_by": "pi-model-info",
  "entries": {
    "<normalized_model_key>": {
      // model-level: assumed shared across providers (see caveats below)
      "aider_polyglot_score": 0.42,        // null if no leaderboard match

      // provider-level: one block per provider/gateway exposing this model
      "providers": {
        "openrouter": {
          "raw_id": "tencent/hy3:free",
          "context_length": 128000,        // observed, see §4.4 — not assumed
          "status": "red",                 // green | yellow | red | unverified | restricted
          "status_reason": "404 — removed by OpenRouter",
          "status_code": 404,              // last HTTP status observed, if any
          "source": "real",                // "real" | "synthetic" — provenance of last update
          "rpm_documented": 20,            // from provider docs / free-llm-api-resources, if known
          "rpd_documented": 50,
          "retry_after": null,             // ISO timestamp; don't re-probe before this
          "last_checked": "2026-07-22T09:15:00Z",
          "last_real_call": "2026-07-22T09:10:00Z", // null if never used for real work
          "consecutive_synthetic_failures": 0
        },
        "opencode": {
          "raw_id": "hy3-free",
          "context_length": 128000,
          "status": "green",
          "status_reason": "ok",
          "status_code": 200,
          "source": "synthetic",
          "rpm_documented": null,
          "rpd_documented": null,
          "retry_after": null,
          "last_checked": "2026-07-22T08:00:00Z",
          "last_real_call": null,
          "consecutive_synthetic_failures": 0
        }
        // more providers as discovered
      }
    }
  }
}
```

Notes:
- `normalized_model_key` is the join key across providers and leaderboards
  (see §4.2) — NOT any single provider's raw ID.
- `restricted` is distinct from `red`: it means the model exists and works
  for other people, but 401/403/402 for *this* account specifically (region
  gating, KYC, or turned out to require payment despite advertising
  `pricing: 0`). See §6.
- `unverified` is a distinct 4th status beyond the original green/yellow/red
  ask — added specifically to avoid silently trusting stale data (see §5.4).
- All of `status`, `status_reason`, `status_code`, `source`, `rpm_documented`,
  `rpd_documented`, `retry_after`, `last_checked`, `last_real_call`, and
  `consecutive_synthetic_failures` live **per provider**, not per model —
  §6, §7, and §8's logic all operate at this provider level (a 404 on one
  provider's route must not touch another provider's entry for the same
  model).

#### Caveats on the model-level fields

- **`context_length` is per-provider, not model-level, and is *observed*
  data, not an assumption.** It is only reliably known once the model has
  actually been selected/used through that specific provider — some
  gateways cap a model below its native window, or report it only at
  selection time — so this field should be populated from real probe/usage
  responses (§4.3), not hardcoded from a spec sheet. It legitimately can
  differ between two providers exposing "the same" model.
- **`aider_polyglot_score` stays model-level, but is a known imprecise
  join.** The leaderboard score is measured against whatever context length
  and configuration the benchmark used (typically the vendor's advertised/
  max context) — which may not match what a given provider's free-tier
  route actually makes available. There isn't a clean way to correct for
  this from our side; treat the score as a directional signal for model
  capability, not a guarantee that reflects the exact conditions of any one
  provider's free route. Worth a one-line disclaimer wherever this score is
  surfaced in the UI (§7), so it doesn't read as more precise than it is.

### 3.3 Write safety
- Writes must be **debounced** — real-usage 4xx/2xx events could arrive in
  rapid bursts (a flurry of subagent calls); do not hit disk per event.
  Batch writes every few seconds, or on process exit.
- Writes must be **atomic**: write to a temp file in the same directory,
  then rename over the target. Prevents a pi crash mid-write from
  corrupting the catalog both extensions depend on.
- Reads by the subagent dispatcher should tolerate a missing or malformed
  file (see §2.2) — never throw uncaught.

---

## 4. Discovery & normalization

### 4.1 Discovery

**Scope exclusion — local providers are out of scope entirely.** Do not
discover, probe, or annotate models served by local inference backends
(pi's llama.cpp router, Ollama, LM Studio, vLLM-local, or any other
provider whose `baseUrl` points at localhost/a LAN address rather than a
remote gateway). A synthetic liveness ping to a remote API is a cheap,
side-effect-free HTTP call; the same ping to a local backend can trigger a
full model load into VRAM, potentially evicting whatever the user actually
has loaded and is actively using. This is a real, disruptive cost, not a
quota concern — good-citizen throttling (§8.4) doesn't fix it, since the
problem isn't rate, it's the act of loading at all.

Practically: maintain a small denylist/allowlist of provider *kinds* (not
just names) — e.g. keying off pi's provider config `discovery.type` or
`api` fields for known local backends (`ollama`, `llama.cpp`, `lm-studio`,
or a bare-localhost/private-IP `baseUrl`) — and skip those providers
entirely at the discovery stage in §4.1, so they never reach the liveness
prober in §5/§8 in the first place. This also means:
- No catalog entries are created for local-only models. They simply don't
  participate in this system — no `green`/`yellow`/`red`/`unverified`
  status, no annotation in `/model`, no rate-limit concept (rate limits are
  a remote free-tier problem; local inference has no quota, only VRAM
  contention, which is a different problem this extension isn't trying to
  solve).
- If a model happens to be reachable both locally *and* via a remote
  free-tier gateway (same weights, different route), only the remote
  gateway's entry is tracked. The local route is invisible to
  `pi-model-info` by design.
- This exclusion applies to **real-usage capture too** (§6.1), not just
  synthetic probing — a real call routed to a local provider should not be
  written into the catalog at all, since there's nothing meaningful to
  annotate (no shared quota, no "unavailable" state — a local model not
  currently loaded isn't "red," it's just not loaded yet).

**Remote discovery mechanics.** For each remaining (non-local) configured
provider/gateway, hit its `/models`-equivalent listing endpoint (OpenAI-
compatible convention: `GET /models` or provider-specific equivalent) and
filter to zero-cost / `:free`-suffixed entries. This gives the current
roster without needing to hardcode a list that goes stale (this is exactly
the failure mode that caused the `tencent/hy3:free` incident — pi's
*built-in* hardcoded catalog didn't know OpenRouter pulled the model).

Cross-reference against the community-maintained
`cheahjs/free-llm-api-resources` README for documented RPM/RPD caps that
aren't discoverable via headers alone (e.g. daily token ceilings).

### 4.2 ID normalization (important — this bit us already)
Different sources name the same model differently:
- `tencent/hy3:free` (OpenRouter) vs. `hy3-free` (OpenCode) — same model,
  different string.
- Aider leaderboard entries use yet another naming convention (family/size,
  no provider prefix, no `:free` suffix).

Normalization rules (apply before any join):
1. Strip known provider path prefixes.
2. Strip `:free` / `-free` / similar free-tier suffixes.
3. Lowercase, collapse separators (`-`, `_`, `.`) to a single form.
4. Maintain a small manual alias table for cases the above rules don't
   catch (expect to grow this over time — treat as a living list, not a
   one-time table).

Any entry that can't be confidently normalized/matched should still be
stored (under its raw ID as the key) rather than dropped — worse to lose
data than to have an unmatched leaderboard score.

### 4.3 Observed context length (per provider)

`context_length` is provider-specific, not model-level (§3.2), and only
reliably known once observed — some gateways cap a model below its native
window, or only reveal the real ceiling at selection/usage time. Do not
hardcode it from a spec sheet and assume it holds across every provider
exposing the model:
- If the liveness probe (§5, §8) or a real usage call returns context-size
  info (directly, or indirectly via a "context length exceeded" style
  error that reveals a ceiling), record that as the provider-level
  `context_length`.
- Until observed, leave it `null` rather than guessing — an unknown
  context length is more honest than a wrong one, and the UI (§7) should
  render it as "unknown" rather than omitting it silently.
- Expect the same model to legitimately show different `context_length`
  values across providers — this is real, not a bug in the join logic.

### 4.4 Coding-performance join
Cross-reference normalized model keys against Aider's Polyglot leaderboard
(`aider.chat/docs/leaderboards/`, `pass_rate_2` metric) where a match exists.
Store `null` rather than guessing when there's no confident match — do not
interpolate/estimate scores for unmatched models.

---

## 5. Availability classification

### 5.1 States
- **green** — passed a liveness check recently, and either documented or
  observed quota is generous (e.g. OpenRouter funded tier, or a
  provider-level cap well above light usage needs).
- **yellow** — passed a liveness check, but quota is tight (e.g. OpenRouter
  unfunded 50 req/day tier, or explicit provider notes like "trial use
  only").
- **red** — confirmed dead: 404, or a 401 in the "model no longer resolves
  for anyone" pattern (see §6).
- **restricted** — exists and works for others, but blocked for this
  account specifically (401/403/402 that looks account-specific rather
  than universal).
- **unverified** — no recent enough data to trust (see §5.4). Distinct from
  red; means "we don't currently know," not "it's broken."

### 5.2 Thresholds
Keep these as named constants, tunable without code changes if easy to do
so (e.g. top of a config module):
- `staleness_ttl` = 24h (matches the daily catalog refresh cadence agreed
  on with the user).
- `restricted_vs_red_heuristic`: if a 401/403 is observed on a model that
  *other* sources (live upstream `/models` listing) still show as
  present/active, classify as `restricted`, not `red`. If the model is
  simultaneously absent from the live upstream listing, classify `red`.

### 5.3 Why 4 states, not 3
Originally scoped as green/yellow/red. Added `unverified` because without
it, data older than the TTL would silently render as its last-known color,
which is exactly the kind of false confidence that caused the original
`hy3` confusion (an entry looked fine because nobody had re-checked it).
`unverified` should render as visually distinct from all three (see §7.2),
not just omitted.

### 5.4 Interplay with real-usage data (see §6)
A **real** call result should generally be trusted over an older
**synthetic** ping result of the same or lower recency, since it exercises
the exact code path, auth, and entitlements the user actually depends on.
Specifically:
- A real 404/hy3-pattern-401 → immediately sets `red`, bypasses TTL, no
  need to wait for confirmation.
- A real 429 → reinforces `yellow` (does NOT demote to red — see §6).
- Synthetic-only signals should require more corroboration before being
  fully trusted — e.g. consider requiring **two consecutive** synthetic
  404s before flipping to `red` purely on probe evidence, since probes are
  more likely to hit transient network blips than a real call is.

---

## 6. Handling 4xx responses as real data (not just in-memory demotion)

Per-code handling — do not treat "any 4xx" as one bucket:

| Code | Meaning here | Action |
|---|---|---|
| 404, or 401 in the "model doesn't resolve for anyone" pattern | Model is genuinely gone | Persist to `red` immediately, bypass TTL entirely. Store `source: "real"` if it came from actual usage, `"synthetic"` if from a probe. |
| 429 | Quota signal, not a death signal | Persist as reinforcement of `yellow` classification, with timestamp. If a `Retry-After` header or documented daily-reset time is available, store it in `retry_after` and **skip synthetic re-checks of this model until after that time** — don't waste a probe while it's cooling down. |
| 401/403/402 outside the universal-death pattern | Often account-specific (region/KYC gating, or turned out to be paid despite advertised `pricing: 0`) | Persist as `restricted`, distinct from `red` — this says something about the account/key, not the model's global existence. |
| 400 | Usually means *our* request payload was malformed for that model's particular schema, not that the model is unavailable | Log for debugging only. Do **not** let it change classification — auto-trusting 400s risks quietly blacklisting a working model because of a bug in the request-construction code, not the model. |

### 6.1 Real usage as a (mostly) free refresh signal
Mechanism (verified): pi's `after_provider_response` extension event fires
per HTTP response with `event.status` and normalized `event.headers`
(including `retry-after`); the model comes from `ctx.model`. Two documented
limits, both acceptable given §8's prober covers the long tail: it fires
**before stream body consumption** (mid-stream failures are invisible), and
header availability "depends on provider and transport" — treat as
best-effort.

Every time the subagent dispatcher makes a real call to a model already in
the catalog, treat the outcome as a catalog update:
- Success → `last_checked = now`, `last_real_call = now`, `source: "real"`,
  reinforces current status (or upgrades `unverified`/stale entries to
  `green`/`yellow` as appropriate).
- Failure → apply the table above.

This means models that are part of the user's normal light/medium/heavy
rotation stay fresh essentially for free — the synthetic prober (§8) only
needs to cover the long tail of catalog entries that aren't being
exercised by real traffic.

### 6.2 Runtime in-session demotion (layered on top, not a replacement)
Independent of the persisted catalog: if a model 429s during a session, the
subagent dispatcher should demote it **in-memory for the rest of the
session** so a burst of subagent spawns doesn't keep retrying a model that
just got throttled seconds ago. This is a fast, ephemeral, session-local
signal; the persisted catalog update above is the slower, durable one. Both
should exist; neither replaces the other.

---

## 7. Annotation mechanism (runtime `registerProvider`, verified against pi source)

### 7.1 Approach
Annotate each free model's displayed `name` with a prefix marker by
**re-registering the provider at runtime** via `pi.registerProvider()`,
rather than via `models.json` `modelOverrides` or a custom `/model`-picker
overlay.

**Why not `modelOverrides` (original plan — corrected):** `modelOverrides`
is *only* a field of the user's `~/.pi/agent/models.json` config file;
there is no runtime extension API for it. Using it would mean the extension
mutates user config — the actually brittle option:
- `models.json` is strictly schema-validated on load; one bad write makes
  **all** custom model loading fail (`Invalid models.json schema` → empty).
- The file reloads every time `/model` opens, so an extension write can
  clobber a user's concurrent manual edit.
- It supports JSONC comments; programmatic rewriting strips the user's
  comments/formatting.

**Why runtime `registerProvider` is safe despite replacing the provider's
whole model list** (semantics verified in pi's `ModelRegistry`:
`applyProviderConfig` does `models = models.filter(m => m.provider !== name)`
then adds the registered ones — full replacement):
- **Failure modes are session-scoped and self-healing.** Registration
  mutates only the in-memory registry; nothing touches disk. If the
  extension is removed or its factory throws, pi's built-in catalog is back
  next start. `unregisterProvider()` rebuilds from disk. Worst case:
  annotations missing for one session — never a broken config.
- **Fail-closed:** only call `registerProvider` after a validated,
  non-empty discovery fetch. On any error, skip re-registration entirely —
  the provider stays exactly as pi shipped it.
- **Roster-preserving:** build the replacement roster from
  `ctx.modelRegistry.getAll()` for that provider (superset of pi's
  built-ins AND the user's own `models.json` custom entries — the latter
  would otherwise be wiped, since registered providers are applied after
  `models.json` loads), keep every known model's full `Model` metadata
  untouched except `name`, and merge in newly-discovered free models the
  built-ins don't know.
- **It's the documented pattern** (custom-provider.md: "For dynamic model
  discovery, fetch and register models in the factory") and takes effect
  immediately at runtime, no `/reload` needed.

**Genuine residual risks (accepted, documented here):**
1. *Metadata fidelity for newly-discovered models only:* models not in pi's
   built-in catalog get provider-`/models`-derived metadata (`cost`,
   `contextWindow`, `reasoning`, `input`) which is shallower than pi's
   curated entries (no `compat`/`thinkingLevelMap`). Strictly additive
   (those models are unusable today), but a wrong `reasoning` default can
   subtly change request behavior — flag in code. Built-in-known models are
   unaffected.
2. *Free-model classification is provider-specific* (`:free` suffix,
   `pricing.prompt == "0"`, …). A classification bug annotates the wrong
   models — cosmetic only, since `name` is the only field touched for
   known IDs.
3. *Pi version drift* in replacement semantics: low (documented API,
   actively maintained per changelog), but pin a tested pi version in the
   README.

**Display expectation (verified in models.md):** `name` renders as
*secondary detail* in `/model`; the primary label stays the model `id`.
Glyphs are visible but not the leading text. True primary-label control
requires the deferred custom-overlay UI.

A full custom overlay picker (real ANSI color, custom sort order, filtering
red out of the list entirely) remains a plausible **future iteration**,
not part of this initial build.

### 7.2 Colorblind-safe marking
Do not rely on color alone (may not even be supported in the `name` field —
verify against the local pi checkout's model-picker rendering code before
assuming ANSI codes work there; if unsupported, plain glyphs below are the
whole solution, not a fallback for it).

Use **glyph + short text tag**, redundant with any color that is available:
- green → `✓` prefix, e.g. `✓ Qwen3-235B (free)`
- yellow → `~` prefix + explicit tight-limit note, e.g.
  `~ Hy3 (free, ~50 req/day)`
- red → `✗` prefix, e.g. `✗ Hy3 (free) — unavailable`
- restricted → distinct marker, e.g. `! Hy3 (free) — restricted for this account`
- unverified → distinct marker, e.g. `? Model (free) — not recently checked`

Exact glyphs are negotiable at implementation time, but the requirement is:
every state must be distinguishable by shape/text alone, with color as a
pure enhancement, never the only signal.

### 7.3 Removal vs. annotation of dead entries
Do **not** attempt to remove/hide red models from the list outright as the
default behavior — pi's documented model-merge semantics describe built-in
models as being *kept*, with custom entries only added or upserted by
matching ID, not removed by omission. Relying on removal would silently
break if that assumption is wrong or changes. Annotate with `✗` instead;
treat true hiding as a stretch goal to verify against the actual
`models-config-schema.ts` (or equivalent) types in the local pi source
before attempting it.

---

## 8. Refresh strategy

### 8.1 No OS-level scheduler dependency
Users may not be on Linux/systemd. Do not require cron/launchd/Task
Scheduler for the core design — pi itself runs identically across
platforms, so drive refresh entirely from pi's own lifecycle. OS schedulers
may be documented as an optional power-user addition later, not a
requirement.

### 8.2 Lifecycle split: cheap factory, session-scoped prober (verified against pi docs)

Pi's extension docs are explicit: factories "may run in invocations that
never start a session" (e.g. `pi --list-models`, RPC) and must **not**
start timers/background resources — defer those to `session_start`. This
forces a two-layer split, which also replaces the original
blocking-first-run design (user decision: never block usage; a 5–10 min
factory sweep would also hang non-interactive invocations):

- **Async factory (cheap, no probing):** one `GET /models` per configured
  remote provider (a handful of requests total) and re-register annotated
  rosters per §7. This keeps the model *roster* fresh on every startup
  essentially for free. No per-model liveness calls here.
- **`session_start` (all background work):** load the catalog file, start
  the throttled trickle prober (§8.4–8.9), register an idempotent
  `session_shutdown` handler to stop it and flush pending writes.

Refresh behavior:
- **Catalog file absent (first run ever)**: everything starts as
  `unverified` and the trickle prober converges over ~an hour. Entries are
  still immediately visible/selectable in `/model` because roster
  discovery already happened in the factory — this is why always-
  background is acceptable despite the §9 sweep estimate.
- **Catalog present but stale (per-entry `last_checked` older than
  `staleness_ttl`)**: use existing data immediately, prober refreshes in
  background. Optionally surface progress via a footer status widget.
- **Catalog present and fresh**: prober idles; zero probe calls.

### 8.3 Manual refresh command
Register `/refresh-free-models` (or similar) so the user can force a
refresh on demand — e.g. right after reading on a provider's status page
that something changed, without waiting for the TTL.

### 8.4 Rate-shaping the background refresh ("thundering herd" avoidance)
The refresher and the user's real subagent traffic share the same
per-provider quota bucket. Do not let the refresher consume anywhere near
the documented cap:
- Give the synthetic prober its own small budget, e.g. **~10% of a
  provider's documented RPM** (concretely: OpenRouter's free-tier cap is
  20 req/min flat per key regardless of how many distinct free models are
  behind it — cap synthetic probing there to ~2 req/min, leaving ~18
  req/min untouched for real usage).
- This stretches a full-catalog sweep from a theoretical "as fast as the
  limit allows" (~5–10 minutes for ~400 models, dominated by whichever
  single provider has the most free models behind one flat per-key limit)
  to something like an hour of thin background trickle — acceptable since
  nothing is blocking on it after the first run.

### 8.5 Per-entry staleness prioritization, not a global sweep
Track `last_checked` per catalog entry (not just per catalog file). Each
refresh tick, select only the **stalest N entries** across providers
(oldest `last_checked` first) rather than re-checking everything — spreads
load evenly over the TTL window instead of bursting.

### 8.6 Trickle mechanics given pi is not a daemon
Two layers:
- **On each pi startup**: process a small, time-boxed batch of "due"
  entries (bounded by count or by a few seconds of wall time), so even a
  user who hasn't opened pi in several days never triggers a big blocking
  sweep — just a slightly larger (but still bounded) catch-up batch.
- **Optional idle ticker during an open session**: a low-frequency interval
  (every 10–20 minutes) that checks a small number of due entries per
  provider. Benefits users who keep long-running sessions open.

### 8.7 Jitter
Two distinct uses — implement both, neither needs to be elaborate
(`base_interval ± ~20%` is sufficient):
- Jitter the **interval** between ticks, so the refresher doesn't fire at a
  predictable moment that might line up with the user's own usage bursts.
- Jitter **which** stale entries are selected within a batch, so the same
  handful of models aren't always checked in the same order.

### 8.8 Real-traffic guard
Before firing a synthetic tick, check time since the last real (non-
synthetic) call went out for that provider; skip the tick if that was very
recent (e.g. under ~10–15 seconds) as a cheap extra guard against a
synthetic ping landing in the same instant as a live burst, even though
both are individually within budget.

### 8.9 Retry-after awareness
When a 429 carries a `Retry-After` or documented reset time (§6), schedule
that entry's next synthetic check *after* that time rather than including
it in the normal staleness-ordered queue — avoids wasting a probe on a
model known to still be cooling down.

---

## 9. Effort/time estimate for a full catalog sweep (reference)

For context on why blocking-first-run is acceptable but blocking-every-run
is not: pinging ~400 free models is bound almost entirely by whichever
single provider's flat per-key RPM cap covers the most models, not by
total compute or network latency, since checks parallelize cleanly across
independent provider keys. With OpenRouter's flat 20 req/min covering an
estimated 100–150 of those models, a full sweep at (a conservative
fraction of) the documented cap lands around **5–10 minutes** unthrottled,
or **~7–12 minutes** throttled to ~70–80% of caps as a good-citizen margin
(the community-maintained free-tier tracker explicitly asks users not to
hammer these services). Cold-start stragglers on some serverless free
endpoints (10–20s spin-up) should be bounded by a per-request timeout
(~10–15s) and treated as `unverified`, not `red`, so they don't blow out
the total or get misclassified.

This estimate only matters for the **first-run** blocking case (§8.2) —
every subsequent refresh is the throttled background trickle from §8.4–8.8
and is not time-sensitive.

---

## 10. Documentation requirement

The subagent dispatcher's `README.md` must include a clearly labeled
section (e.g. "Optional: `pi-model-info` integration") stating:
- This extension optionally reads
  `~/.pi/agent/extensions/pi-model-info/model-catalog.json`.
- Exact fallback behavior if `pi-model-info` is not installed, or the file
  is missing/malformed/older than a sanity bound: falls back to unmodified
  tier-only selection, no error, no degraded startup.
- The schema version it expects, so future catalog format changes have a
  documented compatibility point.

`pi-model-info`'s own README should document its output file path/schema
as a stable-ish public contract, precisely because another extension
depends on it.

---

## 11. Rejected / deferred approaches (context for future changes)

Recorded so a future implementer doesn't re-propose and re-reject these:

- **Formal inter-extension dependency/service API**: no documented pi
  mechanism found for this; file-based coupling chosen instead. Revisit if
  pi ever adds such an API.
- **Writing `modelOverrides` into the user's `models.json` for annotation**
  (original §7.1): rejected after verification — `modelOverrides` has no
  runtime API, so it requires mutating user config with persistent,
  schema-validated, clobber-prone failure modes. Runtime
  `pi.registerProvider()` (session-scoped, self-healing, fail-closed) is
  strictly safer; see §7.1.
- **Blocking first-run sweep on startup**: rejected by user decision and by
  pi's factory lifecycle rules (no background work in factories; non-
  session invocations must not hang). Always-background prober instead;
  §8.2.
- **Centrally-shared, community-refreshed model-existence catalog** (to
  avoid every user re-discovering the same roster): rejected for now
  because tracking which providers *other* users are even registered to is
  an unbounded, unmanageable task from here. Kept local-only. Could be
  revisited later as a separate, opt-in project, not part of this scope.
- **OS-level scheduler (cron/systemd timer/launchd/Task Scheduler) as the
  primary refresh trigger**: rejected as the primary mechanism since it's
  four different things to document/maintain across platforms pi already
  runs on uniformly; may be documented later as an optional power-user
  addition, not required.
- **Hiding red models outright from `/model`**: rejected as default
  behavior — pi's model-merge semantics don't clearly support removal of
  already-known entries; annotate instead, revisit only after confirming
  otherwise against source.
- **Full custom `/model`-picker overlay UI**: deferred, not rejected — a
  reasonable future iteration once the light-touch annotation is in daily
  use and found lacking, but out of scope for this build to limit surface
  area.

---

## 12. Open items for the implementer

Resolved during plan review (kept for the record):
- ~~`registerProvider` replace-vs-merge semantics~~ → **full replacement**,
  verified in `ModelRegistry.applyProviderConfig`; §7.1 mitigations apply.
- ~~Whether a hidden/disabled flag exists for true removal~~ → **no**;
  merge semantics keep built-ins, annotate-only confirmed correct (§7.3).
- ~~Catalog path discrepancy~~ → fixed at
  `~/.pi/agent/extensions/pi-model-info/model-catalog.json` (§3.1).
- ~~First-run behavior~~ → always-background, factory/session split (§8.2).

Still open:
- Confirm in the pi checkout whether the model-picker's rendered `name`
  field supports ANSI color, to decide if §7.2's glyphs get real color as
  a bonus or stay plain-text-with-symbols. (Cosmetic only — glyphs carry
  the signal either way.)
- Decide exact numeric thresholds for green vs. yellow (this plan
  intentionally left them as named, tunable constants rather than fixed
  numbers, since documented free-tier caps change over time).
- Decide exact glyph set for §7.2 (functional requirement — distinguishable
  by shape/text, not color alone — is fixed; the specific characters are
  not).
