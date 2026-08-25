import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleDot,
  FileCheck2,
  Gauge,
  Inbox,
  Layers3,
  LifeBuoy,
  ListChecks,
  LockKeyhole,
  RefreshCw,
  Route,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Users,
} from "lucide-react";
import type { Overview, QueueMetric, Section } from "./types";

const navigation = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "intake", label: "Intake & routing", icon: Route },
  { id: "reports", label: "Queue reports", icon: SlidersHorizontal },
  { id: "knowledge", label: "Knowledge pipeline", icon: BookOpen },
  { id: "controls", label: "Controls", icon: ShieldCheck },
] as const;

const fallback: Overview = {
  connected: false,
  lastSynced: "",
  accountUrl: "https://gditcsucap.zendesk.com",
  metrics: { active: 0, untriaged: 0, unassigned: 0, oldestDays: 0 },
  aging: [],
  requestTypes: [],
  tickets: [],
  views: {},
};

function formatSync(value: string) {
  if (!value) return "Not connected";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function StatusPill({ tone, children }: { tone: "good" | "warn" | "risk" | "neutral"; children: React.ReactNode }) {
  return <span className={`status status-${tone}`}><CircleDot size={12} />{children}</span>;
}

function ExternalLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return <a className={`external-link ${className}`} href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={15} /></a>;
}

