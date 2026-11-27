'use strict';
const { performance } = require('node:perf_hooks');
const PHASES = ['load_dependencies', 'initialize_database', 'compile_nest', 'connect_redis', 'listen', 'ready'];

// Six bounded numeric records per process, including the point before loading
// Nest/TypeORM. Never log environment variables, config, queries or credentials.
function bootstrapDiagnostics(write = row => console.log(JSON.stringify(row))) {
  const started = performance.now(), initialCpu = process.cpuUsage();
  let previous = -1;
  return phase => {
    const index = PHASES.indexOf(phase);
    if (index < 0 || index <= previous) throw new Error('Invalid bootstrap phase');
    previous = index;
    const cpu = process.cpuUsage(initialCpu);
    write({ marker: 'journey_bootstrap', phase, elapsedMs: performance.now() - started,
      cpuMs: (cpu.user + cpu.system) / 1000, rssMiB: process.memoryUsage().rss / 2 ** 20 });
  };
}
module.exports = { bootstrapDiagnostics };
