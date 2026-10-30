export type SpeechState = "waiting" | "speaking" | "speech" | "speech_limit";

/** Wait indefinitely; the 15 second cap begins only after voice onset. */
export class SpeechGate {
  state: SpeechState = "waiting";
  spoken = false;
  private lastVoice = 0;
  private speechStarted: number | null = null;
  constructor(private threshold: number) {}
  feed(rms: number, now: number): SpeechState {
    if (this.state === "speech" || this.state === "speech_limit") return this.state;
    if (rms > this.threshold) {
      if (this.speechStarted === null) this.speechStarted = now;
      this.spoken = true;
      this.lastVoice = now;
    }
    if (!this.spoken) this.state = "waiting";
    else if (now - this.lastVoice >= 600) this.state = "speech";
    else if (now - this.speechStarted! >= 15000) this.state = "speech_limit";
    else this.state = "speaking";
    return this.state;
  }
}
