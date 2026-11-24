#!/usr/bin/env python3
"""Price-proxy (W) report over Claude Code transcripts. Read-only, stdlib only.

W = input + 1.25*cache_creation + 0.1*cache_read + 5*output, per API message.

Sections
  legacy      W by bucket for two windows plus human-nudge counts (--base/--new).
  composition W term shares, output split by block type, final-report length (--from/--to).
  models      W by model, heaviest agents, first appearance per model (--from/--to).
  priced      USD estimate by bucket/family and cache_read share of USD vs of W (--base/--new/--from/--to).
  reach       share of agents whose context carries CLAUDE.md / output-style text.
  limits      USD and tokens per 5-hour window by model family; limit events per ISO week (--from/--to).
  context     main thread: USD above/below 200k context, compactions, cold resumes (--from/--to).
  floor       first-request tokens and cache_read share per agent type and family (--from/--to).
  outcomes    agents, USD, turns and verdict counts per agent type/phase, family, effort; advisor usage.

Transcript facts this relies on
  * One API message spans several jsonl lines with the same message.id: dedupe by id across
    ALL transcript files (before any window), keep the usage line with the highest
    output_tokens, union the content blocks.
  * Subagents: <project>/<session>/subagents/agent-*.jsonl (+ .meta.json with agentType);
    workflow agents: <project>/<session>/subagents/workflows/wf_*/agent-*.jsonl.
  * Human turns: user lines with origin.kind == "human".
  * CLAUDE.md arrives as an `attachment` line of type "instructions"; the output style as
    attachment types "output_style" / "output_style_instructions". The system prompt itself
    is not recorded, so absence of an attachment is not proof the text is absent there.
  * Limit events: assistant lines with isApiErrorMessage and quotaLimits.rateLimitType. Compactions:
    system lines with subtype compact_boundary. Effort: the assistant line's `effort` field.
    Workflow phase: workflowPhase in the agent's .meta.json.
  * Thinking blocks are almost always stored empty (redacted). See thinking_split().
"""
import argparse
import collections
import datetime
import json
import re
import statistics
from pathlib import Path

BUCKETS = ("main", "sub", "workflow")  # reviewers (ecomono-r*/judge*) fold into "sub" here
LEGACY_BUCKETS = ("main", "sub", "review", "workflow")  # legacy section splits reviewers out
NUDGES = [("dale", r"\bdale\b"), ("continua", r"contin[uú]a"),
          ("queda", r"queda algo"), ("como va", r"c[oó]mo va")]
# Strings for the reach section: first two live only in CLAUDE.md, the last only in the style.
CLAUDE_MD_PROBES = ("Lazy senior dev. Lazy = efficient", "Re-read context is ~50% of session cost")
STYLE_PROBE = "Voz mentor comprimida"
WINDOW_HOURS = 5          # usage-limit window length
CTX_HIGH = 200_000        # context tokens above which a main-thread turn counts as "long context"
COLD_MIN_CTX = 50_000     # a cold resume needs at least this much context ...
COLD_CR_SHARE = 0.10      # ... and cache_read below this share of it
VERDICTS = ("APPROVED", "ESCALATED", "PASS", "FAIL")
VERDICT_TEXT = re.compile(r"JUDGMENT:\s*(APPROVED|ESCALATED)|\b(PASS|FAIL)\b")


# USD per million tokens: (input, output, cache write 5m, cache write 1h, cache read).
# Source: https://platform.claude.com/docs/en/about-claude/pricing, fetched 2026-11-24.
# Matched by substring of message.model. Haiku prices are for prompts up to 100k tokens
# (above that: input 0.50, output 2.50); the long-prompt tier is ignored.
# ecomono: ceiling is current list price applied to every past version of a family, and the
# Haiku long-prompt tier ignored. Upgrade path: price by exact model id and date.
PRICES = {
    "fable": (8, 40, 10, 16, 0.20),
    "opus": (4, 20, 5, 8, 0.20),
    "sonnet": (2, 10, 2.50, 4, 0.10),
    "haiku": (0.10, 0.50, 0.125, 0.20, 0.01),
}


def family(model):
    return next((f for f in PRICES if f in (model or "")), None)


def usd(usage, model):
    """Estimated USD for one message, or None when the model matches no known family."""
    fam = family(model)
    if fam is None:
        return None
    p_in, p_out, p_w5, p_w1, p_cr = PRICES[fam]
    cc = usage.get("cache_creation_input_tokens", 0)
    split = usage.get("cache_creation") or {}
    w1 = split.get("ephemeral_1h_input_tokens", 0)
    w5 = split.get("ephemeral_5m_input_tokens", cc - w1) if split else cc
    return (usage.get("input_tokens", 0) * p_in + usage.get("output_tokens", 0) * p_out
            + w5 * p_w5 + w1 * p_w1 + usage.get("cache_read_input_tokens", 0) * p_cr) / 1e6


def cache_read_usd(usage, model):
    fam = family(model)
    return usage.get("cache_read_input_tokens", 0) * PRICES[fam][4] / 1e6 if fam else 0.0


def weight(u):
    return (u.get("input_tokens", 0) + 1.25 * u.get("cache_creation_input_tokens", 0)
            + 0.1 * u.get("cache_read_input_tokens", 0) + 5 * u.get("output_tokens", 0))


def classify(path, root):
    """Return (kind, session_id, agent_type) from the transcript path."""
    rel = path.relative_to(root).parts
    if len(rel) == 2:
        return "main", rel[1][:-6], "main"
    try:
        agent_type = json.loads(path.with_suffix(".meta.json").read_text()).get("agentType", "")
    except (OSError, ValueError):
        agent_type = ""
    kind = "workflow" if "workflows" in rel else "sub"
    return kind, rel[1], agent_type or "?"


def meta_label(path):
    """'phase/description' from the agent's .meta.json, when present."""
    try:
        m = json.loads(path.with_suffix(".meta.json").read_text())
    except (OSError, ValueError):
        return ""
    return "/".join(x for x in (m.get("workflowPhase"), m.get("description")) if x)


def meta_phase(path):
    try:
        return json.loads(path.with_suffix(".meta.json").read_text()).get("workflowPhase") or ""
    except (OSError, ValueError):
        return ""


def advisor_used(j, usage):
    """True when the usage or a content block (type or tool name) names the advisor.

    The line field advisorModel is the configured advisor, present on most lines, so it is not usage.
    """
    if "advisor" in json.dumps(usage).lower():
        return True
    return any("advisor" in (str(b.get("type", "")) + str(b.get("name", ""))).lower()
               for b in (j.get("message") or {}).get("content") or [] if isinstance(b, dict))


def transcripts(root):
    for p in sorted(root.glob("*/**/*.jsonl")):
        yield p, *classify(p, root)


def lines(path):
    for raw in path.open(errors="ignore"):
        try:
            yield json.loads(raw)
        except ValueError:
            continue


