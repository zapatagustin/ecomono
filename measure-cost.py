#!/usr/bin/env python3
"""Price-proxy (W) report over Claude Code transcripts. Read-only, stdlib only.

W = input + 1.25*cache_creation + 0.1*cache_read + 5*output, per API message.

Sections
  legacy      W by bucket for two windows plus human-nudge counts (--base/--new).
  composition W term shares, output split by block type, final-report length (--from/--to).
  models      W by model, heaviest agents, first appearance per model (--from/--to).
  priced      USD estimate by bucket/family and cache_read share of USD vs of W (--base/--new/--from/--to).
  reach       share of agents whose context carries CLAUDE.md / output-style text.

Transcript facts this relies on
  * One API message spans several jsonl lines with the same message.id: dedupe by id,
    keep the usage line with the highest output_tokens, union the content blocks.
  * Subagents: <project>/<session>/subagents/agent-*.jsonl (+ .meta.json with agentType);
    workflow agents: <project>/<session>/subagents/workflows/wf_*/agent-*.jsonl.
  * Human turns: user lines with origin.kind == "human".
  * CLAUDE.md arrives as an `attachment` line of type "instructions"; the output style as
    attachment types "output_style" / "output_style_instructions". The system prompt itself
    is not recorded, so absence of an attachment is not proof the text is absent there.
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
def legacy(root, wins):
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
        if kind == "sub" and re.search(r"ecomono-(r\d|judge)", agent_type):
            kind = "review"
        best = {}
        last_q, in_turn, w_prev = None, False, None
        for j in lines(p):
            ts = j.get("timestamp")
            w = window(ts) if ts else None
            if not w:
                continue
            t = j.get("type")
            if t == "assistant":
                m = j.get("message", {})
                u = m.get("usage")
                if u and m.get("id"):
                    o = best.get(m["id"])
                    if not o or u.get("output_tokens", 0) >= o[1].get("output_tokens", 0):
                        best[m["id"]] = (w, u, ts)
                c = m.get("content")
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
        for w, u, ts in best.values():
            x = agg[w]
            x[kind] += weight(u)
            x[kind + "_cr"] += .1 * u.get("cache_read_input_tokens", 0)
            x[kind + "_out"] += 5 * u.get("output_tokens", 0)
            days[w].add(ts[:10])
            if kind == "main":
                sess[w].add(sid)
            x["n_" + kind] += 1
    for k in wins:
        x = agg[k]
        tot = sum(x[b] for b in LEGACY_BUCKETS)
        nd, ns = len(days[k]), len(sess[k])
        print(k, wins[k], "activedays", nd, "mainsess", ns, "totalW %.0fM" % (tot / 1e6),
              "W/day %.1fM" % (tot / nd / 1e6), "W/mainsess %.1fM" % (tot / max(ns, 1) / 1e6))
        for b in LEGACY_BUCKETS:
            print("  %-8s %7.1fM %5.1f%%  msgs %d" % (b, x[b] / 1e6, 100 * x[b] / tot, x["n_" + b]))
        print("  main cache_read share of main W %.1f%%  of total W %.1f%%; main out share %.1f%%"
              % (100 * x["main_cr"] / x["main"], 100 * x["main_cr"] / tot, 100 * x["main_out"] / x["main"]))
        allcr = sum(x[b + "_cr"] for b in LEGACY_BUCKETS)
        print("  all cache_read share of total W %.1f%%" % (100 * allcr / tot))
        t = turns[k]
        print("  turns", t, "question %.0f%%" % (100 * t[1] / max(t[0], 1)), "human msgs", hum[k],
              dict(nud[k]), "per100 turns", {n: round(100 * c / max(t[0], 1), 1) for n, c in nud[k].items()})


# ------------------------------------------------------- composition/models/reach
def scan(root, lo, hi):
    """One pass over every transcript. Returns (agents, first_seen).

    agents: one record per transcript with at least one message in [lo, hi].
    first_seen: model -> {kind: earliest timestamp}, over ALL dates, not just the window.
    """
    agents = []
    first_seen = collections.defaultdict(dict)
    for p, kind, sid, agent_type in transcripts(root):
        msgs = {}
        order = []
        prompts = []
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
            if t == "user" and len(prompts) < 2:
                prompts.append(text_of((j.get("message") or {}).get("content", "")))
            if t != "assistant":
                continue
            m = j.get("message", {})
            ts, mid, model = j.get("timestamp", ""), m.get("id"), m.get("model")
            if model and model != "<synthetic>" and ts:
                fs = first_seen[model]
                if kind not in fs or ts < fs[kind]:
                    fs[kind] = ts
            if not (lo <= ts[:10] <= hi) or not mid or not m.get("usage"):
                continue
            rec = msgs.get(mid)
            if rec is None:
                rec = msgs[mid] = {"ts": ts, "usage": m["usage"], "model": model, "blocks": {}}
                order.append(mid)
            if m["usage"].get("output_tokens", 0) >= rec["usage"].get("output_tokens", 0):
                rec["usage"] = m["usage"]
            for b in m.get("content") or []:
                if isinstance(b, dict):
                    rec["blocks"][json.dumps(b, sort_keys=True)] = b
        if not msgs:
            continue
        # A workflow agent's first turn is the harness relaying the user request; the
        # script's own task text is the second turn.
        prompt = prompts[0] if prompts else ""
        if prompt.startswith("[Workflow harness") and len(prompts) > 1:
            prompt = prompts[1]
        agents.append({"kind": kind, "sid": sid, "type": agent_type, "path": p,
                       "msgs": [msgs[i] for i in order], "prompt": prompt, "flags": flags,
                       "label": meta_label(p)})
    return agents, first_seen


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


def self_test():
    """Synthetic transcripts in a temp dir; asserts dedupe, bucket W and priced totals."""
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
        agents, _ = scan(root, "2026-10-01", "2026-12-01")
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
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", type=Path, default=Path.home() / ".claude" / "projects")
    today = datetime.date.today()

    def ago(days):
        return (today - datetime.timedelta(days=days)).isoformat()

    # Defaults: the last 30 days, split into the last week ("new") and the 23 days before it.
    ap.add_argument("--base", nargs=2, default=(ago(30), ago(8)), metavar=("FROM", "TO"))
    ap.add_argument("--new", nargs=2, default=(ago(7), ago(0)), metavar=("FROM", "TO"))
    ap.add_argument("--from", dest="lo", default=ago(30), help="window start (composition, models, reach)")
    ap.add_argument("--to", dest="hi", default=ago(0), help="window end, inclusive")
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--sections", default="legacy,composition,models,priced,reach")
    ap.add_argument("--self-test", action="store_true", help="run built-in synthetic-data asserts and exit")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    want = set(a.sections.split(","))
    if "legacy" in want:
        legacy(a.root, {"base": tuple(a.base), "new": tuple(a.new)})
    if want & {"composition", "models", "priced", "reach"}:
        print("\n== window %s .. %s" % (a.lo, a.hi))
        agents, first_seen = scan(a.root, a.lo, a.hi)
        prepare(agents)
        if "composition" in want:
            composition(agents)
        if "models" in want:
            models(agents, first_seen, a.top)
        if "priced" in want:
            priced(agents, {"window": (a.lo, a.hi), "base": tuple(a.base), "new": tuple(a.new)})
        if "reach" in want:
            reach(agents)


if __name__ == "__main__":
    main()