function MetricCard({ label, value, note, tone = "default" }: { label: string; value: number; note: string; tone?: string }) {
  return (
    <div className={`metric-card metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function BarList({ data, color = "teal" }: { data: QueueMetric[]; color?: "teal" | "blue" }) {
  const max = Math.max(1, ...data.map((item) => item.count));
  return <div className="bar-list">{data.map((item) => (
    <div className="bar-row" key={item.name}>
      <span>{item.name}</span>
      <div className="bar-track"><i className={`bar-fill bar-${color}`} style={{ width: `${(item.count / max) * 100}%` }} /></div>
      <strong>{item.count}</strong>
    </div>
  ))}</div>;
}

function OverviewPage({ data }: { data: Overview }) {
  const oldest = data.tickets[0];
  return <>
    <section className="page-heading">
      <div><p className="eyebrow">Service desk command center</p><h1>Today’s operating picture</h1><p>Live queue health, workflow readiness, and the next actions that need ownership.</p></div>
      <ExternalLink href={data.views.open || `${data.accountUrl}/agent/home/tickets`} className="primary-action">Open Zendesk queue</ExternalLink>
    </section>

    <section className="metric-grid" aria-label="Queue metrics">
      <MetricCard label="Active tickets" value={data.metrics.active} note="Conversion Services" />
      <MetricCard label="Needs triage" value={data.metrics.untriaged} note="Request type missing" tone="warn" />
      <MetricCard label="Unassigned" value={data.metrics.unassigned} note="Staffing action required" tone="risk" />
      <MetricCard label="Oldest active" value={data.metrics.oldestDays} note="Calendar days" tone="blue" />
    </section>

    <section className="alert-band">
      <AlertTriangle size={20} />
      <div><strong>Conversion Services has no assigned agent in the queue.</strong><span>{data.metrics.unassigned} active tickets are currently unassigned. Provision the designated agent before enabling email forwarding.</span></div>
      <button onClick={() => location.hash = "controls"}>Review blocker<ChevronRight size={16} /></button>
    </section>

    <div className="two-column">
      <section className="panel">
        <div className="panel-header"><div><h2>Workstream readiness</h2><p>Configuration work grouped by operational outcome.</p></div><ListChecks size={19} /></div>
        <div className="workstreams">
          {[
            ["Conversion Services intake", "Email-first form, routing, and views", "Configured", "good"],
            ["UCAP intake", "Program and product conditional workflow", "Protected", "neutral"],
            ["Help Center structure", "UCAP, Conversion Services, iCONECT, Pega", "In progress", "warn"],
            ["Slack learning", "Two HITL channels queued for synthesis", "Ready to ingest", "warn"],
            ["Explore reporting", "Aging and request-type dashboards", "Sign-in needed", "risk"],
          ].map(([name, note, status, tone]) => <div className="workstream" key={name}>
            <div><strong>{name}</strong><span>{note}</span></div><StatusPill tone={tone as "good" | "warn" | "risk" | "neutral"}>{status}</StatusPill>
          </div>)}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><div><h2>Queue aging</h2><p>Active tickets by calendar age.</p></div><ExternalLink href={data.views.aging || "#"}>View report</ExternalLink></div>
        <BarList data={data.aging} />
        {oldest && <div className="oldest-ticket"><span>Oldest ticket</span><ExternalLink href={oldest.url}>#{oldest.id} · {oldest.subject}</ExternalLink></div>}
      </section>
    </div>
  </>;
}

function IntakePage({ data }: { data: Overview }) {
  return <>
    <section className="page-heading"><div><p className="eyebrow">Intake architecture</p><h1>Programs stay distinct at entry</h1><p>Each contract gets its own brand, channel, form behavior, routing, and service commitments.</p></div></section>
    <div className="program-layout">
      <section className="program-band">
        <div className="program-title"><div className="brand-mark brand-cs">CS</div><div><p>Program / contract</p><h2>Conversion Services</h2></div><StatusPill tone="warn">Agent-only</StatusPill></div>
        <div className="definition-grid">
          <dl><dt>Primary channel</dt><dd>Email forwarding</dd></dl><dl><dt>Ticket form</dt><dd>Generic Conversion Services intake</dd></dl><dl><dt>Routing</dt><dd>Conversion Services group</dd></dl><dl><dt>SLA</dt><dd>1 business day reply · 10 business day resolution</dd></dl>
        </div>
        <div className="flow-line"><span>Email received</span><ChevronRight size={16}/><span>Untriaged</span><ChevronRight size={16}/><span>Classify request</span><ChevronRight size={16}/><span>Assign owner</span><ChevronRight size={16}/><span>Resolve</span></div>
        <ExternalLink href={data.views.untriaged || "#"}>Open untriaged queue</ExternalLink>
      </section>
      <section className="program-band protected">
        <div className="program-title"><div className="brand-mark brand-ucap">U</div><div><p>Program / contract</p><h2>UCAP</h2></div><StatusPill tone="neutral">Write protected</StatusPill></div>
        <div className="product-tree">
          <div className="tree-root"><Layers3 size={17}/><strong>UCAP</strong></div>
          <div className="tree-product"><span>iCONECT</span><small>Project · issue type · conditional identifiers</small></div>
          <div className="tree-product"><span>Pega</span><small>Application/module · issue type · conditional identifiers</small></div>
        </div>
        <div className="protection-note"><LockKeyhole size={17}/><span>Changes from this console do not modify the existing UCAP intake form.</span></div>
      </section>
    </div>
  </>;
}

function ReportsPage({ data }: { data: Overview }) {
  return <>
    <section className="page-heading"><div><p className="eyebrow">Native Zendesk reporting</p><h1>Queue reports that stay current</h1><p>Operational views update from live ticket data. Explore remains the destination for historical dashboards and scheduled delivery.</p></div></section>
    <div className="report-grid">
      <section className="panel report-panel"><div className="panel-header"><div><h2>Aging report</h2><p>Oldest active requests surface first.</p></div><ExternalLink href={data.views.aging || "#"}>Open in Zendesk</ExternalLink></div><BarList data={data.aging} color="blue" /></section>
      <section className="panel report-panel"><div className="panel-header"><div><h2>Request-type report</h2><p>Active volume grouped by classification.</p></div><ExternalLink href={data.views.requestType || "#"}>Open in Zendesk</ExternalLink></div><BarList data={data.requestTypes} /></section>
    </div>
    <section className="panel ticket-table-panel">
      <div className="panel-header"><div><h2>Oldest active tickets</h2><p>Direct inspection without leaving the workflow context.</p></div><span className="table-count">Showing {data.tickets.length}</span></div>
      <div className="table-scroll"><table><thead><tr><th>Ticket</th><th>Age</th><th>Status</th><th>Request type</th><th>System</th><th>Owner</th></tr></thead><tbody>{data.tickets.map((ticket) => <tr key={ticket.id}><td><ExternalLink href={ticket.url}>#{ticket.id} · {ticket.subject}</ExternalLink></td><td>{ticket.ageDays}d</td><td><span className="plain-status">{ticket.status}</span></td><td>{ticket.requestType}</td><td>{ticket.system}</td><td>{ticket.assigneeId ? "Assigned" : <span className="risk-text">Unassigned</span>}</td></tr>)}</tbody></table></div>
    </section>
  </>;
}

function KnowledgePage() {
  const [reviewed, setReviewed] = useState<string[]>(() => JSON.parse(localStorage.getItem("knowledge-reviewed") || "[]"));
  const toggle = (id: string) => setReviewed((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    localStorage.setItem("knowledge-reviewed", JSON.stringify(next));
    return next;
  });
  const candidates = [
    { id: "training", title: "Which HITL training guidance is current?", source: "hitl-support-helpdesk-xbp", signal: "Newer answer supersedes v1.6 guidance" },
    { id: "scope", title: "How should in-scope mapping be applied?", source: "tss-support-hitl", signal: "Recurring question across multiple threads" },
    { id: "delivery", title: "Preparing a compliant eDelivery package", source: "Training guide", signal: "Authoritative source document" },
  ];
  return <>
    <section className="page-heading"><div><p className="eyebrow">Slack-to-Help Center</p><h1>Turn support conversations into governed knowledge</h1><p>Collect evidence, resolve conflicting answers by recency and authority, review drafts, then publish to the correct product hierarchy.</p></div></section>
    <section className="pipeline" aria-label="Knowledge pipeline">
      {[["1", "Collect", "8 months from two Slack channels"], ["2", "Cluster", "Group repeated questions and accepted answers"], ["3", "Verify", "Prefer newer posts and authoritative guides"], ["4", "Review", "Human approval before publication"], ["5", "Publish", "UCAP › iCONECT › HITL"]].map(([number, title, text]) => <div className="pipeline-step" key={number}><b>{number}</b><strong>{title}</strong><span>{text}</span></div>)}
    </section>
    <div className="two-column knowledge-columns">
      <section className="panel"><div className="panel-header"><div><h2>Connected sources</h2><p>Inputs already identified for HITL knowledge.</p></div><Inbox size={19}/></div>
        <div className="source-list"><div><span className="source-icon">#</span><div><strong>hitl-support-helpdesk-xbp</strong><small>Slack · 8 months requested</small></div><StatusPill tone="good">Available</StatusPill></div><div><span className="source-icon">#</span><div><strong>tss-support-hitl</strong><small>Slack · supplementary support history</small></div><StatusPill tone="good">Available</StatusPill></div><div><span className="source-icon"><FileCheck2 size={16}/></span><div><strong>eDelivery User Training Guide</strong><small>PDF · authoritative baseline</small></div><StatusPill tone="neutral">Reference</StatusPill></div></div>
      </section>
      <section className="panel"><div className="panel-header"><div><h2>Article candidates</h2><p>Local review checklist for the next publishing pass.</p></div><Sparkles size={19}/></div>
        <div className="candidate-list">{candidates.map((candidate) => <button className={reviewed.includes(candidate.id) ? "candidate done" : "candidate"} onClick={() => toggle(candidate.id)} key={candidate.id}><span className="check-box">{reviewed.includes(candidate.id) && <Check size={14}/>}</span><span><strong>{candidate.title}</strong><small>{candidate.source} · {candidate.signal}</small></span></button>)}</div>
      </section>
    </div>
  </>;
}

function ControlsPage({ data }: { data: Overview }) {
  return <>
    <section className="page-heading"><div><p className="eyebrow">Safety and readiness</p><h1>Controls before go-live</h1><p>Make blockers explicit and keep credentials, contracts, and write boundaries separate.</p></div></section>
    <section className="control-list">
      <div className="control-row"><div className="control-icon risk"><Users size={19}/></div><div><strong>Provision Conversion Services agent</strong><span>The designated agent is not yet a member of the Conversion Services group.</span></div><StatusPill tone="risk">Blocking</StatusPill></div>
      <div className="control-row"><div className="control-icon good"><ShieldCheck size={19}/></div><div><strong>OAuth-only authentication</strong><span>Browser clients never receive the OAuth client secret or access token.</span></div><StatusPill tone="good">Enforced</StatusPill></div>
      <div className="control-row"><div className="control-icon good"><LockKeyhole size={19}/></div><div><strong>UCAP configuration protection</strong><span>The console treats the existing UCAP intake form as read-only.</span></div><StatusPill tone="good">Enforced</StatusPill></div>
      <div className="control-row"><div className="control-icon warn"><Gauge size={19}/></div><div><strong>Explore dashboards</strong><span>Native queue views exist; historical charts still require an authenticated Explore session.</span></div><StatusPill tone="warn">Pending</StatusPill></div>
      <div className="control-row"><div className="control-icon warn"><BookOpen size={19}/></div><div><strong>Knowledge publication review</strong><span>Slack-derived articles require human review before Help Center publication.</span></div><StatusPill tone="warn">Required</StatusPill></div>
    </section>
    <section className="governance-band"><div><Tags size={20}/><span><strong>Demo-data policy</strong>Exclude <code>demo_data</code> and <code>conversion_services_demo</code> from SLA performance reporting.</span></div><ExternalLink href={data.views.open || "#"}>Inspect tagged tickets</ExternalLink></section>
  </>;
}

export function App() {
  const [section, setSection] = useState<Section>(() => (location.hash.slice(1) as Section) || "overview");
  const [data, setData] = useState<Overview>(fallback);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/overview");
      const payload = await response.json();
      setData(payload.connected ? payload : { ...fallback, error: payload.error });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const handler = () => setSection((location.hash.slice(1) as Section) || "overview");
    window.addEventListener("hashchange", handler); return () => window.removeEventListener("hashchange", handler);
  }, []);
  const visibleNav = useMemo(() => navigation.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), [query]);

  const go = (id: Section) => { location.hash = id; setSection(id); };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="product-lockup"><div className="logo">SO</div><div><strong>Service Operations</strong><span>Zendesk back office</span></div></div>
      <label className="nav-search"><Search size={16}/><input aria-label="Filter navigation" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find workflow" /></label>
      <nav>{visibleNav.map((item) => <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => go(item.id)}><item.icon size={18}/><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-footer"><div className={`connection-dot ${data.connected ? "online" : "offline"}`} /><div><strong>{data.connected ? "Zendesk connected" : "Zendesk unavailable"}</strong><span>{data.connected ? `Synced ${formatSync(data.lastSynced)}` : data.error || "Check OAuth configuration"}</span></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="mobile-brand"><div className="logo">SO</div><strong>Service Operations</strong></div><div className="topbar-context"><LifeBuoy size={17}/><span>GDIT service desk</span><i>/</i><strong>{navigation.find((item) => item.id === section)?.label}</strong></div><button className="icon-button" title="Refresh live Zendesk data" aria-label="Refresh live Zendesk data" onClick={load} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""}/></button></header>
      <div className="mobile-nav">{navigation.map((item) => <button aria-label={item.label} className={section === item.id ? "active" : ""} onClick={() => go(item.id)} key={item.id}><item.icon size={18}/></button>)}</div>
      <div className="page-content">
        {section === "overview" && <OverviewPage data={data}/>} {section === "intake" && <IntakePage data={data}/>} {section === "reports" && <ReportsPage data={data}/>} {section === "knowledge" && <KnowledgePage/>} {section === "controls" && <ControlsPage data={data}/>} 
      </div>
    </main>
  </div>;
}