def pct(a, b):
    return 100 * a / b if b else 0.0


def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict))


# ---------------------------------------------------------------- legacy section
def message_index(root):
    """message.id -> {path, kind, sid, type, ts, usage, model}, deduped across every transcript.

    usage/ts/model come from the highest-output_tokens line, over all files and all dates, so
    a window cannot clip a message into a partial line. Assumption: one id found in several
    files is one API message, counted once, in the main-thread file if any of them is a main
    thread, else in the first file in sorted path order (transcripts() yields sorted paths).
    """
    idx = {}
    for p, kind, sid, agent_type in transcripts(root):
        for j in lines(p):
            m = j.get("message") or {}
            mid, u, ts = m.get("id"), m.get("usage"), j.get("timestamp")
            if j.get("type") != "assistant" or not (mid and u and ts):
                continue
            rec = idx.get(mid)
            if rec is None:
                rec = idx[mid] = {"path": p, "kind": kind, "sid": sid, "type": agent_type,
                                  "ts": ts, "usage": u, "model": m.get("model")}
            elif kind == "main" and rec["kind"] != "main":
                rec.update(path=p, kind=kind, sid=sid, type=agent_type)
            if u.get("output_tokens", 0) >= rec["usage"].get("output_tokens", 0):
                rec.update(ts=ts, usage=u, model=m.get("model"))
    return idx


def legacy(root, wins, idx):
    def window(ts):
        for k, (a, b) in wins.items():
            if a <= ts[:10] <= b:
                return k

    agg = {k: collections.defaultdict(float) for k in wins}
    days = {k: set() for k in wins}
    sess = {k: set() for k in wins}
    turns = {k: [0, 0] for k in wins}
    nud = {k: collections.Counter() for k in wins}
    hum = {k: 0 for k in wins}
    for p, kind, sid, agent_type in transcripts(root):
        last_q, in_turn, w_prev = None, False, None
        for j in lines(p):
            ts = j.get("timestamp")
            w = window(ts) if ts else None
            if not w:
                continue
            t = j.get("type")
            if t == "assistant":
                c = j.get("message", {}).get("content")
                if kind == "main" and isinstance(c, list):
                    tx = [b.get("text", "") for b in c
                          if b.get("type") == "text" and b.get("text", "").strip()]
                    if tx:
                        last_q = tx[-1].strip().endswith("?")
            elif t == "user" and kind == "main" and (j.get("origin") or {}).get("kind") == "human":
                if in_turn and last_q is not None:
                    turns[w_prev][0] += 1
                    turns[w_prev][1] += last_q
                in_turn, last_q, w_prev = True, None, w
                hum[w] += 1
                s = text_of(j["message"]["content"])
                for n, r in NUDGES:
                    if re.search(r, s, re.I):
                        nud[w][n] += 1
    for rec in idx.values():
        w = window(rec["ts"])
        if not w:
            continue
        kind, u = rec["kind"], rec["usage"]
        if kind == "sub" and re.search(r"ecomono-(r\d|judge)", rec["type"]):
            kind = "review"
        x = agg[w]
        x[kind] += weight(u)
        x[kind + "_cr"] += .1 * u.get("cache_read_input_tokens", 0)
        x[kind + "_out"] += 5 * u.get("output_tokens", 0)
        days[w].add(rec["ts"][:10])
        if kind == "main":
            sess[w].add(rec["sid"])
        x["n_" + kind] += 1
    for k in wins:
        x = agg[k]
        tot = sum(x[b] for b in LEGACY_BUCKETS)
        nd, ns = len(days[k]), len(sess[k])
        if not nd and not hum[k]:
            print(k, wins[k], "no data")
            continue
        print(k, wins[k], "activedays", nd, "mainsess", ns, "totalW %.0fM" % (tot / 1e6),
              "W/day %.1fM" % (tot / max(nd, 1) / 1e6), "W/mainsess %.1fM" % (tot / max(ns, 1) / 1e6))
        for b in LEGACY_BUCKETS:
            print("  %-8s %7.1fM %5.1f%%  msgs %d" % (b, x[b] / 1e6, pct(x[b], tot), x["n_" + b]))
        print("  main cache_read share of main W %.1f%%  of total W %.1f%%; main out share %.1f%%"
              % (pct(x["main_cr"], x["main"]), pct(x["main_cr"], tot), pct(x["main_out"], x["main"])))
        allcr = sum(x[b + "_cr"] for b in LEGACY_BUCKETS)
        print("  all cache_read share of total W %.1f%%" % pct(allcr, tot))
        t = turns[k]
        print("  turns", t, "question %.0f%%" % (100 * t[1] / max(t[0], 1)), "human msgs", hum[k],
              dict(nud[k]), "per100 turns", {n: round(100 * c / max(t[0], 1), 1) for n, c in nud[k].items()})


# ------------------------------------------------------- composition/models/reach
def scan(root, lo, hi, idx):
    """One pass over every transcript. Returns (agents, first_seen).

    agents: one record per transcript with at least one message in [lo, hi]. A message
    belongs to the file and window that message_index() assigns it, not to every file holding it.
    first_seen: model -> {kind: earliest timestamp}, over ALL dates, not just the window.
    """
    agents = []
    first_seen = collections.defaultdict(dict)
    for p, kind, sid, agent_type in transcripts(root):
        msgs = {}
        order = []
        prompts = []
        compacts, seen_uuid, limit_events = [], set(), []
        flags = {"claude_md": set(), "style": False, "instructions": False}
        for j in lines(p):
            t = j.get("type")
            if t == "attachment":
                a = j.get("attachment") or {}
                if a.get("type") == "instructions":
                    flags["instructions"] = True
                    body = json.dumps(a.get("files"))
                    flags["claude_md"] |= {s for s in CLAUDE_MD_PROBES if s in body}
                elif a.get("type") in ("output_style", "output_style_instructions"):
                    flags["style"] = True
                continue
            if t == "system" and j.get("subtype") == "compact_boundary":
                if lo <= (j.get("timestamp") or "")[:10] <= hi and j.get("uuid") not in seen_uuid:
                    seen_uuid.add(j.get("uuid"))
                    compacts.append(j["timestamp"])
            if t == "user" and len(prompts) < 2:
                prompts.append(text_of((j.get("message") or {}).get("content", "")))
            if t != "assistant":
                continue
            m = j.get("message", {})
            ts, mid, model = j.get("timestamp", ""), m.get("id"), m.get("model")
            if j.get("isApiErrorMessage") and j.get("quotaLimits") and lo <= ts[:10] <= hi \
                    and j.get("uuid") not in seen_uuid:
                seen_uuid.add(j.get("uuid"))
                limit_events.append((ts, j["quotaLimits"].get("rateLimitType") or "?"))
            if model and model != "<synthetic>" and ts:
                fs = first_seen[model]
                if kind not in fs or ts < fs[kind]:
                    fs[kind] = ts
            own = idx.get(mid)
            if not own or own["path"] != p or not (lo <= own["ts"][:10] <= hi):
                continue
            rec = msgs.get(mid)
            if rec is None:
                rec = msgs[mid] = {"ts": own["ts"], "usage": own["usage"], "model": own["model"],
                                   "blocks": {}, "effort": j.get("effort"), "adv": False,
                                   "adv_cfg": bool(j.get("advisorModel"))}
                order.append(mid)
            rec["adv"] = rec["adv"] or advisor_used(j, m["usage"])
            for b in m.get("content") or []:
                if isinstance(b, dict):
                    rec["blocks"][json.dumps(b, sort_keys=True)] = b
        # ecomono: an agent with no owned message in the window is dropped here, so its limit
        # events and compactions are not counted. Upgrade path: build the record anyway when
        # limit_events or compacts is non-empty and let the sections skip agents without msgs.
        if not msgs:
            continue
        # A workflow agent's first turn is the harness relaying the user request; the
        # script's own task text is the second turn.
        prompt = prompts[0] if prompts else ""
        if prompt.startswith("[Workflow harness") and len(prompts) > 1:
            prompt = prompts[1]
        agents.append({"kind": kind, "sid": sid, "type": agent_type, "path": p,
                       "msgs": [msgs[i] for i in order], "prompt": prompt, "flags": flags,
                       "label": meta_label(p), "compacts": compacts, "limits": limit_events,
                       "phase": meta_phase(p) if kind != "main" else ""})
    return agents, first_seen


