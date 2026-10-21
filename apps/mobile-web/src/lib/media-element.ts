// One <video> element for every playback, unlocked at the first touch in the app. iOS lets a page start sound only
// from a user's gesture, element by element; the player page loads on demand and its stream opens after network
// round trips, long after the Play tap. A load() during any early tap lifts the restriction for this element for
// good, so playback can start whenever the stream is ready.
export const video: HTMLVideoElement = (() => {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.className = 'app-video';
  return v;
})();

export function unlockOnFirstTouch(): void {
  const unlock = () => {
    window.removeEventListener('pointerup', unlock, true);
    window.removeEventListener('touchend', unlock, true);
    if (!video.src && !video.srcObject) video.load();
  };
  window.addEventListener('pointerup', unlock, true);
  window.addEventListener('touchend', unlock, true);
}
