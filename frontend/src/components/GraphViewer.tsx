import { useMemo } from "react";
import { ReactFlow, Node, Edge as FlowEdge, Background, Controls, MarkerType, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph, AgentState, AgentType } from "../types";

interface Props {
  graph: Graph;
  agentStates: Record<string, AgentState>;
}

const COLORS: Record<AgentType, string> = {
  CoTAgent: "#3b82f6",
  SCAgent: "#7c3aed",
  DebateAgent: "#f59e0b",
  ReflexionAgent: "#10b981",
  WebSearchAgent: "#ef4444",
};

const STATUS_BORDER: Record<string, string> = {
  pending: "border-gray-300",
  running: "border-amber-400 shadow-md shadow-amber-200/60",
  completed: "border-emerald-400",
  failed: "border-red-400",
};

function AgentNode({ data }: { data: { label: string; type: AgentType; status: string } }) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: "#9ca3af", border: "none", width: 8, height: 8 }} />
      <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[140px] transition-all ${STATUS_BORDER[data.status] || STATUS_BORDER.pending}`}>
        <div className="text-xs font-mono mb-1" style={{ color: COLORS[data.type] }}>{data.type}</div>
        <div className="text-sm font-medium text-gray-800">{data.label}</div>
        {data.status === "running" && (
          <div className="mt-2 flex items-center gap-1.5">
            <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
            <span className="text-xs text-amber-600">Running</span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: "#9ca3af", border: "none", width: 8, height: 8 }} />
    </>
  );
}

const nodeTypes = { agent: AgentNode };

export function GraphViewer({ graph, agentStates }: Props) {
  const { nodes, edges } = useMemo(() => {
    const layers: string[][] = [];
    const placed = new Set<string>();
    const agentMap = new Map(graph.agents.map(a => [a.id, a]));

    while (placed.size < graph.agents.length) {
      const layer = graph.agents
        .filter(a => !placed.has(a.id) && a.depends_on.every(d => placed.has(d)))
        .map(a => a.id);
      if (!layer.length) break;
      layer.forEach(id => placed.add(id));
      layers.push(layer);
    }

    const nodes: Node[] = [];
    const xSpacing = 200, ySpacing = 120;

    layers.forEach((layer, y) => {
      const startX = -layer.length * xSpacing / 2 + xSpacing / 2;
      layer.forEach((id, x) => {
        const agent = agentMap.get(id)!;
        nodes.push({
          id,
          type: "agent",
          position: { x: startX + x * xSpacing, y: y * ySpacing },
          data: { label: id, type: agent.type, status: agentStates[id]?.status || "pending" },
        });
      });
    });

    const edges: FlowEdge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#9ca3af", width: 14, height: 14 },
      style: { stroke: "#9ca3af", strokeWidth: 1.5 },
      animated: agentStates[e.target]?.status === "running",
    }));

    return { nodes, edges };
  }, [graph, agentStates]);

  return (
    <div className="h-[400px] bg-white rounded-lg border border-gray-200 shadow-sm">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}>
        <Background color="#e5e7eb" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