def load(root, idx, window, extra=()):
    """Scan the hull of `window` and every window in `extra`, so none is clipped to another.

    Returns (all, clipped, first_seen): every agent with messages in the hull, and those
    restricted to `window` for the sections that only use --from/--to.
    """
    wins = [window, *extra]
    full, first_seen = scan(root, min(w[0] for w in wins), max(w[1] for w in wins), idx)
    prepare(full)
    clipped = []
    inside = lambda ts: window[0] <= ts[:10] <= window[1]
    for a in full:
        ms = [m for m in a["msgs"] if inside(m["ts"])]
        if ms:
            clipped.append(dict(a, msgs=ms, limits=[e for e in a["limits"] if inside(e[0])],
                                compacts=[t for t in a["compacts"] if inside(t)]))
    prepare(clipped)
    return full, clipped, first_seen


def block_chars(blocks):
    """Characters per block type, plus whether any thinking block is empty (redacted) and tool ids."""
    c = {"text": 0, "tool_use": 0, "thinking": 0}
    empty_think, tool_ids = False, set()
    for b in blocks.values():
        t = b.get("type")
        if t == "text":
            c["text"] += len(b.get("text", ""))
        elif t == "tool_use":
            c["tool_use"] += len(b.get("name", "")) + len(json.dumps(b.get("input", {})))
            tool_ids.add(b.get("id"))
        elif t in ("thinking", "redacted_thinking"):
            c["thinking"] += len(b.get("thinking", ""))
            empty_think |= not b.get("thinking")
    return c, empty_think, tool_ids


def prepare(agents):
    """Attach W, per-model W, block chars, tool count and last-text length to each agent."""
    for a in agents:
        a["W"], a["by_model"], a["tools"], a["last_text"] = 0.0, collections.Counter(), set(), 0
        for m in a["msgs"]:
            m["W"] = weight(m["usage"])
            m["out"] = m["usage"].get("output_tokens", 0)
            m["chars"], m["empty_think"], ids = block_chars(m["blocks"])
            a["W"] += m["W"]
            a["by_model"][m["model"]] += m["W"]
            a["tools"] |= ids
            if m["chars"]["text"]:
                a["last_text"] = sum(len(b.get("text", "")) for b in m["blocks"].values()
                                     if b.get("type") == "text")
        a["model"] = a["by_model"].most_common(1)[0][0] if a["by_model"] else None


def chars_per_token(agents):
    """Chars per output token for prose and for tool_use JSON, from single-type messages.

    A message holding only text blocks (or only tool_use blocks) has no hidden thinking
    to explain its output_tokens, so chars/tokens over those messages is a clean ratio.
    """
    vis = collections.Counter()
    tok = collections.Counter()
    for a in agents:
        for m in a["msgs"]:
            kinds = {b.get("type") for b in m["blocks"].values()}
            if kinds in ({"text"}, {"tool_use"}):
                k = kinds.pop()
                vis[k] += m["chars"][k]
                tok[k] += m["out"]
    return {k: vis[k] / tok[k] if tok[k] else 3.0 for k in ("text", "tool_use")}


def split_output(m, ratio):
    """Return ({type: tokens} calibrated, {type: tokens} upper bound for visible blocks).

    usage carries one output_tokens per message, so tokens are apportioned by characters.
    Thinking is stored empty almost everywhere, so characters cannot see it:
      high: apportion output across visible chars only (hidden thinking counted as zero),
            an upper bound for text and tool_use.
      cal:  if the message has an empty thinking block, text/tool_use get chars/ratio tokens
            (per-type ratios calibrated on single-type messages), thinking gets the residual;
            otherwise (no thinking, or thinking chars present) same as high.
    Approximation: tool_use JSON and prose do not share one chars-per-token ratio.
    """
    c, out = m["chars"], m["out"]
    total = sum(c.values())
    high = {k: (out * v / total if total else 0.0) for k, v in c.items()}
    if not m["empty_think"]:
        return high, high
    text = min(out, c["text"] / ratio["text"])
    tool = min(out - text, c["tool_use"] / ratio["tool_use"])
    return {"text": text, "tool_use": tool, "thinking": out - text - tool}, high


def quantile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0


