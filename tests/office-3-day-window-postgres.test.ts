// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

// Real local PostgreSQL (WASM), with a tiny Auth stub. No Supabase project is
// contacted. Run the actual schema and the actual migrations in production
// order (entry-visibility.sql first, office-3-day-window.sql LAST), not mock
// SQL. The owner decision under test: Office may see and work with only
// records CREATED in the last 3 calendar days (Asia/Muscat), today included;
// Admin sees everything. Acceptance example: created Mon(2), Tue(3), Wed(3),
// Thu(3), Fri(3) = 14 rows; on Friday Office sees Tue+Wed+Thu+Fri = 12.

const muscatDate = (value: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Muscat',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);

const dayShift = (isoDate: string, days: number): string =>
  new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('office 3-day window against local PostgreSQL', () => {
  it('scopes Office to the last 3 Muscat creation days while Admin sees everything', async () => {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    const schema = readFileSync('supabase/schema.sql', 'utf8');
    const visibility = readFileSync('ARENA/sql/entry-visibility.sql', 'utf8');
    const window = readFileSync('ARENA/sql/office-3-day-window.sql', 'utf8');
    const seeds = schema.match(/insert into public\.profiles \(id, email, role\)[\s\S]*?on conflict/i)?.[0] ?? '';
    const seedIds = [...seeds.matchAll(/'([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})'/gi)].map((match) => match[1]);
    expect(seedIds).toHaveLength(2);
    const admin = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const office = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const approved = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const pending = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const missing = '33333333-3333-4333-8333-333333333333';

    // Muscat calendar around "today": Mon..Fri in the acceptance example are
    // today-4 .. today. The window cutoff is today-3 (inclusive).
    const today = muscatDate(new Date());
    const d1 = dayShift(today, -1);
    const d2 = dayShift(today, -2);
    const d3 = dayShift(today, -3);
    const d4 = dayShift(today, -4);
    const stamp = (day: string, time = '12:00:00') => `${day}T${time}+04:00`;

    try {
      await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create schema auth;
        grant usage on schema auth to anon, authenticated, service_role;
        create table auth.users (id uuid primary key, email text);
        create table auth.sessions (id uuid primary key, user_id uuid);
        create table auth.refresh_tokens (id bigint primary key, session_id uuid);
        create function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
        $$;
        create function auth.jwt() returns jsonb language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
        $$;
        create publication supabase_realtime;
      `);
      for (const id of seedIds) await db.query('insert into auth.users (id) values ($1)', [id]);
      await db.exec(schema);
      // Production order: entry-visibility.sql first (it must come before),
      // office-3-day-window.sql LAST. Run the pair twice: both are idempotent
      // and the window file must stay the final word on the shared helper.
      for (let i = 0; i < 2; i += 1) {
        await db.exec(visibility);
        await db.exec(window);
      }

      // Guard: an unexpected permissive policy aborts the install atomically.
      await db.exec('create policy unexpected_entry_read on public.entries for select to authenticated using (true)');
      await expect(db.exec(window)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback; drop policy unexpected_entry_read on public.entries');

      // Guard: missing sync-fix prerequisites abort with a pointer to
      // entry-visibility.sql instead of half-installing the window.
      await db.exec('drop function public.entry_visibility(uuid)');
      await expect(db.exec(window)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback;');
      await db.exec(visibility);
      await db.exec(window);

      await db.exec(`
        insert into auth.users (id,email) values ('${admin}','admin@example.test'),('${office}','office@example.test');
        insert into public.profiles (id,email,role) values ('${admin}','admin@example.test','admin'),('${office}','office@example.test','office');
        insert into public.app_columns (id,name,type,is_primary_expiry,visible,created_by)
          values ('55555555-5555-4555-8555-555555555555','Expiry','date_expiry',true,true,'${admin}');
        insert into public.app_columns (id,name,type,is_primary_expiry,visible,created_by)
          values ('66666666-6666-4666-8666-666666666666','Passport','text',false,true,'${admin}');
        insert into public.office_signin_requests (user_id,auth_session_id,status)
          values ('${office}','${approved}','approved'),('${office}','${pending}','pending');
      `);

      // Acceptance example rows: Mon(today-4)=2 rows, Tue..Fri(today-3..today)
      // = 3 rows each. Tag them so later inserts cannot move the counts.
      const exampleRows: string[] = [];
      let n = 0;
      for (const [day, count] of [[d4, 2], [d3, 3], [d2, 3], [d1, 3], [today, 3]] as const) {
        for (let i = 0; i < count; i += 1) {
          n += 1;
          const id = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
          exampleRows.push(id);
          await db.query(
            `insert into public.entries (id,data,category,created_by,created_at,updated_at)
             values ($1, $2, 'Employee', $3, $4, $4)`,
            [id, JSON.stringify({ grp: 'example', Name: `Row ${n}`, Expiry: '2026-12-01' }), admin, stamp(day)],
          );
        }
      }
      // Muscat day boundary (23:59 vs 00:01) on the night the window rolls:
      // 23:59 on the last hidden day (today-4) is hidden; 00:01 on the first
      // visible day (today-3) is visible; 23:59 on the first visible day is
      // also visible (its Muscat date is the cutoff date).
      await db.exec(`
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('11000000-0000-4000-8000-000000000001','{"grp":"boundary","Name":"Late on the first visible day"}','${admin}','${stamp(d3, '23:59:00')}','${stamp(d3, '23:59:00')}');
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('11000000-0000-4000-8000-000000000002','{"grp":"boundary","Name":"Last hidden minute"}','${admin}','${stamp(d4, '23:59:00')}','${stamp(d4, '23:59:00')}');
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('11000000-0000-4000-8000-000000000003','{"grp":"boundary","Name":"First visible minute"}','${admin}','${stamp(d3, '00:01:00')}','${stamp(d3, '00:01:00')}');
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('12000000-0000-4000-8000-000000000001','{"grp":"renew-old","Name":"Old record","Expiry":"2026-12-01"}','${admin}','${stamp(d4)}','${stamp(d4)}');
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('12000000-0000-4000-8000-000000000002','{"grp":"renew-new","Name":"Recent record","Expiry":"2026-12-01"}','${admin}','${stamp(today)}','${stamp(today)}');
        insert into public.entries (id,data,created_by,created_at,updated_at)
          values ('13000000-0000-4000-8000-000000000001','{"grp":"column-old","Name":"Passport holder"}','${admin}','${stamp(d4)}','${stamp(d4)}');
      `);
      // The out-of-window row carries the ONLY Passport value.
      await db.query(`update public.entries set data = data || '{"Passport":"P123"}'::jsonb where id = '13000000-0000-4000-8000-000000000001'`);

      const login = async (user: string, session: string) => db.exec(`
        reset role; set role authenticated;
        select set_config('request.jwt.claim.sub','${user}',false);
        select set_config('request.jwt.claims','{\"session_id\":\"${session}\"}',false);
      `);
      const rows = async <T>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;
      const countExample = async (): Promise<number> =>
        (await rows<{ n: number }>(`select count(*)::int n from public.entries where data->>'grp' = 'example'`))[0].n;

      // ---------------- Office (approved session) ----------------
      await login(office, approved);
      // Acceptance example: Mon's 2 rows hidden; Tue..Fri (12 rows) visible.
      expect(await countExample()).toBe(12);
      // Boundary: 23:59 on the last hidden day is hidden (its Muscat date is
      // today-4); 00:01 on the first visible day (today-3) is visible.
      expect(await rows(`select id from public.entries where data->>'grp' = 'boundary' order by id`)).toEqual([
        { id: '11000000-0000-4000-8000-000000000001' },
        { id: '11000000-0000-4000-8000-000000000003' },
      ]);
      // entry_visibility classifies out-of-window as 'hidden' (the terminal
      // sync path), deleted as 'hidden', absent as 'missing'.
      expect((await rows<{ v: string }>(`select public.entry_visibility('11000000-0000-4000-8000-000000000002') v`))[0].v).toBe('hidden');
      expect((await rows<{ v: string }>(`select public.entry_visibility('11000000-0000-4000-8000-000000000001') v`))[0].v).toBe('visible');
      expect((await rows<{ v: string }>(`select public.entry_visibility('11000000-0000-4000-8000-000000000003') v`))[0].v).toBe('visible');
      expect((await rows<{ v: string }>(`select public.entry_visibility('${missing}') v`))[0].v).toBe('missing');

      // UPDATE for Office: in-window changes, out-of-window does not exist.
      expect((await db.query(`update public.entries set data='{"grp":"boundary","Name":"Edited"}' where id='11000000-0000-4000-8000-000000000003'`)).affectedRows).toBe(1);
      expect((await db.query(`update public.entries set data='{"grp":"renew-old","Name":"Edited"}' where id='12000000-0000-4000-8000-000000000001'`)).affectedRows).toBe(0);
      // Soft-delete works in-window (soft-delete marker + window) and not
      // outside it.
      expect((await db.query(`update public.entries set deleted=true,deleted_at=now(),deleted_by='${office}' where id='11000000-0000-4000-8000-000000000003'`)).affectedRows).toBe(1);
      expect((await db.query(`update public.entries set deleted=true,deleted_at=now(),deleted_by='${office}' where id='12000000-0000-4000-8000-000000000001'`)).affectedRows).toBe(0);

      // INSERT for Office carries NO window: a row created offline 4 days ago
      // still syncs, and stays out of Office view once pushed.
      expect((await db.query(`
        insert into public.entries (id,data,created_by,created_at,updated_at)
        values ('14000000-0000-4000-8000-000000000001','{"grp":"backfill","Name":"Created offline 4 days ago"}','${office}','${stamp(d4)}','${stamp(d4)}')
      `)).affectedRows).toBe(1);
      expect(await rows(`select id from public.entries where data->>'grp' = 'backfill'`)).toEqual([]);
      // Office inserts cannot set created_at in the future: clamped to now().
      expect((await db.query(`
        insert into public.entries (id,data,created_by,created_at,updated_at)
        values ('14000000-0000-4000-8000-000000000002','{"grp":"future","Name":"Future dated"}','${office}', now() + interval '2 days', now() + interval '2 days')
      `)).affectedRows).toBe(1);
      expect(await rows(`select id from public.entries where data->>'grp' = 'future'`)).toHaveLength(1); // in window after clamp

      // renew_entry uses the same predicate for Office.
      await expect(db.query(`select public.renew_entry('12000000-0000-4000-8000-000000000001', '2027-01-01')`))
        .rejects.toMatchObject({ code: '42501' });
      expect((await rows<{ id: string }>(`select public.renew_entry('12000000-0000-4000-8000-000000000002', '2027-01-01') id`))[0].id).toBeTruthy();

      // renewals SELECT: only renewals of Office-visible entries.
      expect(await rows(`select entry_id from public.renewals`)).toEqual([
        { entry_id: '12000000-0000-4000-8000-000000000002' },
      ]);

      // column_is_empty counts only entries Office can see.
      expect((await rows<{ v: boolean }>(`select public.column_is_empty('66666666-6666-4666-8666-666666666666') v`))[0].v).toBe(true);

      // ---------------- Admin (unchanged behaviour) ----------------
      await login(admin, approved);
      // Admin sees all 14 example rows, everything else included.
      expect(await countExample()).toBe(14);
      expect(await rows(`select count(*)::int n from public.entries where data->>'grp' = 'backfill'`))
        .toEqual([{ n: 1 }]);
      expect((await rows<{ v: string }>(`select public.entry_visibility('12000000-0000-4000-8000-000000000001') v`))[0].v).toBe('visible');
      // An Admin edit to Monday's record does NOT bring it back for Office.
      expect((await db.query(`update public.entries set data='{"grp":"example","Name":"Mon edited by admin","Expiry":"2026-12-01"}' where id='${exampleRows[0]}'`)).affectedRows).toBe(1);
      // Admin updates and renews out-of-window rows normally.
      expect((await db.query(`update public.entries set data='{"grp":"renew-old","Name":"Admin edited"}' where id='12000000-0000-4000-8000-000000000001'`)).affectedRows).toBe(1);
      expect((await rows<{ id: string }>(`select public.renew_entry('12000000-0000-4000-8000-000000000001', '2027-02-01') id`))[0].id).toBeTruthy();
      expect(await rows(`select entry_id from public.renewals order by entry_id`)).toEqual([
        { entry_id: '12000000-0000-4000-8000-000000000001' },
        { entry_id: '12000000-0000-4000-8000-000000000002' },
      ]);
      // Admin inserts are not clamped (behaviour unchanged).
      expect((await db.query(`
        insert into public.entries (id,data,created_by,created_at,updated_at)
        values ('14000000-0000-4000-8000-000000000003','{"grp":"admin-future","Name":"Admin future"}','${admin}', now() + interval '2 days', now() + interval '2 days')
      `)).affectedRows).toBe(1);
      expect((await rows<{ clamped: boolean }>(
        `select created_at > now() + interval '1 day' as clamped from public.entries where id='14000000-0000-4000-8000-000000000003'`,
      ))[0].clamped).toBe(true);
      // The office future insert WAS clamped to now().
      expect((await rows<{ future: boolean }>(
        `select created_at > now() + interval '1 hour' as future from public.entries where id='14000000-0000-4000-8000-000000000002'`,
      ))[0].future).toBe(false);
      // column_is_empty is unchanged for Admin (the Passport value exists).
      expect((await rows<{ v: boolean }>(`select public.column_is_empty('66666666-6666-4666-8666-666666666666') v`))[0].v).toBe(false);

      // Admin edit to Monday's row still does not bring it back for Office.
      await login(office, approved);
      expect(await countExample()).toBe(12);

      // ---------------- Pending Office session (fenced) ----------------
      await login(office, pending);
      expect(await rows('select id from public.entries')).toEqual([]);
      await expect(db.query(`select public.entry_visibility('${missing}')`)).rejects.toMatchObject({ code: '42501' });

      await db.exec('reset role');
      expect((await rows<{ n: number }>(`select count(*)::int n from dks_private.office_entry_soft_delete_context`))[0].n).toBe(0);
    } finally {
      await db.close();
    }
  });
});
