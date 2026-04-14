# MAS-Orchestra Demo

Interactive visualization of the MAS-Orchestra pipeline. A fine-tuned meta-agent generates a multi-agent DAG from a problem, sub-agents execute in parallel where possible, and results stream live to the UI.

## Stack

- **Backend**: FastAPI + SSE, Python 3.10+
- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS + React Flow

## Quick Start

**Backend:**
```bash
cd demo/backend
pip install -r requirements.txt
cp .env.example .env  # add OPENAI_API_KEY
uvicorn app.main:app --reload --port 8000
```

**Frontend:**
```bash
cd demo/frontend
npm install
npm run dev  # http://localhost:3000
```

## Configuration

| Env var | Description |
|---|---|
| `OPENAI_API_KEY` | Used for sub-agent execution |
| `VLLM_BASE_URL` | vLLM endpoint serving the orchestrator models (defaults to the ngrok URL in metaagent.py) |

## Datasets

| Dataset | DoM | Orchestrator model |
|---|---|---|
| AIME 2024/2025 | Low (≤1 agent) | `math` |
| HotpotQA | High (multi-agent) | `hotpotqa` |
| BrowseComp | High (multi-agent) | `browsecomp` |

## API

`POST /plan` — calls the meta-agent, returns agent graph + raw XML

`POST /execute` — streams SSE events as agents run:
- `agent_start` — agent began
- `agent_complete` — agent finished with output
- `agent_error` — agent failed (execution continues with fallback)
- `final_answer` — pipeline done

`GET /dataset/{name}?page=0&page_size=10` — paginated dataset samples
