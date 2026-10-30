/** Finish recording, inference and cleanup before listening for another utterance. */
export async function runVoiceLoop(isActive: () => boolean, round: () => Promise<void>): Promise<void> {
  while (isActive()) await round();
}
