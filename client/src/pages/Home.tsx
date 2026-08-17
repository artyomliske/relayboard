import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const statuses = ["received", "processing", "completed", "failed", "pending_approval"] as const;
type Status = (typeof statuses)[number];
type Filter = Status | "all";
type DemoSource = "form_submission" | "payment" | "telegram_message" | "downstream_api_failure";

const statusStyle: Record<Status, string> = {
  received: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  processing: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  completed: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  failed: "border-rose-300/25 bg-rose-300/10 text-rose-200",
  pending_approval: "border-violet-300/25 bg-violet-300/10 text-violet-200",
};

const sourceLabels: Record<DemoSource, string> = {
  form_submission: "Form submission",
  payment: "Payment",
  telegram_message: "Telegram message",
  downstream_api_failure: "Downstream API failure",
};

function StatusBadge({ status }: { status: Status }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono-ui text-[11px] ${statusStyle[status]}`}>{status}</span>;
}

function readableTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value));
}

function EventPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [comment, setComment] = useState("");
  const [streamConnected, setStreamConnected] = useState(false);
  const utils = trpc.useUtils();
  const eventsInput = useMemo(() => (filter === "all" ? undefined : { status: filter }), [filter]);
  const selectedInput = useMemo(() => ({ eventId: selectedId ?? "00000000-0000-0000-0000-000000000000" }), [selectedId]);
  const metrics = trpc.relayboard.metrics.useQuery();
  const events = trpc.relayboard.events.useQuery(eventsInput);
  const detail = trpc.relayboard.event.useQuery(selectedInput, { enabled: Boolean(selectedId) });

  const refresh = useCallback(async () => {
    await Promise.all([utils.relayboard.metrics.invalidate(), utils.relayboard.events.invalidate(), utils.relayboard.event.invalidate()]);
  }, [utils]);
  useEffect(() => {
    const stream = new EventSource("/api/events/stream");
    const sync = () => void refresh();
    stream.onopen = () => setStreamConnected(true);
    stream.onerror = () => setStreamConnected(false);
    stream.addEventListener("relayboard", sync);
    return () => stream.close();
  }, [refresh]);
  const generateDemo = trpc.relayboard.generateDemo.useMutation({
    onSuccess: async result => {
      setSelectedId(result.event.id);
      await refresh();
      toast.success("Synthetic event added to the inbox");
    },
    onError: error => toast.error(error.message),
  });
  const replay = trpc.relayboard.replay.useMutation({
    onSuccess: async result => {
      setSelectedId(result?.event.id ?? null);
      await refresh();
      toast.success("Event replay created with a new correlation ID");
    },
    onError: error => toast.error(error.message),
  });
  const approval = trpc.relayboard.decideApproval.useMutation({
    onSuccess: async () => {
      setApprovalOpen(false);
      setComment("");
      await refresh();
      toast.success(`Event ${decision}`);
    },
    onError: error => toast.error(error.message),
  });

  const selected = detail.data?.event;
  const auditItems = detail.data?.audit ?? [];
  const pendingApproval = selected?.status === "pending_approval";
  const canReplay = selected?.status === "completed" || selected?.status === "failed";

  const openApproval = (nextDecision: "approved" | "rejected") => {
    setDecision(nextDecision);
    setComment("");
    setApprovalOpen(true);
  };
  const copyPayload = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(JSON.stringify(selected.maskedPayload, null, 2));
    toast.success("Masked payload copied");
  };

  return (
    <div className="surface-grid min-h-[calc(100vh-2rem)] rounded-[28px] border border-white/[0.06] bg-[radial-gradient(circle_at_90%_0%,oklch(0.34_0.09_188_/_18%),transparent_27%),linear-gradient(145deg,oklch(0.18_0.018_260_/_95%),oklch(0.15_0.012_260_/_98%))] p-4 sm:p-6">
      <header className="mb-7 flex flex-col justify-between gap-5 border-b border-white/[0.08] pb-6 lg:flex-row lg:items-end">
        <div>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-emerald-200/70">
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_0_4px_rgba(110,231,183,0.12)]" />
            Webhook control plane
          </div>
          <h1 className="text-3xl font-semibold tracking-[-0.045em] text-white sm:text-4xl">Everything in motion. Nothing out of sight.</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Trace each event from verified ingress to a final, operator-controlled outcome.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400"><ShieldCheck className="h-4 w-4 text-emerald-300" /><span className={`h-1.5 w-1.5 rounded-full ${streamConnected ? "bg-emerald-300" : "bg-slate-500"}`} />{streamConnected ? "live event stream" : "reconnecting live stream"} · HMAC verified</div>
      </header>

      <section className="mb-7 grid grid-cols-2 gap-3 xl:grid-cols-6">
        <Metric label="All events" value={metrics.data?.total ?? 0} icon={<Activity />} accent="text-white" />
        {statuses.map(status => <Metric key={status} label={status} value={metrics.data?.[status] ?? 0} icon={<span className={`h-2 w-2 rounded-full ${status === "completed" ? "bg-emerald-300" : status === "failed" ? "bg-rose-300" : status === "pending_approval" ? "bg-violet-300" : status === "processing" ? "bg-amber-300" : "bg-sky-300"}`} />} accent="text-slate-100" />)}
      </section>

      <section className="mb-7 rounded-2xl border border-white/[0.09] bg-slate-950/30 p-4 shadow-2xl shadow-slate-950/20">
        <div className="mb-3 flex items-center gap-2"><Radio className="h-4 w-4 text-emerald-300" /><h2 className="text-sm font-semibold text-white">Synthetic demo event generator</h2></div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(sourceLabels) as DemoSource[]).map(source => (
            <Button key={source} variant="outline" disabled={generateDemo.isPending} onClick={() => generateDemo.mutate({ source })} className="h-auto justify-between border-white/[0.10] bg-white/[0.035] px-3 py-3 text-left text-slate-200 hover:border-emerald-300/35 hover:bg-emerald-300/[0.07] hover:text-white">
              <span className="text-sm font-medium">{sourceLabels[source]}</span><Play className="h-3.5 w-3.5 text-emerald-300" />
            </Button>
          ))}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.9fr)]">
        <div className="overflow-hidden rounded-2xl border border-white/[0.09] bg-slate-950/35">
          <div className="flex flex-col gap-4 border-b border-white/[0.08] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-semibold text-white">Event inbox</p><p className="mt-1 text-xs text-slate-400">Live feed · selected events remain inspectable</p></div>
            <Button variant="ghost" size="sm" onClick={refresh} className="self-start text-slate-300 hover:bg-white/[0.07] hover:text-white"><RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh</Button>
          </div>
          <div className="flex gap-1 overflow-x-auto border-b border-white/[0.08] px-3 py-2">
            {(["all", ...statuses] as Filter[]).map(status => <button key={status} onClick={() => setFilter(status)} className={`shrink-0 rounded-lg px-3 py-1.5 font-mono-ui text-[11px] transition-colors ${filter === status ? "bg-white/[0.11] text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"}`}>{status}</button>)}
          </div>
          <div className="max-h-[560px] overflow-auto">
            {events.isLoading ? <div className="flex min-h-48 items-center justify-center text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading event inbox</div> : events.data?.length ? events.data.map(event => (
              <button key={event.id} onClick={() => setSelectedId(event.id)} className={`group grid w-full grid-cols-[1fr_auto] gap-3 border-b border-white/[0.06] px-4 py-4 text-left transition-colors hover:bg-white/[0.045] ${selectedId === event.id ? "bg-emerald-300/[0.075]" : ""}`}>
                <div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate text-sm font-medium text-slate-100">{sourceLabels[event.source as DemoSource]}</span>{event.isDeadLetter ? <span className="rounded border border-rose-300/25 bg-rose-300/10 px-1.5 py-0.5 font-mono-ui text-[10px] text-rose-200">dead-letter queue</span> : null}</div><div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400"><span className="font-mono-ui">{event.correlationId.slice(0, 14)}…</span><span>·</span><span>{readableTime(event.receivedAt)}</span></div></div>
                <div className="flex items-center gap-2"><StatusBadge status={event.status as Status} /><ChevronRight className="h-4 w-4 text-slate-500 transition-transform group-hover:translate-x-0.5" /></div>
              </button>
            )) : <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center"><Activity className="mb-3 h-5 w-5 text-slate-500" /><p className="text-sm font-medium text-slate-300">No events in this view</p><p className="mt-1 text-xs text-slate-500">Use the demo generator to create one of the four synthetic event types.</p></div>}
          </div>
        </div>

        <aside className="min-h-[320px] overflow-hidden rounded-2xl border border-white/[0.09] bg-slate-950/35 xl:min-h-[500px]">
          {!selectedId || detail.isLoading ? <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-8 text-center xl:min-h-[500px]"><CircleAlert className="mb-4 h-6 w-6 text-slate-500" /><p className="text-sm font-medium text-slate-300">Select an event for deep inspection</p><p className="mt-2 text-xs leading-5 text-slate-500">The detail view contains masked payload data and the complete audit timeline.</p></div> : selected ? <div>
            <div className="border-b border-white/[0.08] px-5 py-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{sourceLabels[selected.source as DemoSource]}</p><p className="mt-1 font-mono-ui text-[11px] text-slate-500">{selected.correlationId}</p></div><StatusBadge status={selected.status as Status} /></div><div className="mt-4 flex flex-wrap gap-2">{pendingApproval ? <><Button size="sm" onClick={() => openApproval("approved")} className="bg-emerald-300 text-emerald-950 hover:bg-emerald-200"><Check className="mr-1.5 h-3.5 w-3.5" />Approve</Button><Button size="sm" variant="outline" onClick={() => openApproval("rejected")} className="border-rose-300/25 bg-rose-300/5 text-rose-200 hover:bg-rose-300/15 hover:text-rose-100"><X className="mr-1.5 h-3.5 w-3.5" />Reject</Button></> : null}{canReplay ? <Button size="sm" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate({ eventId: selected.id })} className="border-white/[0.12] bg-white/[0.04] text-slate-200 hover:bg-white/[0.1] hover:text-white"><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Replay</Button> : null}</div></div>
            <div className="space-y-5 p-5"><div><div className="mb-2 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Masked payload</p><button onClick={copyPayload} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"><Copy className="h-3.5 w-3.5" />Copy</button></div><pre className="max-h-44 overflow-auto rounded-xl border border-white/[0.07] bg-slate-950/60 p-3 font-mono-ui text-[11px] leading-5 text-slate-300">{JSON.stringify(selected.maskedPayload, null, 2)}</pre></div>
              <div className="grid grid-cols-2 gap-2"><KeyValue label="Attempts" value={`${selected.retryCount}/${selected.maxRetries}`} /><KeyValue label="Queue" value={selected.isDeadLetter ? "dead-letter queue" : "event inbox"} /></div>
              <div><div className="mb-3 flex items-center gap-2"><Clock3 className="h-3.5 w-3.5 text-emerald-300" /><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Audit timeline</p></div><div className="space-y-3 border-l border-white/[0.12] pl-4">{auditItems.map(record => <div key={record.id} className="relative"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full border border-slate-900 bg-emerald-300" /><p className="font-mono-ui text-[10px] text-slate-500">{readableTime(record.createdAt)} · {record.action}</p><p className="mt-1 text-xs leading-5 text-slate-300">{record.message}</p></div>)}</div></div>
            </div>
          </div> : <div className="p-5 text-sm text-slate-400">This event is no longer available.</div>}
        </aside>
      </section>

      <Dialog open={approvalOpen} onOpenChange={setApprovalOpen}><DialogContent className="border-white/[0.12] bg-slate-950 text-slate-100 sm:max-w-md"><DialogHeader><DialogTitle>{decision === "approved" ? "Approve event" : "Reject event"}</DialogTitle><DialogDescription className="text-slate-400">A written operator comment is required and will be preserved in the audit timeline.</DialogDescription></DialogHeader><Textarea autoFocus value={comment} onChange={event => setComment(event.target.value)} placeholder="Write the operator decision context…" className="min-h-28 border-white/[0.12] bg-white/[0.04] text-slate-100 placeholder:text-slate-600" /><DialogFooter><Button variant="ghost" onClick={() => setApprovalOpen(false)} className="text-slate-300 hover:bg-white/[0.08] hover:text-white">Cancel</Button><Button disabled={!comment.trim() || approval.isPending} onClick={() => selectedId && approval.mutate({ eventId: selectedId, decision, comment: comment.trim() })} className={decision === "approved" ? "bg-emerald-300 text-emerald-950 hover:bg-emerald-200" : "bg-rose-400 text-rose-950 hover:bg-rose-300"}>{approval.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{decision === "approved" ? "Approve" : "Reject"}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}

function Metric({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent: string }) {
  return <div className="rounded-xl border border-white/[0.08] bg-slate-950/35 px-3.5 py-3"><div className="flex items-center justify-between"><span className="font-mono-ui text-[10px] text-slate-500">{label}</span><span className="text-slate-500">{icon}</span></div><p className={`mt-2 text-2xl font-semibold tracking-[-0.04em] ${accent}`}>{value}</p></div>;
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3"><p className="font-mono-ui text-[10px] text-slate-500">{label}</p><p className="mt-1 text-xs font-medium text-slate-200">{value}</p></div>;
}

export default function Home() {
  return <DashboardLayout><EventPanel /></DashboardLayout>;
}
