/**
 * Sort, filter and grouping for one table (SORT-01..06, HIER-08): the view
 * commands, the Worker-backed projection, the header ▼ menu with its filter
 * panel, the category band, and `SortPanel` for the Organize inspector.
 */
export {
  createSortCommands,
  describeFilter,
  useSortCommands,
  type SortCommands,
} from './commands.js';
export {
  useTableProjection,
  sharedProjector,
  setSharedProjectorForTests,
  type TableProjection,
} from './useTableProjection.js';
export { createViewProjector, type ProjectResult, type ViewProjector } from './view-client.js';
export {
  ariaSortOf,
  FilterForm,
  HeaderMenu,
  headerGlyphs,
  sortModeOf,
  type HeaderGlyph,
} from './HeaderMenu.js';
export { GroupBand } from './GroupBand.js';
export { SortPanel, type SortPanelProps } from './SortPanel.js';
