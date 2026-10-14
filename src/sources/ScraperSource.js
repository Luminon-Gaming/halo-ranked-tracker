import { StatsSource, NotImplementedError } from './StatsSource.js';

/**
 * Deliberately not implemented. Halo Tracker's ToS restricts automated access, and Waypoint
 * leaderboards only list Onyx players, so scraping can't replace the CSR API.
 */
export class ScraperSource extends StatsSource {
  constructor() {
    super();
    throw new NotImplementedError('ScraperSource');
  }
}
