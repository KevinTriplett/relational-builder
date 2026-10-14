import { BUILD_DAY_CARD_SUMMARY } from '@/knowledge/build-day';
import { startFromCommonsItem } from '@/project/start-from-commons';

/**
 * The one door into the community build day journey: the featured gallery
 * card's "Build yours", the /buildday address the public build day page
 * links to, and anywhere else that wants to start an organizer off. Same
 * as remixing the card from the gallery — the build-day frame is stamped
 * into lineage and the organizer's four-stage conversation opens.
 */
export async function startBuildDay(): Promise<void> {
  await startFromCommonsItem(BUILD_DAY_CARD_SUMMARY);
}
