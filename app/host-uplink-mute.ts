// Host uplink mute (sidetone): while a non-native face holds the lease,
// the Electron host must not advertise OS focus — TCC/activate storms would
// yank via lease rule 2. Cleared only on trusted user-present at THIS window.
export class HostUplinkMute {
  private muted = false;

  get isMuted(): boolean {
    return this.muted;
  }

  /** Lease moved: mute when terminal is not on native. */
  onLease(owner: DogshOwner): void {
    this.muted = owner !== 'native';
  }

  /** Trusted local presence (veil click / keydown in renderer). */
  clear(why: string): boolean {
    if (!this.muted) return false;
    this.muted = false;
    void why;
    return true;
  }

  /** Focus to report upstream: false while muted even if OS focused. */
  reportFocused(realFocused: boolean): boolean {
    return this.muted ? false : realFocused;
  }
}
