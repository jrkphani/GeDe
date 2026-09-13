/**
 * Context graphs for the document route (GRAPH-01..11, INSP-08, REF-05).
 *
 *   useGraphs(...)            viewer state (selected graph, pointing, hover) and every command
 *   <GraphLayer/>             the ring and coverage pairs inside the canvas layer, plus pointing targets
 *   <GraphTab/>               the inspector's Graph tab body, mounted into `InspectorSlots.graph`
 *
 * Derivation, layouts and mutations are `@gede/core`'s (`graph/`); nothing here reimplements them.
 */
export { GraphLayer, type GraphLayerProps } from './GraphLayer.js';
export { GraphTab, type GraphTabProps } from './GraphTab.js';
export { RingGraph, dimensionColourVar, type RingGraphProps } from './RingGraph.js';
export { CoverageGraph, type CoverageGraphProps } from './CoverageGraph.js';
export { GraphObject, UnboundBody, GRAPH_HEADER_PX, type GraphObjectProps } from './GraphObject.js';
export { useGraphModel, type GraphModel } from './use-graph-model.js';
export {
  graphStoreFor,
  hoverFor,
  useGraphHover,
  useGraphLitRows,
  type GraphHover,
} from './store.js';
export {
  useGraphs,
  type Graphs,
  type GraphsActions,
  type GraphsState,
  type Pointing,
} from './use-graphs.js';
