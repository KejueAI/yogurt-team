import type { YogurtTeamApi } from '../../../main/team/types'

declare global {
  /** Yogurt Team's bridge (preload/team.ts); upstream's window.yogurt is untouched */
  interface Window { yogurtTeam: YogurtTeamApi }
}
