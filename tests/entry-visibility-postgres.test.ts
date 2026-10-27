// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

// Real local PostgreSQL (WASM), with a tiny Auth stub. No Supabase project is
// contacted. Run the actual schema and both actual migrations, not mock SQL.
describe('entry visibility against local PostgreSQL', () => {
  it('preserves RLS while Office updates and soft-deletes without RETURNING', async () => {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    const schema = readFileSync('supabase/schema.sql', 'utf8');
    const visibility = readFileSync('ARENA/sql/entry-visibility.sql', 'utf8');
    const realtime = readFileSync('ARENA/sql/realtime-office-approval.sql', 'utf8');
    const seeds = schema.match(/insert into public\.profiles \(id, email, role\)[\s\S]*?on conflict/i)?.[0] ?? '';
    const seedIds = [...seeds.matchAll(/'([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})'/gi)].map((match) => match[1]);
    expect(seedIds).toHaveLength(2);
    const admin = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const office = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const approved = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const pending = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const active = '11111111-1111-4111-8111-111111111111';
    const deleted = '22222222-2222-4222-8222-222222222222';
    const missing = '33333333-3333-4333-8333-333333333333';
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
      // Permissive policies are OR-ed: the manual scripts must refuse an
      // unexpected broad rule, not silently claim the new policy protects it.
      await db.exec('create policy unexpected_entry_read on public.entries for select to authenticated using (true)');
      await expect(db.exec(visibility)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback; drop policy unexpected_entry_read on public.entries');
      await db.exec('create policy unexpected_request_read on public.office_signin_requests for select to authenticated using (true)');
      await expect(db.exec(realtime)).rejects.toMatchObject({ code: '42501' });
      await db.exec('rollback; drop policy unexpected_request_read on public.office_signin_requests');
      // Exercise manual migration idempotency after a fresh schema install.
      for (let i = 0; i < 2; i += 1) { await db.exec(visibility); await db.exec(realtime); }
      await db.exec(`
        insert into auth.users (id,email) values ('${admin}','admin@example.test'),('${office}','office@example.test');
        insert into public.profiles (id,email,role) values ('${admin}','admin@example.test','admin'),('${office}','office@example.test','office');
        insert into public.entries (id,data,created_by) values ('${active}','{"name":"A"}','${admin}');
        insert into public.entries (id,data,created_by,deleted,deleted_at,deleted_by)
          values ('${deleted}','{"name":"B"}','${admin}',true,now(),'${admin}');
        insert into public.office_signin_requests (user_id,auth_session_id,status)
          values ('${office}','${approved}','approved'),('${office}','${pending}','pending');
      `);
      const login = async (user: string, session: string) => db.exec(`
        reset role; set role authenticated;
        select set_config('request.jwt.claim.sub','${user}',false);
        select set_config('request.jwt.claims','{"session_id":"${session}"}',false);
      `);
      const rows = async <T>(sql: string): Promise<T[]> => (await db.query<T>(sql)).rows;

      await login(office, approved);
      expect(await rows(`select id from public.entries order by id`)).toEqual([{ id: active }]);
      expect((await rows<{ v: string }>(`select public.entry_visibility('${active}') v`))[0].v).toBe('visible');
      expect((await rows<{ v: string }>(`select public.entry_visibility('${deleted}') v`))[0].v).toBe('hidden');
      expect((await rows<{ v: string }>(`select public.entry_visibility('${missing}') v`))[0].v).toBe('missing');
      expect(await rows('select status from public.office_signin_requests')).toEqual([{ status: 'approved' }]);
      expect((await db.query(`update public.entries set data='{"name":"C"}' where id='${active}'`)).affectedRows).toBe(1);
      expect((await db.query(`update public.entries set data='{"name":"D"}' where id='${deleted}'`)).affectedRows).toBe(0);
      await expect(db.query('select * from dks_private.office_entry_soft_delete_context')).rejects.toMatchObject({ code: '42501' });
      // Forged user-settable configuration cannot make an old hidden row visible.
      await db.exec(`select set_config('dks.office_soft_delete_id','${deleted}',false)`);
      expect(await rows(`select id from public.entries where id='${deleted}'`)).toEqual([]);

      // This WHERE id update used to fail RLS despite having no RETURNING.
      expect((await db.query(`update public.entries set deleted=true,deleted_at=now(),deleted_by='${office}' where id='${active}'`)).affectedRows).toBe(1);
      expect((await rows<{ v: string }>(`select public.entry_visibility('${active}') v`))[0].v).toBe('hidden');
      expect(await rows('select id from public.entries')).toEqual([]);
      expect((await db.query(`update public.entries set deleted=false,deleted_at=null,deleted_by=null where id='${active}'`)).affectedRows).toBe(0);

      await login(office, pending);
      expect(await rows('select status from public.office_signin_requests')).toEqual([{ status: 'pending' }]);
      expect(await rows('select id from public.entries')).toEqual([]);
      expect((await db.query(`update public.entries set data='{}' where id='${active}'`)).affectedRows).toBe(0);
      await expect(db.query(`select public.entry_visibility('${missing}')`)).rejects.toMatchObject({ code: '42501' });

      await login(admin, approved);
      expect(await rows('select id from public.entries order by id')).toEqual([{ id: active }, { id: deleted }]);
      expect((await rows<{ v: string }>(`select public.entry_visibility('${deleted}') v`))[0].v).toBe('visible');
      // The nested audit trigger continues to run for both the entry and its
      // generated admin notification, without dereferencing deleted on a
      // different table type.
      expect((await rows<{ n: number }>(`select count(*)::int n from public.admin_notifications where type='delete' and entry_id='${active}'`))[0].n).toBe(1);
      await db.exec('reset role; set role anon');
      expect((await rows<{ v: boolean }>("select has_function_privilege('anon','public.entry_visibility(uuid)','execute') v"))[0].v).toBe(false);
      await db.exec('reset role');
      expect((await rows<{ n: number }>("select count(*)::int n from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='office_signin_requests'"))[0].n).toBe(1);
      expect((await rows<{ n: number }>('select count(*)::int n from dks_private.office_entry_soft_delete_context'))[0].n).toBe(0);
    } finally {
      await db.close();
    }
  });
});
