/**
 * report-error — Server-side automated diagnostic reporter to GitHub Issues.
 *
 * Security & privacy boundary:
 *  - Accepts ONLY authenticated, approved DKS sessions (verified against
 *    PostgreSQL via `verify_error_report_caller`).
 *  - Enforces a strict 4 KiB request limit and fixed allowlisted non-PII fields.
 *  - Holds `GITHUB_ERROR_REPORT_TOKEN` strictly in Edge Function secrets —
 *    NEVER in desktop client code, `.env`, or git.
 *
 * Required Edge Function environment secrets:
 *  - SUPABASE_URL              (auto-injected by Supabase)
 *  - SUPABASE_ANON_KEY         (auto-injected by Supabase)
 *  - SUPABASE_SERVICE_ROLE_KEY (auto-injected by Supabase)
 *  - GITHUB_ERROR_REPORT_TOKEN (fine-grained PAT or GitHub App token scoped to
 *                               repository Issues: Read & Write ONLY)
 *  - GITHUB_ERROR_REPORT_REPO  (e.g. `tacenta2k/dks`)
 */

import {
  type ErrorReportWorkerEnv,
  handleErrorReportRequest,
} from '../_shared/error-report.ts';

function readWorkerEnv(): ErrorReportWorkerEnv | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim();
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')?.trim();
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return null;
  }
  return {
    supabaseUrl,
    supabaseAnonKey,
    serviceRoleKey,
    githubToken: Deno.env.get('GITHUB_ERROR_REPORT_TOKEN')?.trim() ?? null,
    githubRepo: Deno.env.get('GITHUB_ERROR_REPORT_REPO')?.trim() || 'tacenta2k/dks',
  };
}

Deno.serve((request: Request) =>
  handleErrorReportRequest(request, {
    env: readWorkerEnv(),
  }));
