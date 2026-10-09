# -*- coding: utf-8 -*-
"""Tests for formula_early_stop.py (döngü kesici + tek yeniden deneme).

    python ingest/formula_early_stop_test.py

Not part of `npm test`. Only CPU, tiny tensors and a fake model: no docling
model is loaded and nothing touches the GPU. The fake `generate` runs the real
transformers StoppingCriteriaList step by step, the way `_sample` does, so the
per-row plumbing (unfinished rows keep going, stopped rows get pad) is tested
end to end. Real-model behaviour (CodeFormulaV2 loop rate, seconds saved) can
only be measured on a GPU run with VC_FORMULA_EARLY_STOP=1 vs 0.
"""
import io
import os
import sys
import types
from contextlib import redirect_stderr
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import formula_early_stop as fes  # noqa: E402
from postprocess import DEGENERATE_RUN, find_degenerate_run  # noqa: E402

EOS, PAD = 2, 0
PLEN = 5
W = fes.WINDOW
PKG = "docling.models.stages.code_formula.code_formula_model"


def loop_row(period, head=(7, 8, 9), n=400):
    unit = [30 + k for k in range(period)]
    return list(head) + (unit * n)[:n]


def clean_row(n=40):
    return [10 + (i * 7) % 23 for i in range(n)] + [EOS]


class FakeModel:
    """generate() replays scripted token rows; `scripts` is one list of
    per-row token lists per expected call."""

    def __init__(self, scripts):
        self.scripts = list(scripts)
        self.calls = []
        self.generation_config = types.SimpleNamespace(eos_token_id=EOS, pad_token_id=PAD)

    def generate(self, **kw):
        self.calls.append(kw)
        rows = self.scripts.pop(0)
        ids = kw["input_ids"]
        assert ids.shape[0] == len(rows), (ids.shape, len(rows))
        crit = kw.get("stopping_criteria")
        done = torch.zeros(ids.shape[0], dtype=torch.bool)
        for t in range(kw["max_new_tokens"]):
            nxt = torch.tensor([PAD if done[i] or t >= len(r) else r[t] for i, r in enumerate(rows)])
            ids = torch.cat([ids, nxt[:, None]], dim=1)
            done = done | (nxt == EOS)
            if crit is not None:
                done = done | crit(ids, None)
            if bool(done.all()) or all(t + 1 >= len(r) for r in rows):
                break
        return ids


def make_inputs(batch):
    return dict(
        input_ids=torch.arange(batch * PLEN).reshape(batch, PLEN) + 100,
        attention_mask=torch.ones(batch, PLEN, dtype=torch.long),
        pixel_values=torch.arange(batch, dtype=torch.float).reshape(batch, 1, 1, 1, 1),
        max_new_tokens=300,
        use_cache=True,
        do_sample=False,
    )


def run(scripts, batch):
    fes.reset_stats()
    m = FakeModel(scripts)
    out = fes.wrap_generate(m.generate, m)(**make_inputs(batch))
    return m, out


def gen_of(out, i):
    row = out[i, PLEN:].tolist()
    while row and row[-1] == PAD:
        row.pop()
    return row


