'use strict';

// Offline planning assumptions, not measured throughput or a deploy command.
const { estimate } = require('./capacity-cost.cjs');
const profile = require('../profiles/capacity-175.tfvars.json');
function workload(options = {}) {
  const number = (key, fallback, min = 0) => {
    const value = options[key] ?? fallback;
    if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${key}`);
    return value;
  };
  const count = (key, fallback) => {
    const value = number(key, fallback);
    if (!Number.isInteger(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const activeTrips = count('activeTrips', 1000);
  const availableDrivers = count('availableDrivers', 1000);
  const pendingRequests = count('pendingRequests', 1000);
  const passengersPerTrip = number('passengersPerTrip', 1, 1);
  const gpsIntervalSeconds = number('gpsIntervalSeconds', 5, 1);
  const presenceIntervalSeconds = number('presenceIntervalSeconds', 15, 1);
  const payloadBytes = number('payloadBytes', 512, 1);
  const burstSeconds = number('burstSeconds', 5, 1);
  const reconnectSeconds = number('reconnectSeconds', 10, 1);
  const peakHoursPerDay = number('peakHoursPerDay', 2);
  if (peakHoursPerDay > 24) throw new Error('Invalid peakHoursPerDay');
  const baseLcu = number('baseLcu', 1);
  const poolPerTask = count('poolPerTask', 10);
  const migrationPool = count('migrationPool', 2);
  const operationalConnections = count('operationalConnections', 10);
  const sockets = activeTrips * (1 + passengersPerTrip) + availableDrivers + pendingRequests;
  const gpsPerSecond = activeTrips / gpsIntervalSeconds;
  const presencePerSecond = availableDrivers / presenceIntervalSeconds;
  const outboundPerSecond = gpsPerSecond * passengersPerTrip;
  // Decimal GB follows the ALB published examples; payload includes estimated
  // protocol overhead. Acknowledgements, heartbeats, REST, media and retries are extra.
  const albGbPerHour = (gpsPerSecond + presencePerSecond + outboundPerSecond) * payloadBytes * 3600 / 1e9;
  const outboundGbPerHour = outboundPerSecond * payloadBytes * 3600 / 1e9;
  const activeConnectionLcu = sockets / 3000;
  const peakLcuLowerBound = Math.max(activeConnectionLcu, albGbPerHour);
  const averageLcu = (Math.max(baseLcu, peakLcuLowerBound) * peakHoursPerDay + baseLcu * (24 - peakHoursPerDay)) / 24;
  const rollingTasks = Math.floor(profile.ecs_desired_count * profile.ecs_deployment_maximum_percent / 100);
  return {
    assumptions: { activeTrips, availableDrivers, pendingRequests, passengersPerTrip,
      gpsIntervalSeconds, presenceIntervalSeconds, payloadBytes, burstSeconds, peakHoursPerDay,
      poolPerTask, migrationPool, operationalConnections },
    sockets, gpsPerSecond, presencePerSecond, outboundPerSecond,
    requestArrivalsPerSecond: pendingRequests / burstSeconds,
    reconnectsPerSecondDuringIncident: sockets / reconnectSeconds,
    // An isolated reconnect burst is NOT a sustained hourly LCU charge.
    alb: { activeConnectionLcu, processedGbPerPeakHour: albGbPerHour,
      peakLcuLowerBound, monthlyAverageLcuAssumption: averageLcu },
    peakOnlyMonthlyOutboundGb: outboundGbPerHour * peakHoursPerDay * 31,
    connections: { steady: profile.ecs_desired_count * poolPerTask,
      rolling: rollingTasks * poolPerTask,
      requiredWithMigrationAndOperations: rollingTasks * poolPerTask + migrationPool + operationalConnections },
    illustrativeCost: estimate({ lcu: averageLcu }),
    capacityValidated: false,
    warning: 'Assumptions only. GPS traffic excludes other API traffic, retries, media and heartbeat overhead. Outbound transfer is not separately priced: verify the cost allowance. SQL connection budget is not a database capacity measurement. No AWS deployment.',
  };
}
if (require.main === module) {
  console.log(JSON.stringify({ shortDailyPeak: workload(), continuousPeak: workload({ peakHoursPerDay: 24 }),
    continuousLargerMessages: workload({ peakHoursPerDay: 24, payloadBytes: 2048 }) }, null, 2));
}
module.exports = { workload };
