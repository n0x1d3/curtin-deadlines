/** Minimal dependencies that can't be imported — passed from renderDeadlines. */
export interface CardDeps {
  expandedSeries: Set<string>; // module-level state, read+write
  onRerender: () => Promise<void>; // renderDeadlines callback
  now: Date; // consistent timestamp per render pass
}
