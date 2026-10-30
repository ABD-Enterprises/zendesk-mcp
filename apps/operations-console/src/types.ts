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
  brandId: string;
  metrics: {
    active: number;
    untriaged: number;
    unassigned: number;
    oldestDays: number;
  };
  // How many tickets the breakdown was measured from, how many the view
  // holds, and whether the console read the view to its end.
  measured: {
    tickets: number;
    total: number | null;
    complete: boolean;
  };
  aging: QueueMetric[];
  requestTypes: QueueMetric[];
  tickets: Ticket[];
  views: Record<string, string>;
  error?: string;
};

export type Section = "overview" | "intake" | "reports" | "knowledge" | "controls";