def test_loop_period():
    for p in (1, 2, 3, 4):
        assert fes.loop_period(torch.tensor(loop_row(p))) == p, p
    # legit LaTeX: short repeats followed by other content
    assert fes.loop_period(torch.tensor(([5, 6] * 10) + clean_row(100))) == 0
    assert fes.loop_period(torch.tensor(clean_row(300))) == 0
    # a run shorter than the window does not count
    assert fes.loop_period(torch.tensor([1, 2] * (W // 2 - 1) + [9])) == 0
    assert fes.loop_period(torch.tensor([1, 2, 3])) == 0
    # period 5 is not a "1-4 token group"
    assert fes.loop_period(torch.tensor([1, 2, 3, 4, 5] * 40)) == 0


def test_detector_per_row_and_prompt_excluded():
    det = fes.make_detector(PLEN, [EOS, PAD])
    gen = torch.tensor([loop_row(2, n=W + 4)[: W + 4], clean_row(W + 3)[: W + 4]])
    # a prompt full of one repeated token must not matter: it is sliced off
    prompt = torch.full((2, PLEN), 55)
    res = det(torch.cat([prompt, gen], dim=1), None)
    assert res.tolist() == [True, False], res
    assert det.hit.tolist() == [True, False] and det.stop_len == {0: W + 4}
    # too short to judge: prompt + a few repeated tokens
    det2 = fes.make_detector(PLEN, [EOS, PAD])
    assert not det2(torch.cat([prompt, torch.full((2, 10), 9)], dim=1), None).any()
    # a row that already finished (pad tail) is not a loop
    det3 = fes.make_detector(5, [EOS, PAD])
    assert not det3(torch.tensor([[7] * 5 + [PAD] * W]), None).any()


def test_no_loop_passthrough():
    m, out = run([[clean_row(), clean_row(20), clean_row(5)]], 3)
    assert len(m.calls) == 1 and fes.snapshot()["rows_stopped"] == 0
    assert gen_of(out, 1) == clean_row(20)


def test_rescue_and_order():
    # row 1 loops at first; the retry (that row alone) is clean. Rows 0 and 2 untouched.
    m, out = run([[clean_row(30), loop_row(2), clean_row(50)], [clean_row(33)]], 3)
    assert len(m.calls) == 2
    retry = m.calls[1]
    assert retry["repetition_penalty"] == fes.REPETITION_PENALTY
    assert retry["input_ids"].equal(make_inputs(3)["input_ids"][1:2])
    assert retry["pixel_values"].flatten().tolist() == [1.0] and retry["max_new_tokens"] == 300
    assert "repetition_penalty" not in m.calls[0] and "no_repeat_ngram_size" not in retry
    assert gen_of(out, 0) == clean_row(30) and gen_of(out, 2) == clean_row(50)
    assert gen_of(out, 1) == clean_row(33)
    assert out[:, :PLEN].equal(make_inputs(3)["input_ids"])
    s = fes.snapshot()
    assert (s["rows_stopped"], s["retries"], s["retries_ok"]) == (1, 1, 1) and s["tokens_saved_est"] > 150, s


def test_retry_also_loops_keeps_first_and_warns():
    m, out = run([[loop_row(3), clean_row(10)], [loop_row(1)]], 2)
    s = fes.snapshot()
    assert (s["rows_stopped"], s["retries"], s["retries_ok"]) == (1, 1, 0), s
    assert gen_of(out, 1) == clean_row(10)
    # the first attempt's loop is extended so postprocess still flags it
    text = " ".join(chr(ord("a") + t % 26) for t in gen_of(out, 0))
    assert find_degenerate_run(text) >= 0, "unrescued loop must still trip postprocess"
    assert len(gen_of(out, 0)) > DEGENERATE_RUN * 3


def test_unsliceable_key_skips_retry():
    fes.reset_stats()
    m = FakeModel([[loop_row(1), clean_row(4)]])
    kw = make_inputs(2)
    kw["pixel_values"] = torch.zeros(5, 3)  # batch axis is not 2: cannot slice
    out = fes.wrap_generate(m.generate, m)(**kw)
    s = fes.snapshot()
    assert len(m.calls) == 1 and s["retry_skipped"] == 1 and s["retries"] == 0, s
    assert gen_of(out, 1) == clean_row(4)


def test_env_off():
    os.environ["VC_FORMULA_EARLY_STOP"] = "0"
    try:
        m, out = run([[loop_row(2, n=60), clean_row(5)]], 2)
        assert "stopping_criteria" not in m.calls[0] and fes.snapshot()["rows_stopped"] == 0
        assert fes.install() is False and fes.report() is None
    finally:
        del os.environ["VC_FORMULA_EARLY_STOP"]


def _fake_docling(has_model):
    class CodeFormulaModel:
        def __init__(self):
            if has_model:
                self._model = FakeModel([])

    saved = {}
    parts = PKG.split(".")
    for i in range(1, len(parts) + 1):
        name = ".".join(parts[:i])
        saved[name] = sys.modules.get(name)
        sys.modules[name] = types.ModuleType(name)
    sys.modules[PKG].CodeFormulaModel = CodeFormulaModel
    return CodeFormulaModel, saved


def _restore(saved):
    for name, mod in saved.items():
        if mod is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = mod


def test_install_wraps_generate():
    cls, saved = _fake_docling(True)
    fes._INSTALLED[0] = False
    try:
        assert fes.install() is True and fes.install() is True
        inst = cls()
        assert inst._model._vc_early_stop
        assert inst._model.generate.__qualname__.startswith("wrap_generate")
        assert fes.report() is not None
    finally:
        _restore(saved)
        fes._INSTALLED[0] = False


def test_graceful_fallback():
    # target missing: warns once, never raises, stock behaviour
    saved = {PKG: sys.modules.get(PKG)}
    sys.modules[PKG] = None  # import -> ImportError
    fes._INSTALLED[0] = False
    fes._WARNED[0] = False
    buf = io.StringIO()
    try:
        with redirect_stderr(buf):
            assert fes.install() is False and fes.install() is False
        assert buf.getvalue().count("formula_early_stop:") == 1 and fes.report() is None
    finally:
        _restore(saved)
    # model attribute missing: init still succeeds, nothing wrapped
    cls, saved = _fake_docling(False)
    fes._INSTALLED[0] = False
    try:
        with redirect_stderr(io.StringIO()):
            assert fes.install() is True
            cls()
    finally:
        _restore(saved)
        fes._INSTALLED[0] = False


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
