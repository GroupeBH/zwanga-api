export const FIELD_STAGES = ['CONTACTED', 'REGISTERED', 'ONBOARDING', 'KYC_PENDING', 'KYC_REJECTED', 'KYC_APPROVED', 'READY_TO_DRIVE', 'FIRST_TRIP'] as const;
type Lead = { agentId: string; status: string; createdAt: Date; firstTripAt: Date | null };
// Reuse ICU formatting while scanning batches; do not construct one formatter
// per lead/date in a potentially large organization.
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (date: Date) => dayFormatter.format(date);
const addDays = (date: string, days: number) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const week = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
export function fieldSummaryAccumulator(userId: string, now = new Date()) {
  const period = day(now).slice(0, 7);
  const stages = { contacted: 0, registered: 0, kycApproved: 0, readyToDrive: 0, firstTrip: 0 };
  const byStatus = Object.fromEntries(FIELD_STAGES.map(status => [status, 0]));
  const byAgent = new Map<string, { agentId: string; inProgress: number; firstTrip: number }>();
  const weeks = new Map(Array.from({ length: 8 }, (_, i) => [addDays(week(day(now)), (i - 7) * 7), 0]));
  let achieved = 0;
  return {
    add(lead: Lead) {
      byStatus[lead.status] = (byStatus[lead.status] ?? 0) + 1;
      const agent = byAgent.get(lead.agentId) ?? { agentId: lead.agentId, inProgress: 0, firstTrip: 0 };
      if (lead.status === 'FIRST_TRIP') agent.firstTrip++; else agent.inProgress++;
      byAgent.set(lead.agentId, agent);
      if (lead.agentId !== userId) return;
      stages.contacted++;
      if (lead.status !== 'CONTACTED') stages.registered++;
      if (['KYC_APPROVED', 'READY_TO_DRIVE', 'FIRST_TRIP'].includes(lead.status)) stages.kycApproved++;
      if (['READY_TO_DRIVE', 'FIRST_TRIP'].includes(lead.status)) stages.readyToDrive++;
      if (lead.status === 'FIRST_TRIP') stages.firstTrip++;
      const start = week(day(new Date(lead.createdAt)));
      if (weeks.has(start)) weeks.set(start, weeks.get(start)! + 1);
      if (lead.firstTripAt && new Date(lead.firstTripAt) >= new Date(lead.createdAt) && day(new Date(lead.firstTripAt)).startsWith(period)) achieved++;
    },
    result() {
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      return { period, achieved, total, counts: { all: total, done: byStatus.FIRST_TRIP, progress: total - byStatus.FIRST_TRIP },
        byStatus: FIELD_STAGES.map(status => ({ status, count: byStatus[status] })),
        byAgent: [...byAgent.values()], mine: { stages, weeks: [...weeks].map(([start, count]) => ({ start, count })) } };
    },
  };
}
