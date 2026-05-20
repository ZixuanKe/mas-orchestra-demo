import re
from .models import Agent, Edge, Graph, AgentType


def extract(text: str, tag: str) -> str:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else ""


def extract_all(text: str, tag: str) -> list[str]:
    return [m.strip() for m in re.findall(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL | re.IGNORECASE)]


def to_agent_type(name: str) -> AgentType:
    types = {
        "cot": AgentType.COT, "cotagent": AgentType.COT,
        "sc": AgentType.SC, "scagent": AgentType.SC,
        "debate": AgentType.DEBATE, "debateagent": AgentType.DEBATE,
        "reflexion": AgentType.REFLEXION, "reflexionagent": AgentType.REFLEXION,
        "websearch": AgentType.WEBSEARCH, "websearchagent": AgentType.WEBSEARCH,
        "custom": AgentType.CUSTOM, "customagent": AgentType.CUSTOM,
        # Enterprise mode agent types. We accept the legacy "tool/ToolAgent"
        # synonyms so older plans still parse.
        "mcp": AgentType.MCP_AGENT, "mcpagent": AgentType.MCP_AGENT,
        "tool": AgentType.MCP_AGENT, "toolagent": AgentType.MCP_AGENT,
        "enterpriseexecutor": AgentType.ENTERPRISE_EXECUTOR,
        "enterpriseexecutoragent": AgentType.ENTERPRISE_EXECUTOR,
        "executoragent": AgentType.ENTERPRISE_EXECUTOR,
    }
    return types.get(name.lower().strip(), AgentType.COT)


def parse_deps(text: str) -> list[str]:
    return re.findall(r"\$\{(\w+)\}", text)


def parse(xml: str, dom_level: str = "high") -> Graph:
    thinking = extract(xml, "thinking")
    answer = extract(xml, "answer")

    has_agent_id = "<agent_id>" in xml.lower()
    has_edges = "<edge>" in xml.lower()

    if dom_level == "low" or (not has_agent_id and not has_edges):
        agent_output_id = extract(xml, "agent_output_id")
        if not agent_output_id or answer != agent_output_id:
            return Graph(agents=[], edges=[], answer_agent="", direct_solution=answer or thinking)
        req = extract(xml, "required_arguments")
        return Graph(
            agents=[Agent(
                id=agent_output_id,
                type=to_agent_type(extract(xml, "agent_name") or "CoTAgent"),
                description=extract(xml, "agent_description"),
                input=extract(req, "agent_input"),
                depends_on=[],
            )],
            edges=[],
            answer_agent=agent_output_id,
            direct_solution=None,
        )

    # First pass: collect all agent IDs
    raw_agents = []
    for block in extract_all(xml, "agent"):
        aid = extract(block, "agent_id")
        if not aid:
            continue
        req = extract(block, "required_arguments")
        inp = extract(req, "agent_input")
        raw_agents.append((aid, block, inp))

    agent_ids = {a[0] for a in raw_agents}

    # Second pass: build agents with deps filtered to real agent IDs only
    agents = []
    for aid, block, inp in raw_agents:
        deps = [d for d in parse_deps(inp) if d in agent_ids]
        # Enterprise mode adds an optional <depends_on>a,b,c</depends_on> and a
        # <tool_name> field per agent. Merge both deps sources.
        explicit_deps = extract(block, "depends_on")
        if explicit_deps:
            for tok in re.split(r"[,\s]+", explicit_deps):
                tok = tok.strip()
                if tok and tok in agent_ids and tok not in deps:
                    deps.append(tok)
        tool_name = extract(block, "tool_name") or None
        agents.append(Agent(
            id=aid,
            type=to_agent_type(extract(block, "agent_name") or extract(block, "agent_type") or "CoTAgent"),
            description=extract(block, "agent_description"),
            input=inp or extract(block, "agent_input"),
            depends_on=deps,
            tool_name=tool_name,
        ))

    edges: list[Edge] = []
    edge_set: set[tuple[str, str]] = set()

    for block in extract_all(xml, "edge"):
        pairs = re.findall(
            r"<from>\s*(.*?)\s*</from>\s*<to>\s*(.*?)\s*</to>",
            block, re.DOTALL | re.IGNORECASE,
        )
        for f, t in pairs:
            f, t = f.strip(), t.strip()
            if f and t and (f, t) not in edge_set:
                edges.append(Edge(source=f, target=t))
                edge_set.add((f, t))

    # Fall back to depends_on inference when no explicit edges exist
    if not edges:
        for agent in agents:
            for dep in agent.depends_on:
                if (dep, agent.id) not in edge_set:
                    edges.append(Edge(source=dep, target=agent.id))
                    edge_set.add((dep, agent.id))

    # Sink = unique node with no outgoing edges (paper Appendix H.2)
    agent_ids = {a.id for a in agents}
    sources = {e.source for e in edges}
    sinks = agent_ids - sources
    sink = next(iter(sinks)) if len(sinks) == 1 else (answer or (agents[-1].id if agents else ""))

    return Graph(agents=agents, edges=edges, answer_agent=sink, direct_solution=None)


def topo_sort(graph: Graph) -> list[str]:
    in_deg = {a.id: 0 for a in graph.agents}
    adj = {a.id: [] for a in graph.agents}

    for e in graph.edges:
        if e.source in adj and e.target in in_deg:
            adj[e.source].append(e.target)
            in_deg[e.target] += 1

    queue = [a for a, d in in_deg.items() if d == 0]
    order = []

    while queue:
        node = queue.pop(0)
        order.append(node)
        for neighbor in adj[node]:
            in_deg[neighbor] -= 1
            if in_deg[neighbor] == 0:
                queue.append(neighbor)

    return order