def composition(agents):
    ratio = chars_per_token(agents)
    print("\n== B. composition (calibrated chars/token: text %.2f, tool_use %.2f)"
          % (ratio["text"], ratio["tool_use"]))
    print("%-9s %8s | %6s %6s %6s %6s | out split of 5*out: text/tool_use/thinking"
          " (cal) | text%%W cal / high" % ("bucket", "W(M)", "input", "cc*1.25", "cr*.1", "5*out"))
    for b in BUCKETS:
        ms = [m for a in agents if a["kind"] == b for m in a["msgs"]]
        if not ms:
            continue
        w = sum(m["W"] for m in ms)
        term = [sum(m["usage"].get(k, 0) * f for m in ms) for k, f in
                (("input_tokens", 1), ("cache_creation_input_tokens", 1.25),
                 ("cache_read_input_tokens", .1), ("output_tokens", 5))]
        cal = collections.Counter()
        high = collections.Counter()
        hidden = 0
        for m in ms:
            c, h = split_output(m, ratio)
            cal.update(c)
            high.update(h)
            hidden += m["empty_think"]
        o5 = 5 * sum(cal.values())
        print("%-9s %8.1f | %5.1f%% %5.1f%% %5.1f%% %5.1f%% | %4.1f%% / %4.1f%% / %4.1f%% of out"
              " | %5.1f%% / %5.1f%%   (msgs %d, with empty thinking %d)"
              % (b, w / 1e6, *(pct(t, w) for t in term),
                 *(pct(cal[k], sum(cal.values())) for k in ("text", "tool_use", "thinking")),
                 pct(5 * cal["text"], w), pct(5 * high["text"], w), len(ms), hidden))
    print("\n== B4. final report length (last assistant text, chars/4), agents active in window")
    by = collections.defaultdict(list)
    for a in agents:
        if a["kind"] != "main" and a["last_text"]:
            by[(a["kind"], a["type"])].append(a["last_text"] / 4)
    print("%-9s %-24s %5s %7s %7s" % ("bucket", "agent type", "n", "median", "p90"))
    for (k, t), xs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        if len(xs) >= 3:
            print("%-9s %-24s %5d %7.0f %7.0f" % (k, t, len(xs), statistics.median(xs), quantile(xs, .9)))


def models(agents, first_seen, top):
    print("\n== C1. W by model (M) per bucket")
    cell = collections.defaultdict(float)
    count = collections.defaultdict(set)
    for a in agents:
        for mdl, w in a["by_model"].items():
            cell[(a["kind"], mdl)] += w
        count[(a["kind"], a["model"])].add(a["path"])
    for b in BUCKETS:
        row = {mdl: w for (k, mdl), w in cell.items() if k == b}
        tot = sum(row.values())
        print("%-9s total %7.1fM  " % (b, tot / 1e6) + "  ".join(
            "%s %.1fM (%.0f%%, %d files)" % (mdl, w / 1e6, pct(w, tot), len(count[(b, mdl)]))
            for mdl, w in sorted(row.items(), key=lambda kv: -kv[1])))
    print("\n   by agent type (non-main): W(M) by model")
    ty = collections.defaultdict(lambda: collections.Counter())
    for a in agents:
        if a["kind"] != "main":
            for mdl, w in a["by_model"].items():
                ty[(a["kind"], a["type"])][mdl] += w
    for key, c in sorted(ty.items(), key=lambda kv: -sum(kv[1].values()))[:14]:
        print("   %-9s %-24s %7.1f  " % (*key, sum(c.values()) / 1e6) +
              "  ".join("%s %.1f" % (m, w / 1e6) for m, w in c.most_common()))
    print("\n   main sessions by ISO week: W(M) by model")
    wk = collections.defaultdict(collections.Counter)
    for a in agents:
        if a["kind"] == "main":
            for m in a["msgs"]:
                d = m["ts"][:10]
                y, w, _ = datetime.date.fromisoformat(d).isocalendar()
                wk[f"{y}-W{w:02d}"][m["model"]] += m["W"]
    for w in sorted(wk):
        print("   %s  " % w + "  ".join("%s %.1f" % (m, v / 1e6) for m, v in wk[w].most_common()))
    print("\n== C2. heaviest %d non-main agents" % top)
    heavy = sorted((a for a in agents if a["kind"] != "main"), key=lambda a: -a["W"])[:top]
    for a in heavy:
        print("%7.1fM %-9s %-22s %-18s tools %3d | [%s] %s" % (
            a["W"] / 1e6, a["kind"], a["type"], a["model"], len(a["tools"]), a["label"][:40],
            re.sub(r"\s+", " ", a["prompt"])[:120]))
    print("\n== C3. first appearance per model (all dates) and fable usage in window")
    for mdl, fs in sorted(first_seen.items()):
        print("   %-20s %s" % (mdl, "  ".join("%s %s" % (k, v[:10]) for k, v in sorted(fs.items()))))
    fable = [a for a in agents if a["kind"] != "main" and any("fable" in (m or "") for m in a["by_model"])]
    print("   non-main agents with any fable message in window: %d of %d" % (
        len(fable), sum(a["kind"] != "main" for a in agents)))


def priced_totals(agents, lo, hi):
    """USD and W per bucket for messages dated in [lo, hi]; unknown models go to `unpriced`."""
    t = {"usd": collections.Counter(), "fam": collections.Counter(), "cr_usd": collections.Counter(),
         "W": collections.Counter(), "cr_w": collections.Counter(),
         "unpriced": collections.defaultdict(collections.Counter)}
    for a in agents:
        b = a["kind"]
        for m in a["msgs"]:
            if not lo <= m["ts"][:10] <= hi:
                continue
            u = m["usage"]
            t["W"][b] += m["W"]
            t["cr_w"][b] += .1 * u.get("cache_read_input_tokens", 0)
            cost = usd(u, m["model"])
            if cost is None:
                for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                          "cache_read_input_tokens"):
                    t["unpriced"][b][k] += u.get(k, 0)
                continue
            t["usd"][b] += cost
            t["fam"][(b, family(m["model"]))] += cost
            t["cr_usd"][b] += cache_read_usd(u, m["model"])
    return t


def priced(agents, windows):
    print("\n== D. estimated USD (list prices, see PRICES; cache_read share of USD vs of W)")
    for name, (lo, hi) in windows.items():
        t = priced_totals(agents, lo, hi)
        tot = sum(t["usd"].values())
        print("%s %s..%s  total $%.0f" % (name, lo, hi, tot))
        for b in BUCKETS:
            fams = "  ".join("%s $%.0f" % (f, c) for (bb, f), c in sorted(
                t["fam"].items(), key=lambda kv: -kv[1]) if bb == b)
            print("  %-9s $%8.0f %5.1f%%  %s" % (b, t["usd"][b], pct(t["usd"][b], tot), fams))
            if any(t["unpriced"][b].values()):
                print("  %-9s unpriced tokens %s" % (b, dict(t["unpriced"][b])))
        print("  cache_read share of main: USD %.1f%% vs W %.1f%% | overall: USD %.1f%% vs W %.1f%%" % (
            pct(t["cr_usd"]["main"], t["usd"]["main"]), pct(t["cr_w"]["main"], t["W"]["main"]),
            pct(sum(t["cr_usd"].values()), tot), pct(sum(t["cr_w"].values()), sum(t["W"].values()))))


