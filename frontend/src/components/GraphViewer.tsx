import { useMemo, useState, useCallback } from "react";
import { ReactFlow, Node, Edge as FlowEdge, Background, Controls, MiniMap, MarkerType, Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph, AgentState, AgentType } from "../types";

interface Props {
  graph: Graph;
  agentStates: Record<string, AgentState>;
  openAgentId?: string | null;
  onOpenAgentHandled?: () => void;
  hideExpandButton?: boolean;
  showMiniMap?: boolean;
}

const COLORS: Record<AgentType, string> = {
  CoTAgent: "#3b82f6",
  SCAgent: "#7c3aed",
  DebateAgent: "#f59e0b",
  ReflexionAgent: "#10b981",
  WebSearchAgent: "#ef4444",
  CustomAgent: "#ec4899",
};

const STATUS_BORDER: Record<string, string> = {
  pending: "border-gray-300",
  running: "border-amber-400 shadow-md shadow-amber-200/60",
  completed: "border-emerald-400",
  failed: "border-red-400",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-500",
  running: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

function AgentNode({ data }: { data: { label: string; type: AgentType; status: string; selected?: boolean } }) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: "#9ca3af", border: "none", width: 8, height: 8 }} />
      <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[140px] transition-all cursor-pointer
        ${STATUS_BORDER[data.status] || STATUS_BORDER.pending}
        ${data.selected ? "ring-2 ring-blue-500 ring-offset-1" : ""}
      `}>
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

const ExpandIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <path d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export function GraphViewer({ graph, agentStates, openAgentId, onOpenAgentHandled, hideExpandButton, showMiniMap }: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (openAgentId && (!fullscreen || selectedAgent !== openAgentId)) {
    setFullscreen(true);
    setSelectedAgent(openAgentId);
    onOpenAgentHandled?.();
  }

  const toggleFullscreen = useCallback(() => {
    setFullscreen(f => !f);
    if (fullscreen) setSelectedAgent(null);
  }, [fullscreen]);

  const agentMap = useMemo(() => new Map(graph.agents.map(a => [a.id, a])), [graph.agents]);

  const { nodes, edges } = useMemo(() => {
    const layers: string[][] = [];
    const placed = new Set<string>();

    while (placed.size < graph.agents.length) {
      const layer = graph.agents
        .filter(a => !placed.has(a.id) && a.depends_on.every(d => placed.has(d)))
        .map(a => a.id);
      if (!layer.length) {
        // Unplaceable agents (broken deps) — force them into a final layer
        const remaining = graph.agents.filter(a => !placed.has(a.id)).map(a => a.id);
        if (remaining.length) {
          remaining.forEach(id => placed.add(id));
          layers.push(remaining);
        }
        break;
      }
      layer.forEach(id => placed.add(id));
      layers.push(layer);
    }

    const nodes: Node[] = [];
    const xSpacing = 220, ySpacing = 140;

    layers.forEach((layer, y) => {
      const startX = -layer.length * xSpacing / 2 + xSpacing / 2;
      layer.forEach((id, x) => {
        const agent = agentMap.get(id)!;
        nodes.push({
          id,
          type: "agent",
          position: { x: startX + x * xSpacing, y: y * ySpacing },
          data: {
            label: id,
            type: agent.type,
            status: agentStates[id]?.status || "pending",
            selected: id === selectedAgent,
          },
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
  }, [graph, agentStates, agentMap, selectedAgent]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedAgent(prev => prev === node.id ? null : node.id);
  }, []);

  const selectedAgentData = selectedAgent ? agentMap.get(selectedAgent) : null;
  const selectedState = selectedAgent ? agentStates[selectedAgent] : null;

  const flowContent = nodes.length === 0 ? (
    <div className="flex items-center justify-center h-full">
      <div className="text-center p-6">
        <svg className="w-10 h-10 mx-auto mb-3 text-amber-400" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" /><path d="M12 15.75h.007v.008H12v-.008z" /></svg>
        <p className="text-sm font-medium text-gray-700">Graph could not be rendered</p>
        <p className="text-xs text-gray-400 mt-1">{graph.agents.length} agents parsed but layout failed — check XML for dependency issues</p>
      </div>
    </div>
  ) : (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      fitView
      minZoom={0.05}
      maxZoom={3}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#e5e7eb" gap={20} />
      <Controls />
      {(fullscreen || showMiniMap) && <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.08)" nodeColor="#6b7280" nodeStrokeColor="#4b5563" nodeStrokeWidth={2} style={{ border: "1px solid #d1d5db", background: "#f3f4f6" }} />}
    </ReactFlow>
  );

  const showDetailPanel = !!(selectedAgent && selectedAgentData && showMiniMap);

  return (
    <div className="relative h-full w-full bg-white flex">
      <div className="flex-1 min-w-0 relative">
        {!hideExpandButton && (
          <button
            onClick={toggleFullscreen}
            className="absolute top-2 right-2 z-10 p-1.5 bg-white border rounded-md shadow-sm hover:bg-gray-50 text-gray-500"
            title="Fullscreen"
          >
            <ExpandIcon />
          </button>
        )}
        {flowContent}
      </div>
      {showDetailPanel && selectedAgentData && (
        <div className="w-[360px] border-l bg-white flex flex-col overflow-hidden flex-none">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
            <div className="flex items-center gap-2 min-w-0">
              <code className="text-sm font-mono font-semibold text-gray-800 truncate">{selectedAgent}</code>
              <span
                className="px-2 py-0.5 text-xs font-medium rounded flex-none"
                style={{ backgroundColor: COLORS[selectedAgentData.type] + "20", color: COLORS[selectedAgentData.type] }}
              >
                {selectedAgentData.type}
              </span>
            </div>
            <button
              onClick={() => setSelectedAgent(null)}
              className="p-1 text-gray-400 hover:text-gray-600 rounded flex-none"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Description</h4>
              <p className="text-sm text-gray-700">{selectedAgentData.description}</p>
            </div>
            {selectedAgentData.input && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Input</h4>
                <pre className="text-xs text-gray-700 bg-gray-50 p-3 rounded-lg whitespace-pre-wrap break-words">{selectedAgentData.input}</pre>
              </div>
            )}
            {selectedAgentData.depends_on.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Dependencies</h4>
                <div className="flex flex-wrap gap-1">
                  {selectedAgentData.depends_on.map(dep => (
                    <button
                      key={dep}
                      onClick={() => setSelectedAgent(dep)}
                      className="px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                    >
                      {dep}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Status</h4>
              <span className={`px-2 py-0.5 text-xs font-medium rounded ${STATUS_BADGE[selectedState?.status || "pending"]}`}>
                {selectedState?.status || "pending"}
              </span>
            </div>
            {selectedState?.status === "running" && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                Processing...
              </div>
            )}
            {selectedState?.output && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Output</h4>
                <div className="text-sm text-gray-700 bg-emerald-50 border border-emerald-200 p-3 rounded-lg whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">
                  {selectedState.output}
                </div>
              </div>
            )}
            {selectedState?.error && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Error</h4>
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-lg">
                  {selectedState.error}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
