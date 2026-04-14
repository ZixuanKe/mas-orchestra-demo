import json
import logging
from pathlib import Path
from typing import List, Dict

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


_LOADERS = {
    "aime": _load_aime,
    "hotpot": _load_hotpot,
    "browsecomp": _load_browsecomp,
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