def reach(agents):
    print("\n== A. context reach: agents/sessions whose transcript carries the text")
    print("%-9s %-24s %5s %8s %10s %10s %8s" % ("bucket", "agent type", "n", "instr", "CLAUDE#1",
                                                 "CLAUDE#2", "style"))
    grp = collections.defaultdict(list)
    for a in agents:
        grp[(a["kind"], a["type"] if a["kind"] != "main" else "main")].append(a["flags"])
    for (k, t), fl in sorted(grp.items(), key=lambda kv: -len(kv[1])):
        if len(fl) >= 3:
            n = len(fl)
            print("%-9s %-24s %5d %7.0f%% %9.0f%% %9.0f%% %7.0f%%" % (
                k, t, n, pct(sum(f["instructions"] for f in fl), n),
                *(pct(sum(s in f["claude_md"] for f in fl), n) for s in CLAUDE_MD_PROBES),
                pct(sum(f["style"] for f in fl), n)))
    print("   CLAUDE#1 = %r ; CLAUDE#2 = %r" % CLAUDE_MD_PROBES)


# ------------------------------------------------------------ baseline meters
def parse_ts(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))


def tokens_of(u):
    return sum(u.get(k, 0) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                                     "cache_read_input_tokens"))


def context_of(u):
    return (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
            + u.get("cache_creation_input_tokens", 0))


def priced_msgs(a):
    """Messages of a known model family: drops synthetic error lines and unknown models."""
    return [m for m in a["msgs"] if family(m["model"])]


def iso_week(ts):
    y, w, _ = datetime.date.fromisoformat(ts[:10]).isocalendar()
    return f"{y}-W{w:02d}"


def limits(agents):
    """USD and tokens per usage-limit window by family, plus limit events per ISO week.

    ecomono: the account's real window clock is not in the transcripts. A window opens at the first
    message after the previous one opened WINDOW_HOURS ago, so a gap of that length always starts a
    new one; in continuous use the cut can be off by up to the window length, and activity outside
    the scanned transcripts is invisible. Upgrade path: anchor on the reset time carried by a
    limit event when present.
    """
    rows = sorted((parse_ts(m["ts"]), family(m["model"]), usd(m["usage"], m["model"]),
                   tokens_of(m["usage"])) for a in agents for m in priced_msgs(a))
    wins, start = [], None
    for t, fam, cost, tok in rows:
        if start is None or t - start >= datetime.timedelta(hours=WINDOW_HOURS):
            wins.append({"start": t, "usd": collections.Counter(), "tok": collections.Counter()})
            start = t
        wins[-1]["usd"][fam] += cost
        wins[-1]["tok"][fam] += tok
    print("\n== E. usage-limit windows (%dh; list-price USD estimate): %d windows" % (WINDOW_HOURS, len(wins)))
    print("%-8s %5s | %8s %8s %8s | %9s %9s %9s" % ("family", "wins", "USD med", "p90", "max",
                                                    "Mtok med", "p90", "max"))
    for fam in (*PRICES, None):
        cs = [sum(w["usd"].values()) if fam is None else w["usd"][fam] for w in wins
              if fam is None or fam in w["usd"]]
        ts = [sum(w["tok"].values()) if fam is None else w["tok"][fam] for w in wins
              if fam is None or fam in w["tok"]]
        if cs:
            print("%-8s %5d | %8.2f %8.2f %8.2f | %9.1f %9.1f %9.1f" % (
                fam or "all", len(cs), statistics.median(cs), quantile(cs, .9), max(cs),
                statistics.median(ts) / 1e6, quantile(ts, .9) / 1e6, max(ts) / 1e6))
    events = collections.defaultdict(collections.Counter)
    hit = collections.Counter()
    for a in agents:
        for ts, kind in a["limits"]:
            events[iso_week(ts)][kind] += 1
            t = parse_ts(ts)
            i = max((i for i, w in enumerate(wins) if w["start"] <= t), default=None)
            if i is not None:
                hit[i] += 1
    print("limit events per ISO week (rateLimitType): total %d in %d windows" % (
        sum(sum(c.values()) for c in events.values()), len(hit)))
    for w in sorted(events):
        print("  %s  %s" % (w, "  ".join("%s %d" % kv for kv in events[w].most_common())))
    hit_usd = [sum(wins[i]["usd"].values()) for i in hit]
    rest = [sum(w["usd"].values()) for i, w in enumerate(wins) if i not in hit]
    if hit_usd and rest:
        print("window USD median: with a limit event $%.2f, without $%.2f" % (
            statistics.median(hit_usd), statistics.median(rest)))
    return {"windows": len(wins), "events": {w: dict(c) for w, c in events.items()}}


