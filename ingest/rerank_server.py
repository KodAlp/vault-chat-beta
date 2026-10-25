"""Cross-encoder reranker server (chat retrieval and the RAG benchmark).

Loads BAAI/bge-reranker-v2-m3 once and scores (query, passage) pairs sent as
JSON lines on stdin, writing one JSON line per response to stdout. Meant to be
spawned once and kept warm across many rerank() calls, since model load
(safetensors, ~2.3 GB) dominates any single request's cost. Clients:
src/lib/server/reranker.ts (the app).

Protocol:
  stdin  {"id": "...", "query": "...", "passages": ["...", ...]}
         {"cmd": "stats"}
  stdout {"id": "...", "scores": [0.0, ...], "ms": 12.3}
         {"peak_vram_mb": ..., "rss_mb": ..., "device": "...", "dtype": "...", "revision": "..."}
         {"id": "...", "error": "..."}   (never crashes the loop)

The very first line on stdout, before anything else, is {"ready": true, "load_ms": ...}.
All logging goes to stderr so stdout stays pure protocol.

--require-cuda makes startup fail ({"error": "cuda-unavailable"}, exit code 3) instead of
quietly falling back to the CPU, which is far too slow for chat.

Other modes (one JSON line on stdout, then exit):
  --probe          {"ok": true, "cuda": bool} (or {"ok": false, "error": ...} when
                   torch/transformers are not importable). Loads no model.
  --download-only  fetches the pinned model into the cache, prints {"downloaded": true}.

The model cache is the Hugging Face cache; the app points it at <dataDir>/models/hf
through HF_HOME. --offline (HF_HUB_OFFLINE=1) forbids any network access: the chat
path always runs offline so a missing model fails fast instead of starting a
multi-GB download in the middle of a conversation.
"""
import argparse
import json
import os
import sys
import time

MODEL_NAME = "BAAI/bge-reranker-v2-m3"
# Pinned commit sha for BAAI/bge-reranker-v2-m3, looked up via a read-only GET
# to https://huggingface.co/api/models/BAAI/bge-reranker-v2-m3 on 2026-09-26.
# Pinning (rather than "main") means a benchmark run is reproducible even if
# the model repo changes later.
MODEL_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--dtype", choices=["fp16", "fp32"], default="fp16")
    p.add_argument("--max-length", type=int, default=512)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--require-cuda", action="store_true", help="exit with an error instead of falling back to cpu")
    p.add_argument("--offline", action="store_true", help="never touch the network (HF_HUB_OFFLINE=1)")
    p.add_argument("--download-only", action="store_true", help="fetch the model into the cache and exit")
    p.add_argument("--probe", action="store_true", help="report whether torch and CUDA work, then exit")
    return p.parse_args()


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def probe() -> None:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except Exception as err:  # ImportError, or a broken CUDA runtime DLL
        emit({"ok": False, "error": str(err)})
        return
    emit({"ok": True, "cuda": bool(torch.cuda.is_available())})


def download_only() -> None:
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        MODEL_NAME,
        revision=MODEL_REVISION,
        allow_patterns=["*.json", "*.model", "*.txt", "model.safetensors", "sentencepiece*", "tokenizer*"],
    )
    log(f"downloaded to {path}")
    emit({"downloaded": True})


def serve(args: argparse.Namespace) -> None:
    import psutil
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    process = psutil.Process()
    device = args.device
    if device == "cuda" and not torch.cuda.is_available() and args.require_cuda:
        # CPU scoring takes 9-22 s for 30 candidates (measured): unusable in chat, so say so and stop.
        emit({"error": "cuda-unavailable"})
        sys.exit(3)
    if device == "cuda" and not torch.cuda.is_available():
        log("cuda requested but torch.cuda.is_available() is False — falling back to cpu")
        device = "cpu"
    dtype = args.dtype
    if device == "cpu" and dtype == "fp16":
        log("fp16 on cpu is not supported — forcing fp32")
        dtype = "fp32"
    torch_dtype = torch.float16 if dtype == "fp16" else torch.float32

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_NAME, revision=MODEL_REVISION, trust_remote_code=False
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        revision=MODEL_REVISION,
        trust_remote_code=False,
        use_safetensors=True,
        torch_dtype=torch_dtype,
    )
    model.to(device)
    model.eval()
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    load_ms = (time.time() - t0) * 1000

    print(json.dumps({"ready": True, "load_ms": load_ms, "device": device}), flush=True)
    log(f"bge-reranker-v2-m3 loaded on {device}/{dtype} in {load_ms:.0f} ms (revision {MODEL_REVISION})")

    # The Node client writes UTF-8; on Windows sys.stdin defaults to the ANSI
    # codepage (cp1254 here), which silently mangled Turkish queries
    # ("düğüm" -> mojibake) and cost them several logits of relevance.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as err:  # malformed line — nothing to reply to, log and skip
            log(f"malformed request line, skipping: {err}")
            continue

        if req.get("cmd") == "stats":
            peak_vram_mb = (
                torch.cuda.max_memory_allocated() / (1024 * 1024) if device == "cuda" else 0.0
            )
            rss_mb = process.memory_info().rss / (1024 * 1024)
            print(
                json.dumps(
                    {
                        "peak_vram_mb": peak_vram_mb,
                        "rss_mb": rss_mb,
                        "device": device,
                        "dtype": dtype,
                        "revision": MODEL_REVISION,
                    }
                ),
                flush=True,
            )
            continue

        req_id = req.get("id")
        try:
            query = req["query"]
            passages = req["passages"]
            if not isinstance(passages, list):
                raise ValueError("passages must be a list of strings")

            t_start = time.time()
            scores: list[float] = []
            with torch.no_grad():
                for i in range(0, len(passages), args.batch_size):
                    batch = passages[i : i + args.batch_size]
                    pairs = [[query, p] for p in batch]
                    inputs = tokenizer(
                        pairs,
                        padding=True,
                        truncation=True,
                        max_length=args.max_length,
                        return_tensors="pt",
                    ).to(device)
                    logits = model(**inputs).logits.view(-1).float()
                    batch_scores = torch.sigmoid(logits).cpu().tolist()
                    scores.extend(batch_scores)
            ms = (time.time() - t_start) * 1000
            print(json.dumps({"id": req_id, "scores": scores, "ms": ms}), flush=True)
        except Exception as err:
            log(f"request {req_id} failed: {err}")
            print(json.dumps({"id": req_id, "error": str(err)}), flush=True)


def main() -> None:
    args = parse_args()
    # Must be set before huggingface_hub / transformers are imported (they read it at import time).
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    if args.probe:
        probe()
    elif args.download_only:
        download_only()
    else:
        serve(args)


if __name__ == "__main__":
    main()
