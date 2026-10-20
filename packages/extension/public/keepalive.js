/**
 * Keeps the extension's service worker awake while the panel is open.
 *
 * Manifest V3 puts the worker to sleep when it goes idle, and a sleeping
 * worker stops answering the daemon's heartbeat. The daemon then decides the
 * browser has gone away, drops the socket, and any command that was in flight
 * fails — which looks like "the agent randomly can't reach the browser".
 *
 * An extension page that talks to the worker resets that idle timer, so the
 * panel quietly pings every twenty seconds for as long as it is docked.
 */
(function keepWorkerAwake() {
  var INTERVAL_MS = 20000;

  function tick() {
    try {
      chrome.runtime.sendMessage({ type: 'celeste:ping' }, function () {
        // Reading lastError keeps Chrome from logging "Unchecked runtime.lastError"
        // while the worker is starting up or the extension is reloading.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // The extension context can be torn down mid-reload; the next tick is a
      // fresh attempt.
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
})();
