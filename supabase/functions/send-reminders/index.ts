// Supabase Edge Function "send-reminders".
// Called every minute by pg_cron (see supabase/setup.sql). Finds event reminders, event starts and alarm clocks
// that are due and sends a Web Push notification to the phones that turned notifications on.
// Also answers { test: true, endpoint } from a signed-in user with a test notification.
// Turn OFF "Verify JWT" for this function: the cron call is checked with x-cron-secret instead.

const TZ = 'Asia/Jerusalem';
const WINDOW = 10 * 60e3; // still send if the cron was late by up to 10 minutes
const SITE = 'https://aroniko11.github.io/mutual-calendar/';

// ---------- dates (all calendar dates are Israel local dates, 'YYYY-MM-DD') ----------
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const weekday = (s: string) => parse(s).getUTCDay();
const mins = (t?: string) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function local(ts: number) {
  const p: Record<string, string> = {};
  for (const x of tzFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// Israel local date + 'HH:MM' → epoch ms
export function at(date: string, time = '00:00'): number {
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let ts = want;
  for (let i = 0; i < 3; i++) {
    const l = local(ts), [ly, lm, ld] = l.date.split('-').map(Number), [lh, lmi] = l.time.split(':').map(Number);
    const diff = Date.UTC(ly, lm - 1, ld, lh, lmi) - want;
    if (!diff) break;
    ts -= diff;
  }
  return ts;
}

// ---------- event model (same rules as the app) ----------
type Ev = Record<string, any>;
function norm(e: Ev): Ev {
  const allDay = e.allDay ?? !e.time;
  return { type: 'general', repeat: 'none', noYear: false, status: 'active', reminders: [], startSound: 'none', days: [], repeatUntil: '',
           location: '', ...e, allDay, time: allDay ? '' : (e.time || '') };
}
function occDates(e: Ev, from: string, to: string): string[] {
  const out: string[] = [];
  if (e.repeat === 'none' || !e.repeat) { if (e.date >= from && e.date <= to) out.push(e.date); return out; }
  if (e.repeatUntil && e.repeatUntil < to) to = e.repeatUntil;
  const o = parse(e.date), start = (e.repeat === 'yearly' && e.noYear) ? from : (e.date > from ? e.date : from);
  if (start > to) return out;
  if (e.repeat === 'daily' || e.repeat === 'weekdays') {
    const ds = e.repeat === 'weekdays' ? (e.days || []) : [0, 1, 2, 3, 4, 5, 6];
    for (let d = start; d <= to; d = addDays(d, 1)) if (ds.includes(weekday(d))) out.push(d);
  } else if (e.repeat === 'weekly') {
    const diff = Math.round((parse(start).getTime() - o.getTime()) / 864e5), k = Math.ceil(Math.max(0, diff) / 7);
    for (let d = addDays(e.date, k * 7); d <= to; d = addDays(d, 7)) out.push(d);
  } else if (e.repeat === 'monthly') {
    const s = parse(start), end = parse(to);
    for (let y = s.getUTCFullYear(), m = s.getUTCMonth(); Date.UTC(y, m, 1) <= end.getTime(); m++) {
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); if (o.getUTCDate() > dim) continue;
      const d = iso(new Date(Date.UTC(y, m, o.getUTCDate()))); if (d >= start && d <= to) out.push(d);
    }
  } else if (e.repeat === 'yearly') {
    for (let y = parse(start).getUTCFullYear(); y <= parse(to).getUTCFullYear(); y++) {
      let day = o.getUTCDate(); if (o.getUTCMonth() === 1 && day === 29 && new Date(Date.UTC(y, 1, 29)).getUTCMonth() !== 1) day = 28;
      const d = iso(new Date(Date.UTC(y, o.getUTCMonth(), day))); if (d >= start && d <= to) out.push(d);
    }
  }
  return out;
}

const TYPE_ICON: Record<string, string> = { general: '📌', show: '🎤', theater: '🎭', birthday: '🎂', anniversary: '💍', doctor: '🩺',
  family: '👨‍👩‍👧', meal: '🍽️', work: '💼', trip: '✈️', sport: '🏃', holiday: '🕯️', reminder: '⏰', walk: '🚶', pilates: '🧘', meds: '💊' };
const OWNER_TAG: Record<string, string> = { aharon: 'אהרון', tzipi: 'ציפי', both: 'משותף' };
const relMin = (m: number) => m <= 0 ? 'עכשיו' : m < 60 ? `בעוד ${m} דקות` : m < 1440 ? `בעוד ${Math.round(m / 60) === 1 ? 'שעה' : Math.round(m / 60) + ' שעות'}`
  : `בעוד ${Math.round(m / 1440) === 1 ? 'יום' : Math.round(m / 1440) + ' ימים'}`;
const dayWord = (date: string, today: string) => date === today ? 'היום' : date === addDays(today, 1) ? 'מחר' : `ב־${Number(date.slice(8))}.${Number(date.slice(5, 7))}`;

export type Note = { key: string; to: 'owner' | 'clock'; owner: string; title: string; body: string; url: string; disableAlarm?: string };

// everything that became due in (now - WINDOW, now]
export function dueNotes(events: Ev[], alarms: Ev[], now: number): Note[] {
  const out: Note[] = [], today = local(now).date;
  for (const raw of events) {
    const e = norm(raw);
    if (e.status === 'cancelled' || !e.title || !e.date) continue;
    for (const d of occDates(e, addDays(today, -1), addDays(today, 8))) {
      const start = at(d, e.allDay ? '09:00' : e.time);
      const url = `${SITE}?e=${encodeURIComponent(e.id)}&d=${d}`;
      const what = `${TYPE_ICON[e.type] || '📌'} ${e.title}`;
      const when = `${dayWord(d, today)}${e.allDay ? '' : ' ב־' + e.time}${e.location ? ' · ' + e.location : ''} · ${OWNER_TAG[e.owner] || ''}`;
      (e.reminders || []).forEach((r: Ev, i: number) => {
        let ts: number;
        if (r.kind === 'at') {
          if (!r.at) return;
          const [rd, rt] = String(r.at).split('T');
          const shift = e.repeat !== 'none' ? Math.round((parse(d).getTime() - parse(e.date).getTime()) / 864e5) : 0;
          ts = at(addDays(rd, shift), rt || '00:00');
        } else ts = start - (Number(r.min) || 0) * 60e3;
        if (ts <= now && now - ts < WINDOW) {
          const m = Math.round((start - now) / 60e3);
          out.push({ key: `${e.id}|${d}|r${i}`, to: 'owner', owner: e.owner, url,
            title: m <= 0 ? `⏰ מתחיל עכשיו: ${what}` : `⏰ ${what} · ${relMin(m)}`, body: when });
        }
      });
      if (e.startSound && e.startSound !== 'none' && start <= now && now - start < WINDOW) {
        out.push({ key: `${e.id}|${d}|s`, to: 'owner', owner: e.owner, url, title: `🔔 מתחיל עכשיו: ${what}`, body: when });
      }
    }
  }
  const wd = weekday(today);
  for (const a of alarms) {
    if (!a.time) continue;
    const url = `${SITE}?alarm=${encodeURIComponent(a.id)}`;
    const title = `⏰ ${a.time} · ${a.label || 'שעון מעורר'}`;
    if (a.enabled && (!a.days || !a.days.length || a.days.includes(wd))) {
      const due = at(today, a.time);
      if (due <= now && now - due < WINDOW && (a.updatedAt ? Date.parse(a.updatedAt) < due : true)) {
        out.push({ key: `al|${a.id}|${today}|${a.time}`, to: 'clock', owner: a.owner, url, title, body: 'הגיע הזמן! פתחו את היומן לנודניק.',
          disableAlarm: !a.days || !a.days.length ? a.id : undefined });
      }
    }
    if (a.snoozeUntil) {
      const ts = Date.parse(a.snoozeUntil);
      if (ts <= now && now - ts < WINDOW) out.push({ key: `sn|${a.id}|${a.snoozeUntil}`, to: 'clock', owner: a.owner, url, title: `😴 ${title}`, body: 'הנודניק נגמר.' });
    }
  }
  return out;
}

// ---------- "the other one changed the calendar" ----------
const OWNERS: Record<string, string> = { aharon: 'אהרון', tzipi: 'ציפי' };
const fmtDay = new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
export type Change = { id: number; event_id: string; kind: string; user_id: string | null; data: Ev };
export function changeNote(c: Change) {
  const e = norm(c.data || {});
  const who = OWNERS[e.updatedBy] || OWNERS[e.addedBy] || '';
  const what = `${TYPE_ICON[e.type] || '📌'} ${e.title || 'אירוע'}`;
  const head = { insert: '➕ אירוע חדש', update: '✏️ עדכון ביומן', cancel: '🚫 אירוע בוטל', delete: '🗑️ אירוע נמחק' }[c.kind] || '✏️ עדכון ביומן';
  const when = e.date ? `${fmtDay.format(parse(e.date))}${e.allDay ? '' : ' ב־' + e.time}` : '';
  const cal = c.kind === 'insert' ? 'new' : c.kind === 'update' ? 'edit' : 'gone';
  return {
    title: `${head}${who ? ' מ' + who : ''}: ${what}`,
    body: [when, OWNER_TAG[e.owner], c.kind === 'insert' || c.kind === 'update' ? 'לחצו כדי להוסיף ליומן באייפון' : ''].filter(Boolean).join(' · '),
    url: c.kind === 'delete' ? SITE : `${SITE}?e=${encodeURIComponent(c.event_id)}&d=${e.date}&cal=${cal}`,
  };
}
// the person (aharon/tzipi) of a change, for phones whose sign-in is unknown
const changer = (c: Change) => { const e = c.data || {}; return e.updatedBy || (c.kind === 'insert' ? e.addedBy : '') || ''; };
export function wantsChange(sub: { person?: string | null; alerts?: string; user_id?: string | null; notify_changes?: boolean }, c: Change) {
  if (sub.notify_changes === false || sub.alerts === 'off') return false;
  if (sub.user_id && c.user_id) return sub.user_id !== c.user_id;
  const p = changer(c);
  return !p || !sub.person || sub.person !== p;
}

// ---------- .ics file for the iPhone calendar ----------
const icsEsc = (s: string) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const enc = new TextEncoder();
const fold = (line: string) => { // lines of at most 75 bytes, never splitting a character
  const out: string[] = []; let cur = '', n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > 73) { out.push(cur); cur = ' '; n = 1; }
    cur += ch; n += b;
  }
  out.push(cur); return out.join('\r\n');
};
const ymd = (s: string) => s.replace(/-/g, '');
const utcStamp = (ts: number) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const dur = (m: number) => `${m < 0 ? '-' : ''}PT${Math.abs(m)}M`;
export function ics(raw: Ev): string {
  const e = norm(raw);
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mutual-calendar//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Jerusalem',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:IDT', 'DTSTART:19700327T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=23,24,25,26,27,28,29;BYDAY=FR', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:IST', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE', 'BEGIN:VEVENT', `UID:${e.id}@mutual-calendar`, `DTSTAMP:${utcStamp(Date.now())}`,
    `SUMMARY:${icsEsc(`${TYPE_ICON[e.type] || '📌'} ${e.title}`)}`];
  if (e.allDay) L.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.date, 1))}`);
  else {
    const s = mins(e.time)!, en = mins(e.endTime) != null && mins(e.endTime)! > s ? mins(e.endTime)! : s + 60;
    const endDate = en >= 1440 ? addDays(e.date, 1) : e.date, em = en % 1440;
    L.push(`DTSTART;TZID=Asia/Jerusalem:${ymd(e.date)}T${e.time.replace(':', '')}00`,
           `DTEND;TZID=Asia/Jerusalem:${ymd(endDate)}T${pad(Math.floor(em / 60))}${pad(em % 60)}00`);
  }
  const BY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const rr = ({ daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY',
    weekdays: `FREQ=WEEKLY;BYDAY=${(e.days || []).map((d: number) => BY[d]).join(',')}` } as Record<string, string>)[e.repeat];
  if (rr) L.push(`RRULE:${rr}${e.repeatUntil && e.repeat !== 'yearly' ? `;UNTIL=${ymd(e.repeatUntil)}${e.allDay ? '' : 'T235959Z'}` : ''}`);
  if (e.location) L.push(`LOCATION:${icsEsc(e.location)}`);
  L.push(`DESCRIPTION:${icsEsc([`${OWNER_TAG[e.owner] || ''} · מהיומן של ציפי ואהרון`, e.notes].filter(Boolean).join('\n'))}`);
  if (e.status === 'cancelled') L.push('STATUS:CANCELLED');
  for (const r of e.reminders || []) {
    let trig: string;
    if (r.kind === 'at') { if (!r.at) continue; const [d, t] = String(r.at).split('T'); trig = `TRIGGER;VALUE=DATE-TIME:${utcStamp(at(d, t || '00:00'))}`; }
    else trig = `TRIGGER:${dur((e.allDay ? 540 : 0) - (Number(r.min) || 0))}`; // all-day: counted from 09:00, like the app
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(e.title)}`, trig, 'END:VALARM');
  }
  L.push('END:VEVENT', 'END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

// which phones get a note: same rules as the in-app alerts
export function wants(sub: { person?: string | null; alerts?: string }, n: Note) {
  if (n.to === 'clock') return !sub.person || sub.person === n.owner;
  if (sub.alerts === 'off') return false;
  return sub.alerts === 'all' || !sub.person || n.owner === 'both' || n.owner === sub.person;
}

// ---------- server ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// @ts-ignore Deno global (absent when the pure functions above are tested in Node)
if (typeof Deno !== 'undefined') Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  // @ts-ignore
  const env = (k: string) => Deno.env.get(k);
  const { createClient } = await import('npm:@supabase/supabase-js@2.105.0');
  const webpush = (await import('npm:web-push@3.6.7')).default;
  let serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) { try { serviceKey = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}').default; } catch { /* ignore */ } }
  const db = createClient(env('SUPABASE_URL')!, serviceKey!, { auth: { persistSession: false } });

  // secrets: the cron secret comes from setup.sql, the push key pair is created here once
  const { data: rows } = await db.from('app_secret').select('key,value');
  const sec: Record<string, string> = Object.fromEntries((rows || []).map((r: any) => [r.key, r.value]));
  if (!sec.vapid_public || !sec.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    await db.from('app_secret').upsert([{ key: 'vapid_public', value: k.publicKey }, { key: 'vapid_private', value: k.privateKey }], { onConflict: 'key', ignoreDuplicates: true });
    const { data: again } = await db.from('app_secret').select('key,value').in('key', ['vapid_public', 'vapid_private']);
    for (const r of again || []) sec[r.key] = r.value;
  }
  webpush.setVapidDetails(SITE, sec.vapid_public, sec.vapid_private);

  const push = async (s: any, n: { title: string; body: string; url: string; tag?: string }) => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag }), { TTL: 3600, urgency: 'high' });
      return true;
    } catch (err: any) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) await db.from('push_subs').delete().eq('endpoint', s.endpoint);
      console.error('push failed', err && err.statusCode, err && err.body);
      return false;
    }
  };

  // the iPhone calendar file of one event: GET ?ics=<id>&t=<signed token from the ics_token() database function>
  const q = new URL(req.url).searchParams;
  if (req.method === 'GET' && q.get('ics')) {
    const id = q.get('ics')!;
    if (!sec.cron_secret || q.get('t') !== await hmacHex(sec.cron_secret, id)) return new Response('not found', { status: 404, headers: CORS });
    const { data: row } = await db.from('events').select('id,data').eq('id', id).maybeSingle();
    if (!row) return new Response('האירוע לא נמצא', { status: 404, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(ics({ ...row.data, id: row.id }), { headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="event.ics"', 'Cache-Control': 'no-store' } });
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // test notification for the signed-in user's own phone
  if (body && body.test) {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const { data: u } = await db.auth.getUser(token);
    if (!u || !u.user) return json({ error: 'not signed in' }, 401);
    const { data: s } = await db.from('push_subs').select('*').eq('endpoint', body.endpoint).maybeSingle();
    if (!s) return json({ error: 'no subscription' }, 404);
    const ok = await push(s, { title: '🔔 בדיקה מהיומן שלנו', body: 'ההתראות עובדות בטלפון הזה.', url: SITE, tag: 'test' });
    return json({ ok });
  }

  if (!sec.cron_secret || req.headers.get('x-cron-secret') !== sec.cron_secret) return json({ error: 'forbidden' }, 403);

  // tell the other phone about added / edited / cancelled / deleted events (latest change per event)
  const { data: changes } = await db.from('event_changes').select('*').eq('sent', false).order('id').limit(200);
  let changed = 0;
  if (changes && changes.length) {
    await db.from('event_changes').update({ sent: true }).in('id', changes.map((c: any) => c.id));
    const last = new Map<string, Change>();
    for (const c of changes as Change[]) last.set(`${c.event_id}|${c.user_id}`, c);
    const { data: subs } = await db.from('push_subs').select('*');
    for (const c of last.values()) {
      const n = changeNote(c);
      for (const s of subs || []) if (wantsChange(s, c) && await push(s, { ...n, tag: `ch|${c.event_id}` })) changed++;
    }
  }

  const now = Date.now();
  const [{ data: ev }, { data: al }] = await Promise.all([
    db.from('events').select('id,data').limit(5000),
    db.from('alarms').select('id,data').limit(1000),
  ]);
  const notes = dueNotes((ev || []).map((r: any) => ({ ...r.data, id: r.id })), (al || []).map((r: any) => ({ ...r.data, id: r.id })), now);
  if (!notes.length) return json({ sent: 0, changed });

  // claim each note once, so a late or doubled cron run never sends it twice
  const { data: claimed } = await db.from('push_sent').upsert(notes.map(n => ({ key: n.key })), { onConflict: 'key', ignoreDuplicates: true }).select('key');
  const mine = new Set((claimed || []).map((r: any) => r.key));
  const todo = notes.filter(n => mine.has(n.key));
  if (!todo.length) return json({ sent: 0, changed });

  const { data: subs } = await db.from('push_subs').select('*');
  let sent = 0;
  for (const n of todo) {
    for (const s of subs || []) if (wants(s, n) && await push(s, { ...n, tag: n.key })) sent++;
    if (n.disableAlarm) {
      const row = (al || []).find((r: any) => r.id === n.disableAlarm);
      if (row) await db.from('alarms').update({ data: { ...row.data, enabled: false }, updated_at: new Date().toISOString() }).eq('id', row.id);
    }
  }
  return json({ sent, notes: todo.length, changed });
});
