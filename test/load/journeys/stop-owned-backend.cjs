'use strict';

// Only for child handles created by Resources. Shutdown first drains workers,
// then gives tracking sockets a 10s reconnect window. This is not a load gate.
function stopOwnedBackend(child, graceMs = 30000, killWaitMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let timer, forced = false;
    const finish = error => {
      clearTimeout(timer); child.off('exit', exited);
      if (error) reject(error); else resolve(forced ? 'backend forced stop' : null);
    };
    const exited = () => finish();
    child.once('exit', exited);
    timer = setTimeout(() => {
      forced = true;
      timer = setTimeout(() => finish(new Error('Owned backend did not exit after forced stop')), killWaitMs);
      try { child.kill('SIGKILL'); } catch (error) { finish(error); }
    }, graceMs);
    try {
      if (child.connected) child.send({ type: 'stop' }, () => {});
      else child.kill();
    } catch (error) { finish(error); }
  });
}
module.exports = { stopOwnedBackend };
