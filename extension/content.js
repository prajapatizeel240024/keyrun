// Bridge between the shared recorder (recorder.js, identical to src/recorder/inject.js) and the
// extension's background worker. The background decides whether this tab is being recorded.
window.__keyrunSend = function (evt) {
  try {
    chrome.runtime.sendMessage({ type: 'keyrun:event', evt: evt }).catch(function () {});
  } catch (e) {
    /* extension reloaded */
  }
};
