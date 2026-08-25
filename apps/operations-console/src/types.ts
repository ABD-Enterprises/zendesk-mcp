export type QueueMetric = { name: string; count: number };

export type Ticket = {
  id: number;
  subject: string;
  status: string;
  createdAt: string;
  ageDays: number;
  ageBucket: string;
  requestType: string;
  system: string;
  assigneeId: number | null;
  url: string;
};

export type Overview = {
  connected: boolean;
  lastSynced: string;
  accountUrl: string;
  metrics: {
    active: number;
    untriaged: number;
    unassigned: number;
    oldestDays: number;
  };
  aging: QueueMetric[];
  requestTypes: QueueMetric[];
  tickets: Ticket[];
  views: Record<string, string>;
  error?: string;
};

export type Section = "overview" | "intake" | "reports" | "knowledge" | "controls";
