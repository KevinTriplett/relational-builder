import { useAuthStore } from '@/store/auth-store';
import { useChatStore } from '@/store/chat-store';
import { useProjectStore } from '@/store/project-store';
import { BUILD_DAY_FRAME, BUILD_DAY_CARD_SLUG } from '@/knowledge/build-day';

/**
 * A note to humans@relationaltechproject.org when a community build day is
 * being planned in the Builder — the moment an organizer approves the plan
 * for its first build. RTP's stewards mint the event code and set up the
 * day-of tools by hand, so the earlier they hear, the better.
 *
 * Carries what the plan's Event brief says (place, date, size, entry point,
 * what is being made) and the locality on the builder's profile, if any.
 * No name, no email, no chat. Fire-and-forget; a failure never touches the
 * build.
 *
 * Identification is stricter than the gathering-fund cheer, which fired on
 * two projects that were not gathering funds: a frame sensed from a loose
 * phrase was enough there. Here all three must hold — the frame is in
 * lineage, the project came through the build day door (the featured card
 * or an ask that names a build day), and the approved plan carries the
 * Event brief the scripted conversation writes. A plan without the brief is
 * a conversation that drifted, not a build day.
 */
const FUNCTIONS_URL = `${import.meta.env.VITE_BUILDER_SUPABASE_URL ?? ''}/functions/v1`;

const PROJECT_NAME_RE = /^\s*`?PROJECT-NAME:\s*([^`\n]+?)`?\s*$/im;
const EVENT_BRIEF_RE = /^(?:#{2,4}\s+|\*\*)event brief\b/im;

export interface BuildDayBrief {
  projectName: string | null;
  convenedBy: string | null;
  where: string | null;
  when: string | null;
  format: string | null;
  expectedSize: string | null;
  entryPoint: string | null;
  rhythm: string | null;
  rsvp: string | null;
  eventCode: string | null;
  makingNow: string | null;
}

/** One bold-labelled line of the Event brief: `- **Where:** the hall` */
function briefLine(planText: string, label: string): string | null {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?\\*\\*${label}:?\\*\\*:?\\s*(.+?)\\s*$`, 'im');
  const v = re.exec(planText)?.[1]?.trim();
  return v ? v.replace(/\s+/g, ' ') : null;
}

export function hasEventBrief(planText: string): boolean {
  return EVENT_BRIEF_RE.test(planText);
}

/** Reads the drafted plan's Event brief — the lines the stewards need */
export function readBuildDayBrief(planText: string): BuildDayBrief {
  return {
    projectName: PROJECT_NAME_RE.exec(planText)?.[1]?.trim() ?? null,
    convenedBy: briefLine(planText, 'Convened by'),
    where: briefLine(planText, 'Where'),
    when: briefLine(planText, 'When'),
    format: briefLine(planText, 'Format'),
    expectedSize: briefLine(planText, 'Expected size'),
    entryPoint: briefLine(planText, 'Entry point'),
    rhythm: briefLine(planText, 'Rhythm'),
    rsvp: briefLine(planText, 'RSVP'),
    eventCode: briefLine(planText, 'Event code \\(suggested\\)') ?? briefLine(planText, 'Event code'),
    makingNow: briefLine(planText, 'Making now'),
  };
}

/**
 * Did this project come through the build day door? The featured card
 * stamps its slug into lineage; an ask that names a build day stamps the
 * frame on the turn it is sensed. Either way the frame must be in lineage.
 */
export function isBuildDayProject(): boolean {
  const lineage = useProjectStore.getState().lineage;
  return (lineage?.frames ?? []).includes(BUILD_DAY_FRAME.slug);
}

/** Called when the Build button turns a from-scratch plan into its first build */
export function noticeBuildDayPlan(): void {
  if (!import.meta.env.VITE_BUILDER_SUPABASE_URL) return;
  if (!isBuildDayProject()) return;
  if (useProjectStore.getState().getFileCount() > 0) return;

  const messages = useChatStore.getState().messages;
  const plan = [...messages]
    .reverse()
    .find(m => m.role === 'assistant' && m.isPlan && PROJECT_NAME_RE.test(m.content) && hasEventBrief(m.content));
  if (!plan) return;

  const brief = readBuildDayBrief(plan.content);
  const profile = useAuthStore.getState().profile;
  const lineage = useProjectStore.getState().lineage;

  void fetch(`${FUNCTIONS_URL}/build-day-notice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...brief,
      locality: profile?.neighborhood ?? null,
      source: lineage?.promptSlug === BUILD_DAY_CARD_SLUG ? 'gallery card' : (lineage?.promptTitle ?? 'the ask itself'),
    }),
    keepalive: true,
  }).catch(() => undefined);
}
