import json
import logging
from pathlib import Path
from typing import Any, List, Dict

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

_cache: Dict[str, List[Dict[str, str]]] = {}


def _load_aime() -> List[Dict[str, str]]:
    from datasets import load_dataset
    samples = []
    for repo in ("Maxwell-Jia/AIME_2024", "Maxwell-Jia/AIME_2025"):
        try:
            ds = load_dataset(repo, split="train")
            for row in ds:
                samples.append({"question": row["Problem"], "answer": str(row["Answer"])})
        except Exception as e:
            logger.warning(f"Could not load {repo}: {e}")
    return samples


def _load_hotpot() -> List[Dict[str, str]]:
    from datasets import load_dataset
    ds = load_dataset("hotpotqa/hotpot_qa", "distractor", split="validation")
    return [{"question": row["question"], "answer": row["answer"]} for row in ds]


def _decrypt(ciphertext_b64: str, password: str) -> str:
    import base64, hashlib
    encrypted = base64.b64decode(ciphertext_b64)
    digest = hashlib.sha256(password.encode()).digest()
    key = (digest * (len(encrypted) // len(digest) + 1))[:len(encrypted)]
    return bytes(a ^ b for a, b in zip(encrypted, key)).decode()


def _load_browsecomp() -> List[Dict[str, str]]:
    from datasets import load_dataset
    ds = load_dataset("openai/BrowseCompLongContext", split="train")
    samples = []
    for row in ds:
        try:
            canary = row["canary"]
            samples.append({
                "question": _decrypt(row["problem"], canary),
                "answer": _decrypt(row["answer"], canary),
            })
        except Exception as e:
            logger.warning(f"Failed to decrypt BrowseComp row: {e}")
    return samples


# Salesforce/MASBench ships 6 reasoning families (axes) — breadth /
# combine / depth / horizon / parallel / robustness — each with its
# own subset. Every row already carries an ``axis`` column and (for 5
# of the 6 subsets) a ``value`` column that bins rows by complexity
# (e.g. depth=10/12, horizon=2/10/18). For ``combine`` the bin lives
# inside ``extra_info_json.depth`` instead, so we fall back to that.
# We surface both as searchable facets on the picker rather than as
# inline ``[axis]`` prefixes so the user can scan questions cleanly.
_MASBENCH_REPO = "Salesforce/MASBench"
_MASBENCH_SUBSETS = ("breadth", "combine", "depth", "horizon", "parallel", "robustness")


def _masbench_extract_question(row: Dict[str, Any]) -> str:
    """Pull the user-visible prompt out of a MASBench row.

    Prefers ``prompt_json`` (list of {role, content} messages), falling
    back to the matching field inside ``data`` (the full original
    payload) when prompt_json is missing or malformed. Returns ``""`` if
    nothing usable is found — the caller will drop the row.
    """
    for key in ("prompt_json", "prompt"):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            msgs = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            continue
        if isinstance(msgs, list):
            for m in msgs:
                if isinstance(m, dict) and m.get("role") == "user" and m.get("content"):
                    return str(m["content"]).strip()
            if msgs and isinstance(msgs[-1], dict) and msgs[-1].get("content"):
                return str(msgs[-1]["content"]).strip()
    data_blob = row.get("data")
    if isinstance(data_blob, str):
        try:
            data = json.loads(data_blob)
        except Exception:
            data = None
        if isinstance(data, dict):
            prompt = data.get("prompt")
            if isinstance(prompt, list):
                for m in prompt:
                    if isinstance(m, dict) and m.get("role") == "user" and m.get("content"):
                        return str(m["content"]).strip()
    return ""


def _masbench_extract_answer(row: Dict[str, Any]) -> str:
    """Pull the ground-truth answer string out of a MASBench row."""
    raw = row.get("reward_model_json")
    if raw is not None:
        try:
            obj = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            obj = None
        if isinstance(obj, dict) and obj.get("ground_truth") is not None:
            return str(obj["ground_truth"]).strip()
    extra = row.get("extra_info_json")
    if extra is not None:
        try:
            obj = json.loads(extra) if isinstance(extra, str) else extra
        except Exception:
            obj = None
        if isinstance(obj, dict) and obj.get("answer") is not None:
            return str(obj["answer"]).strip()
    return ""


def _masbench_extract_complexity(row: Dict[str, Any], subset: str) -> str:
    """Per-row complexity bin used by the picker's complexity selector.

    Most subsets carry a ``value`` column (e.g. ``"10"``); ``combine``
    doesn't, so we derive its bucket from ``extra_info_json.depth``.
    Returns ``""`` when no signal is available — those rows fall under
    the "Any" complexity bucket in the picker.
    """
    val = row.get("value")
    if val is not None and str(val).strip():
        return str(val).strip()
    if subset == "combine":
        extra = row.get("extra_info_json")
        try:
            obj = json.loads(extra) if isinstance(extra, str) else extra
        except Exception:
            obj = None
        if isinstance(obj, dict):
            d = obj.get("depth")
            if d is not None:
                return str(d).strip()
    return ""


def _load_masbench() -> List[Dict[str, str]]:
    from datasets import load_dataset
    samples: List[Dict[str, str]] = []
    for subset in _MASBENCH_SUBSETS:
        ds = None
        for split in ("test", "train"):
            try:
                ds = load_dataset(_MASBENCH_REPO, subset, split=split)
                break
            except Exception as e:
                logger.warning(f"Could not load MASBench[{subset}, {split}]: {e}")
        if ds is None:
            continue
        for row in ds:
            question = _masbench_extract_question(row)
            answer = _masbench_extract_answer(row)
            if not question:
                continue
            axis = str(row.get("axis") or subset).strip().lower()
            complexity = _masbench_extract_complexity(row, subset)
            samples.append({
                "question": question,
                "answer": answer,
                "axis": axis,
                "complexity": complexity,
            })
    return samples


_LOADERS = {
    "aime": _load_aime,
    "hotpot": _load_hotpot,
    "browsecomp": _load_browsecomp,
    "masbench": _load_masbench,
}


def get_samples(dataset: str) -> List[Dict[str, str]]:
    if dataset in _cache:
        return _cache[dataset]

    cache_path = DATA_DIR / f"{dataset}.json"
    if cache_path.exists():
        _cache[dataset] = json.loads(cache_path.read_text())
        return _cache[dataset]

    loader = _LOADERS.get(dataset)
    if not loader:
        return []

    samples = loader()
    cache_path.write_text(json.dumps(samples, ensure_ascii=False))
    _cache[dataset] = samples
    return samples