def context(agents):
    """Main thread: USD split at CTX_HIGH, context quantiles, compactions and cold resumes.

    ecomono: a cold resume is inferred from usage alone (cache_read under COLD_CR_SHARE of the
    context, context over COLD_MIN_CTX); a compaction or a cache TTL expiry look the same, and the
    idle gap is measured from the previous message's timestamp, not from the last tool result.
    Upgrade path: tell them apart with the compact_boundary timestamp and the cache TTL in
    cache_creation.
    """
    main = [a for a in agents if a["kind"] == "main"]
    low = high = 0.0
    ctxs, cold, compacts = [], [], 0
    for a in main:
        compacts += len(a["compacts"])
        prev = None
        for m in priced_msgs(a):
            u, c = m["usage"], context_of(m["usage"])
            cost = usd(u, m["model"])
            ctxs.append(c)
            if c > CTX_HIGH:
                high += cost
            else:
                low += cost
            if prev is not None and c > COLD_MIN_CTX and u.get("cache_read_input_tokens", 0) < COLD_CR_SHARE * c:
                cc = {k: u[k] for k in ("cache_creation_input_tokens", "cache_creation") if k in u}
                cold.append((usd(cc, m["model"]), cost, (parse_ts(m["ts"]) - parse_ts(prev["ts"])).total_seconds()))
            prev = m
    tot = low + high
    print("\n== F. main-thread context (%d sessions, %d turns, USD $%.0f)" % (len(main), len(ctxs), tot))
    print("USD in turns <= %dk context $%.0f (%.0f%%), above $%.0f (%.0f%%)" % (
        CTX_HIGH // 1000, low, pct(low, tot), high, pct(high, tot)))
    print("context tokens per turn: median %d, p90 %d" % (statistics.median(ctxs) if ctxs else 0, quantile(ctxs, .9)))
    print("compactions (compact_boundary): %d" % compacts)
    gaps = [g for _, _, g in cold]
    print("cold resumes (cache_read < %d%% of context, context > %dk): %d turns, "
          "cache_creation $%.0f (%.0f%% of main), whole turns $%.0f (%.0f%%)" % (
              100 * COLD_CR_SHARE, COLD_MIN_CTX // 1000, len(cold), sum(c for c, _, _ in cold),
              pct(sum(c for c, _, _ in cold), tot), sum(t for _, t, _ in cold), pct(sum(t for _, t, _ in cold), tot)))
    if gaps:
        print("  idle gap before them: median %.0f min, p90 %.0f min" % (
            statistics.median(gaps) / 60, quantile(gaps, .9) / 60))
    return {"above": high, "below": low, "compactions": compacts, "cold": len(cold),
            "gap_median": statistics.median(gaps) if gaps else 0, "cold_cc_usd": sum(c for c, _, _ in cold)}


def dominant_family(a):
    by = collections.Counter()
    for m in priced_msgs(a):
        by[family(m["model"])] += usd(m["usage"], m["model"])
    return by.most_common(1)[0][0] if by else None


def floor(agents):
    """First-request tokens (input + cache_read + cache_creation) and cache_read share, per agent type."""
    groups = collections.defaultdict(list)
    for a in agents:
        ms = priced_msgs(a)
        if a["kind"] != "main" and ms:
            u = ms[0]["usage"]
            c = context_of(u)
            key = (("wf:" if a["kind"] == "workflow" else "") + a["type"], family(ms[0]["model"]))
            groups[key].append((c, u.get("cache_read_input_tokens", 0) / c if c else 0.0))
    print("\n== G. first-request tokens per agent type and family (cached = cache_read share)")
    print("%-26s %-7s %5s %9s %9s %8s" % ("agent type", "family", "n", "tok med", "tok p90", "cached"))
    out = {}
    for key, xs in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        toks = [c for c, _ in xs]
        out[key] = {"n": len(xs), "tokens": statistics.median(toks), "cached": statistics.median(s for _, s in xs)}
        if len(xs) >= 3 or len(groups) < 6:
            print("%-26s %-7s %5d %9.0f %9.0f %7.0f%%" % (
                key[0], key[1], len(xs), statistics.median(toks), quantile(toks, .9), 100 * out[key]["cached"]))
    return out


def normalize_verdict(v):
    if isinstance(v, bool):
        return "PASS" if v else "FAIL"
    v = str(v).strip().upper()
    return v if v in VERDICTS else None


def verdict_of(a):
    """Verdict word from structured output (a verdict/passed field), else the last text, else unknown.

    ecomono: text detection takes the last uppercase JUDGMENT:/PASS/FAIL token in the last text
    message, so prose quoting those words can misread, and a field named otherwise is unknown.
    The unknown share is printed so a wrong scorecard shows. Upgrade path: one marker line per role.
    """
    found = None
    for m in a["msgs"]:
        for b in m["blocks"].values():
            if b.get("type") == "tool_use" and isinstance(b.get("input"), dict):
                for k in ("verdict", "passed"):
                    if k in b["input"]:
                        found = normalize_verdict(b["input"][k]) or found
    if found:
        return found
    for m in reversed(a["msgs"]):
        text = " ".join(b.get("text", "") for b in m["blocks"].values() if b.get("type") == "text")
        if text.strip():
            hits = VERDICT_TEXT.findall(text)
            return next((x or y for x, y in reversed(hits) if x or y), "unknown")
    return "unknown"


def outcomes(agents, top=30):
    rows = collections.defaultdict(list)
    adv_agents = adv_msgs = cfg = 0
    for a in agents:
        adv = sum(m["adv"] for m in a["msgs"])
        adv_msgs += adv
        cfg += sum(m["adv_cfg"] for m in a["msgs"])
        adv_agents += bool(adv)
        ms = priced_msgs(a)
        if a["kind"] == "main" or not ms:
            continue
        eff = collections.Counter(str(m["effort"]) for m in ms).most_common(1)[0][0]
        rows[(a["phase"] or a["type"], dominant_family(a), eff)].append(
            (sum(usd(m["usage"], m["model"]) for m in ms), len(ms), verdict_of(a)))
    print("\n== H. outcomes per (agent type or workflow phase, family, effort); verdict from final output")
    print("%-26s %-7s %-7s %5s %8s %8s %6s  %s" % ("type/phase", "family", "effort", "n", "USD", "USD med",
                                                    "turns", "verdicts"))
    allv = collections.Counter()
    for key, xs in sorted(rows.items(), key=lambda kv: -sum(c for c, _, _ in kv[1]))[:top]:
        v = collections.Counter(x for _, _, x in xs)
        print("%-26s %-7s %-7s %5d %8.2f %8.2f %6.0f  %s" % (
            key[0][:26], key[1], key[2], len(xs), sum(c for c, _, _ in xs), statistics.median(c for c, _, _ in xs),
            statistics.median(n for _, n, _ in xs), " ".join("%s:%d" % kv for kv in v.most_common())))
    if len(rows) > top:
        print("(%d more cells omitted)" % (len(rows) - top))
    for xs in rows.values():
        allv.update(x for _, _, x in xs)
    n = sum(allv.values())
    print("all cells: %d agents, verdicts %s, unknown share %.0f%%" % (
        n, dict(allv.most_common()), pct(allv["unknown"], n)))
    print("advisor usage (block or usage names it): %d messages in %d agents; advisorModel configured on %d"
          " messages" % (adv_msgs, adv_agents, cfg))
    return {"verdicts": dict(allv), "advisor_msgs": adv_msgs, "advisor_cfg": cfg}


def self_test_meters():
    """Synthetic transcripts for limits, context, floor and outcomes."""
    import io
    import tempfile
    from contextlib import redirect_stdout

    def asst(mid, model, usage, content, ts, **extra):
        return {"type": "assistant", "timestamp": ts, "uuid": "u" + mid, "effort": "high",
                "message": {"id": mid, "model": model, "usage": usage, "content": content}, **extra}

    def write(path, rows, meta=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(map(json.dumps, rows)))
        if meta:
            path.with_suffix(".meta.json").write_text(json.dumps(meta))

    son = "claude-sonnet-5-5"
    day = "2026-11-02T"  # a Monday, ISO week 2026-W45
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        write(root / "proj" / "sess.jsonl", [
            asst("m1", son, {"input_tokens": 100, "output_tokens": 10, "cache_creation_input_tokens": 5000},
                 [], day + "10:00:00Z"),
            asst("m2", son, {"input_tokens": 50, "output_tokens": 10, "cache_read_input_tokens": 5000},
                 [], day + "10:05:00Z"),
            # cold resume: 1h55 idle, no cache_read, 60k context
            asst("m3", son, {"input_tokens": 10, "output_tokens": 10, "cache_creation_input_tokens": 60000},
                 [], day + "12:00:00Z"),
            # more than 5h after the window opened at 10:00 -> second window; context above 200k
            asst("m4", son, {"input_tokens": 10, "output_tokens": 10, "cache_read_input_tokens": 240000,
                             "cache_creation_input_tokens": 10000}, [], day + "16:00:00Z"),
            asst("e1", "<synthetic>", {"input_tokens": 0, "output_tokens": 0},
                 [{"type": "text", "text": "limit"}], day + "16:01:00Z",
                 isApiErrorMessage=True, quotaLimits={"rateLimitType": "five_hour"}),
            {"type": "system", "subtype": "compact_boundary", "uuid": "c1", "timestamp": day + "16:02:00Z"},
            {"type": "system", "subtype": "compact_boundary", "uuid": "c1", "timestamp": day + "16:02:00Z"}])
        sub = root / "proj" / "sess" / "subagents"
        warm = {"input_tokens": 0, "output_tokens": 5, "cache_read_input_tokens": 600,
                "cache_creation_input_tokens": 400}
        write(sub / "agent-j1.jsonl", [asst("j1", son, warm, [
            {"type": "text", "text": "findings\nJUDGMENT: APPROVED"}], day + "11:00:00Z")],
              {"agentType": "ecomono-judge-a"})
        write(sub / "agent-g1.jsonl", [asst("g1", son, warm, [
            {"type": "text", "text": "done"},
            {"type": "tool_use", "id": "t2", "name": "advisor", "input": {}}], day + "11:01:00Z",
            advisorModel="claude-opus-5")],
              {"agentType": "general-purpose"})
        write(sub / "workflows" / "wf_1" / "agent-w1.jsonl", [asst("w1", son, warm, [
            {"type": "tool_use", "id": "t", "name": "StructuredOutput", "input": {"passed": False}}],
            day + "11:02:00Z")], {"agentType": "general-purpose", "workflowPhase": "Verify"})
        agents, _ = scan(root, "2026-10-01", "2026-12-01", message_index(root))
        prepare(agents)
        with redirect_stdout(io.StringIO()) as out:
            lim = limits(agents)
            ctxr = context(agents)
            flr = floor(agents)
            oc = outcomes(agents)
        assert lim["windows"] == 2, lim
        assert lim["events"] == {"2026-W45": {"five_hour": 1}}, lim["events"]
        assert abs(ctxr["above"] - (10 * 2 + 240000 * .1 + 10000 * 2.5 + 10 * 10) / 1e6) < 1e-9 and ctxr["compactions"] == 1, ctxr
        assert ctxr["cold"] == 1 and abs(ctxr["gap_median"] - 6900) < 1, ctxr
        assert abs(ctxr["cold_cc_usd"] - 60000 * 2.5 / 1e6) < 1e-9, ctxr
        gp = flr[("wf:general-purpose", "sonnet")]
        assert gp["n"] == 1 and gp["tokens"] == 1000 and abs(gp["cached"] - 0.6) < 1e-9, gp
        assert oc["verdicts"] == {"APPROVED": 1, "FAIL": 1, "unknown": 1}, oc["verdicts"]
        assert oc["advisor_msgs"] == 1 and oc["advisor_cfg"] == 1, oc
        assert "unknown" in out.getvalue() and "five_hour" in out.getvalue()

    # Events outside --from/--to but inside a wider --base/--new hull must not reach the sections.
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        lim = lambda i, t: asst("e" + i, "<synthetic>", {"input_tokens": 0, "output_tokens": 0}, [], t,
                                isApiErrorMessage=True, quotaLimits={"rateLimitType": "five_hour"})
        cb = lambda i, t: {"type": "system", "subtype": "compact_boundary", "uuid": "c" + i, "timestamp": t}
        write(root / "proj" / "s.jsonl", [
            asst("a", son, {"input_tokens": 1, "output_tokens": 1}, [], "2026-11-01T10:00:00Z"),
            asst("b", son, {"input_tokens": 1, "output_tokens": 1}, [], "2026-11-02T10:00:00Z"),
            lim("1", "2026-11-01T11:00:00Z"), lim("2", "2026-11-02T11:00:00Z"),
            cb("1", "2026-11-01T11:00:00Z"), cb("2", "2026-11-02T11:00:00Z")])
        full, clipped, _ = load(root, message_index(root), ("2026-11-02", "2026-11-02"),
                                [("2026-11-01", "2026-11-01")])
        with redirect_stdout(io.StringIO()):
            assert limits(full)["events"] == {"2026-W44": {"five_hour": 1}, "2026-W45": {"five_hour": 1}}
            assert context(full)["compactions"] == 2
            assert limits(clipped)["events"] == {"2026-W45": {"five_hour": 1}}, "limits clipped to window"
            assert context(clipped)["compactions"] == 1, "compactions clipped to window"


def self_test():
    """Synthetic transcripts in a temp dir; asserts dedupe, bucket W and priced totals."""
    import contextlib
    import io
    import tempfile

    def asst(mid, model, usage, content, ts="2026-11-01T10:00:00Z"):
        return {"type": "assistant", "timestamp": ts,
                "message": {"id": mid, "model": model, "usage": usage, "content": content}}

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "proj" / "sess" / "subagents").mkdir(parents=True)
        main_lines = [  # one message id split over two lines: the higher output_tokens line wins
            asst("m1", "claude-fable-5-2",
                 {"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 10000,
                  "cache_creation_input_tokens": 1000,
                  "cache_creation": {"ephemeral_5m_input_tokens": 600, "ephemeral_1h_input_tokens": 400}},
                 [{"type": "thinking", "thinking": ""}]),
            asst("m1", "claude-fable-5-2",
                 {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 10000,
                  "cache_creation_input_tokens": 1000,
                  "cache_creation": {"ephemeral_5m_input_tokens": 600, "ephemeral_1h_input_tokens": 400}},
                 [{"type": "text", "text": "hi"}])]
        sub_lines = [
            asst("s1", "claude-sonnet-5-5",
                 {"input_tokens": 1000, "output_tokens": 100, "cache_creation_input_tokens": 2000}, []),
            asst("u1", "mystery-1", {"input_tokens": 7, "output_tokens": 3}, [])]
        (root / "proj" / "sess.jsonl").write_text("\n".join(map(json.dumps, main_lines)))
        sub = root / "proj" / "sess" / "subagents" / "agent-a1.jsonl"
        sub.write_text("\n".join(map(json.dumps, sub_lines)))
        sub.with_suffix(".meta.json").write_text(json.dumps({"agentType": "general-purpose"}))
        agents, _ = scan(root, "2026-10-01", "2026-12-01", message_index(root))
        prepare(agents)
        by = {a["kind"]: a for a in agents}
        assert len(by["main"]["msgs"]) == 1 and len(by["sub"]["msgs"]) == 2, "dedupe by message.id"
        assert by["main"]["msgs"][0]["out"] == 50, "keeps the max output_tokens line"
        t = priced_totals(agents, "2026-10-01", "2026-12-01")
        assert t["W"]["main"] == 2600 and t["W"]["sub"] == 4022, dict(t["W"])
        # fable: 100*8 + 600*10 + 400*16 + 10000*0.2 + 50*40 = 17200 ; sonnet: 2000+5000+1000 = 8000
        assert abs(t["usd"]["main"] - 0.0172) < 1e-9, t["usd"]["main"]
        assert abs(t["usd"]["sub"] - 0.0080) < 1e-9, t["usd"]["sub"]
        assert dict(t["unpriced"]["sub"]) == {"input_tokens": 7, "output_tokens": 3,
                                              "cache_creation_input_tokens": 0,
                                              "cache_read_input_tokens": 0}, t["unpriced"]
        assert abs(t["cr_usd"]["main"] - 0.002) < 1e-9
        # An explicit window outside --from/--to is scanned, not clipped to it.
        idx = message_index(root)
        full, clipped, _ = load(root, idx, ("2026-12-01", "2026-12-02"), [("2026-11-01", "2026-11-01")])
        assert not clipped and priced_totals(full, "2026-11-01", "2026-11-01")["usd"]["main"] > 0, \
            "base/new window outside --from/--to must keep its data"

    # Ids shared by several files, ids straddling a window edge, empty windows.
    def use(out):
        return {"input_tokens": 0, "output_tokens": out}

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "proj" / "a" / "subagents").mkdir(parents=True)
        put = lambda rel, ls: (root / rel).write_text("\n".join(map(json.dumps, ls)))
        put("proj/a/subagents/agent-a0.jsonl", [asst("d1", "x", use(200000), []), asst("f1", "x", use(4), [])])
        put("proj/a/subagents/agent-a1.jsonl", [asst("d1", "x", use(1000000), [])])
        put("proj/z.jsonl", [asst("f1", "x", use(3), []),
                             asst("e1", "x", use(20), [], "2026-11-01T10:00:00Z"),
                             asst("e1", "x", use(5), [], "2026-11-02T10:00:00Z")])
        idx = message_index(root)
        assert idx["d1"]["usage"]["output_tokens"] == 1000000 and idx["d1"]["path"].name == "agent-a0.jsonl"
        assert idx["f1"]["kind"] == "main" and idx["f1"]["usage"]["output_tokens"] == 4, "main file owns a shared id"
        ag, _ = scan(root, "2026-11-01", "2026-11-01", idx)
        got = {(a["kind"], m["usage"]["output_tokens"]) for a in ag for m in a["msgs"]}
        assert got == {("sub", 1000000), ("main", 4), ("main", 20)}, got
        assert not scan(root, "2026-11-02", "2026-11-02", idx)[0], "window follows the highest-output line"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            legacy(root, {"base": ("2026-11-01", "2026-11-01"), "none": ("2030-01-01", "2030-01-02")}, idx)
            legacy(root / "missing", {"base": ("2026-11-01", "2026-11-01")}, message_index(root / "missing"))
        out = buf.getvalue()
        assert "totalW 5M" in out and "sub          5.0M 100.0%  msgs 1" in out, out
        assert "main         0.0M   0.0%  msgs 2" in out and "none ('2030-01-01', '2030-01-02') no data" in out, out
        assert out.count("no data") == 2, out
    for bad in ("2026-11-5", "nope"):
        try:
            date_arg(bad)
        except argparse.ArgumentTypeError:
            continue
        raise AssertionError("date_arg accepted " + bad)
    assert date_arg("2026-11-05") == "2026-11-05"
    try:
        sections_arg("legacy,price")
    except argparse.ArgumentTypeError as e:
        assert "priced" in str(e), e
    else:
        raise AssertionError("sections_arg accepted an unknown name")
    for argv in (["--base", "2026-11-10", "2026-11-01"], ["--new", "2026-11-10", "2026-11-01"],
                 ["--from", "2026-11-10", "--to", "2026-11-01"], ["--from", "2999-01-01"]):
        with contextlib.redirect_stderr(io.StringIO()):
            try:
                parse_args(argv)
            except SystemExit as e:
                assert e.code == 2, e.code
                continue
        raise AssertionError("parse_args accepted reversed range %s" % argv)
    parse_args(["--from", "2026-11-05", "--to", "2026-11-05"])
    self_test_meters()
    print("self-test ok")


SECTIONS = ("legacy", "composition", "models", "priced", "reach")
# Opt-in: a run with these takes minutes, so the default list leaves them out.
METERS = ("limits", "context", "floor", "outcomes")


def date_arg(s):
    """argparse type: a valid ISO date, returned normalised (YYYY-MM-DD)."""
    try:
        return datetime.date.fromisoformat(s).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError("not a valid YYYY-MM-DD date: %r" % s)


def sections_arg(s):
    names = set(s.split(","))
    bad = names - set(SECTIONS + METERS)
    if bad:
        raise argparse.ArgumentTypeError("unknown section %s; valid: %s"
                                         % (", ".join(sorted(bad)), ", ".join(SECTIONS + METERS)))
    return names


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", type=Path, default=Path.home() / ".claude" / "projects")
    # Transcript timestamps are UTC, so the default windows end on the UTC date.
    today = datetime.datetime.now(datetime.timezone.utc).date()

    def ago(days):
        return (today - datetime.timedelta(days=days)).isoformat()

    # Defaults: the last 30 days, split into the last week ("new") and the 23 days before it.
    ap.add_argument("--base", nargs=2, type=date_arg, default=(ago(30), ago(8)), metavar=("FROM", "TO"))
    ap.add_argument("--new", nargs=2, type=date_arg, default=(ago(7), ago(0)), metavar=("FROM", "TO"))
    ap.add_argument("--from", dest="lo", type=date_arg, default=ago(30),
                    help="window start (composition, models, reach)")
    ap.add_argument("--to", dest="hi", type=date_arg, default=ago(0), help="window end, inclusive")
    ap.add_argument("--top", type=int, default=12)
    # METERS are opt-in: the default run's output stays as it was.
    ap.add_argument("--sections", type=sections_arg, default=",".join(SECTIONS),
                    help="comma list of: " + ",".join(SECTIONS + METERS))
    ap.add_argument("--self-test", action="store_true", help="run built-in synthetic-data asserts and exit")
    a = ap.parse_args(argv)
    for name, (lo, hi) in (("--base", a.base), ("--new", a.new), ("--from/--to", (a.lo, a.hi))):
        if lo > hi:
            ap.error("%s: FROM %s is after TO %s" % (name, lo, hi))
    return a

def main():
    a = parse_args()
    if a.self_test:
        return self_test()
    want = a.sections
    base, new, window = tuple(a.base), tuple(a.new), (a.lo, a.hi)
    idx = message_index(a.root)
    if "legacy" in want:
        legacy(a.root, {"base": base, "new": new}, idx)
    if want & {"composition", "models", "priced", "reach", *METERS}:
        print("\n== window %s .. %s" % window)
        # priced reads --base/--new too: scan their span as well as --from/--to.
        full, agents, first_seen = load(a.root, idx, window, (base, new) if "priced" in want else ())
        if "composition" in want:
            composition(agents)
        if "models" in want:
            models(agents, first_seen, a.top)
        if "priced" in want:
            priced(full, {"window": window, "base": base, "new": new})
        if "reach" in want:
            reach(agents)
        for name, fn in zip(METERS, (limits, context, floor, outcomes)):
            if name in want:
                fn(agents)


if __name__ == "__main__":
    main()
